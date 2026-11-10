//! The API's log, `%APPDATA%\Pezhohesh\api.log`: every line has its local time with offset,
//! level, source and, inside a request, the request's id. Requests that fail or are slow are
//! logged with their error code; ordinary ones only at debug. Bodies and query strings are
//! never logged (they hold names, phones and passwords). Files roll over by size, so a
//! problem is still there days later: api.log, then api.1.log … api.4.log (5 MB each).

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use axum::extract::{MatchedPath, Request};
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use axum::Json;
use serde::Deserialize;
use tracing::Instrument;
use tracing_subscriber::fmt::time::ChronoLocal;
use tracing_subscriber::fmt::writer::MakeWriterExt;

const MAX_BYTES: u64 = 5_000_000;
const KEEP: u32 = 4;
/// A request slower than this is worth a line even when it worked.
const SLOW_MS: u128 = 3000;

/// Default levels: our own code at info; what SQLx repeats on every slow network trip is left
/// out, because the request's own line says which one was slow. RUST_LOG overrides this.
const FILTER: &str = "info,sqlx::query=error,sqlx::pool::acquire=error,sqlx_postgres::options=error,tower_http=off";

struct Rolling {
    path: PathBuf,
    file: File,
    size: u64,
}

impl Rolling {
    fn open(path: PathBuf) -> io::Result<Self> {
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let size = file.metadata()?.len();
        Ok(Rolling { path, file, size })
    }

    fn numbered(&self, n: u32) -> PathBuf {
        self.path.with_file_name(format!("api.{n}.log"))
    }

    fn roll(&mut self) -> io::Result<()> {
        for n in (1..KEEP).rev() {
            let _ = fs::rename(self.numbered(n), self.numbered(n + 1));
        }
        // Windows will not rename an open file, so this handle is swapped out first.
        let spare = self.path.with_file_name("api.rolling.tmp");
        self.file = OpenOptions::new().create(true).append(true).open(&spare)?;
        let _ = fs::rename(&self.path, self.numbered(1));
        self.file = OpenOptions::new().create(true).append(true).open(&self.path)?;
        let _ = fs::remove_file(spare);
        self.size = 0;
        Ok(())
    }
}

impl Write for Rolling {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.size + buf.len() as u64 > MAX_BYTES {
            let _ = self.roll();
        }
        let n = self.file.write(buf)?;
        self.size += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

fn log_path() -> Option<PathBuf> {
    let dir = std::path::Path::new(&std::env::var("APPDATA").ok()?).join("Pezhohesh");
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("api.log"))
}

/// Starts the log, and sends a panic there too with where it happened.
pub fn init() {
    let filter = std::env::var("RUST_LOG").unwrap_or_else(|_| FILTER.into());
    let logs = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_timer(ChronoLocal::rfc_3339())
        .with_ansi(false);
    match log_path().and_then(|p| Rolling::open(p).ok()) {
        Some(file) => logs.with_writer(io::stderr.and(Mutex::new(file))).init(),
        None => logs.init(),
    }
    std::panic::set_hook(Box::new(|info| {
        let place = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        tracing::error!(target: "panic", "{place}: {info}");
    }));
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// One request: an id on every line it logs and on its answer (x-request-id, which the app
/// sends back when it reports an error), and a line of its own when it failed or was slow.
pub async fn requests(req: Request, next: Next) -> Response {
    let id = format!("{:x}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
    let method = req.method().clone();
    // The route, not the path: no member ids in the summary line, and never the query.
    let route = req.extensions().get::<MatchedPath>().map_or_else(|| req.uri().path().to_string(), |p| p.as_str().to_string());
    let span = tracing::info_span!("req", id = %id);
    let began = Instant::now();
    let mut res = next.run(req).instrument(span.clone()).await;
    let _in = span.enter();
    let ms = began.elapsed().as_millis();
    let status = res.status();
    let code = res.extensions().get::<crate::auth::ErrorCode>().map_or("", |c| c.0);
    if status.is_server_error() {
        tracing::error!("{method} {route} -> {} {code} in {ms} ms", status.as_u16());
    } else if status.is_client_error() && status != StatusCode::UNAUTHORIZED {
        tracing::warn!("{method} {route} -> {} {code} in {ms} ms", status.as_u16());
    } else if ms > SLOW_MS {
        tracing::warn!("{method} {route} slow: {} in {ms} ms", status.as_u16());
    } else {
        tracing::debug!("{method} {route} -> {} in {ms} ms", status.as_u16());
    }
    if let Ok(v) = HeaderValue::from_str(&id) {
        res.headers_mut().insert("x-request-id", v);
    }
    res
}

#[derive(Deserialize)]
pub struct ClientLog {
    /// error | warn | info
    level: String,
    /// Where in the app: the page, or "window" for an uncaught error.
    place: String,
    message: String,
    stack: Option<String>,
    request_id: Option<String>,
}

fn short(s: &str, max: usize) -> String {
    s.chars().take(max).map(|c| if c == '\n' { '|' } else { c }).collect()
}

/// POST /api/v1/client-log: an error in the app's screens, so the one log tells the whole
/// story. The API listens on this computer only.
pub async fn client_log(Json(b): Json<ClientLog>) -> StatusCode {
    let place = short(&b.place, 80);
    let message = short(&b.message, 600);
    let stack = short(b.stack.as_deref().unwrap_or(""), 1500);
    let req = short(b.request_id.as_deref().unwrap_or(""), 20);
    match b.level.as_str() {
        "error" => tracing::error!(target: "app", "{place}: {message} [req {req}] {stack}"),
        "warn" => tracing::warn!(target: "app", "{place}: {message} [req {req}]"),
        _ => tracing::info!(target: "app", "{place}: {message}"),
    }
    StatusCode::NO_CONTENT
}
