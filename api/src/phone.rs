//! Members send their photo and tazkira from their own phone. A QR code on the laptop opens
//! a small page served on the office network (or the laptop's own Wi-Fi hotspot) on its own
//! port, with no internet and no sign-in: it can only send files, never read anything. What
//! arrives waits in `document_inbox` until the desk puts it on the right member's file.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::{begin_as, ApiError, CurrentUser};
use crate::documents::{self, Stored};
use crate::hall::hall_only;
use crate::AppState;

/// The port of the phone page. The main API stays on 127.0.0.1 and is never on the network.
pub const PORT: u16 = 8760;
/// Windows Mobile Hotspot always gives the laptop this address on its own Wi-Fi.
const HOTSPOT_IP: &str = "192.168.137.1";
/// Sends one phone may make in ten minutes (three files a member, a few members).
const SENDS_PER_WINDOW: u32 = 30;
const WINDOW: Duration = Duration::from_secs(600);

static SENDS: Mutex<Option<HashMap<IpAddr, (Instant, u32)>>> = Mutex::new(None);

fn allowed(ip: IpAddr) -> bool {
    let mut map = SENDS.lock().unwrap();
    let map = map.get_or_insert_with(HashMap::new);
    let now = Instant::now();
    map.retain(|_, (start, _)| now.duration_since(*start) < WINDOW);
    let entry = map.entry(ip).or_insert((now, 0));
    entry.1 += 1;
    entry.1 <= SENDS_PER_WINDOW
}

#[derive(Serialize, Deserialize, Clone, Copy)]
struct Setting {
    enabled: bool,
}

async fn enabled(db: &sqlx::PgPool) -> bool {
    let v: Option<serde_json::Value> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'phone_upload'").fetch_optional(db).await.ok().flatten();
    v.and_then(|v| serde_json::from_value::<Setting>(v).ok()).is_none_or(|s| s.enabled)
}

/// Runs the phone page on every network of this laptop. A failure (the port is taken) only
/// turns the phone page off; the app itself goes on.
pub async fn serve(state: AppState) {
    let bind: SocketAddr = std::env::var("PHONE_BIND")
        .ok()
        .and_then(|b| b.parse().ok())
        .unwrap_or_else(|| SocketAddr::from(([0, 0, 0, 0], PORT)));
    let app = Router::new()
        .route("/", get(page))
        .route("/send", post(send))
        .layer(DefaultBodyLimit::max(documents::MAX_BYTES + 1024))
        .with_state(state);
    match tokio::net::TcpListener::bind(bind).await {
        Ok(listener) => {
            tracing::info!("phone page listening on {bind}");
            if let Err(e) = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await {
                tracing::error!("phone page stopped: {e}");
            }
        }
        Err(e) => tracing::error!("phone page could not listen on {bind}: {e}"),
    }
}

async fn page(State(s): State<AppState>) -> Html<String> {
    let open = s.ready() && enabled(&s.db).await;
    Html(include_str!("phone.html").replace("__OPEN__", if open { "true" } else { "false" }))
}

#[derive(Deserialize)]
struct SendQuery {
    kind: String,
    member_no: Option<String>,
    phone: Option<String>,
}

fn digits(s: &Option<String>, max: usize) -> Option<String> {
    let d: String = s.as_deref().unwrap_or("").chars().filter(char::is_ascii_digit).take(max).collect();
    Some(d).filter(|d| !d.is_empty())
}

async fn send(
    State(s): State<AppState>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    Query(q): Query<SendQuery>,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    if !s.ready() {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "starting"));
    }
    if !enabled(&s.db).await {
        return Err(ApiError(StatusCode::FORBIDDEN, "closed"));
    }
    if !allowed(from.ip()) {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    }
    if !matches!(q.kind.as_str(), "photo" | "tazkira_front" | "tazkira_back") {
        return Err(ApiError::bad("bad_kind"));
    }
    let member_no = digits(&q.member_no, 9).and_then(|n| n.parse::<i32>().ok());
    let phone = digits(&q.phone, 15);
    if member_no.is_none() && phone.is_none() {
        return Err(ApiError::bad("who_required"));
    }
    let f = documents::store_upload(&q.kind, &body).await?;
    sqlx::query(
        "INSERT INTO document_inbox (member_no, phone, kind, file_path, sha256, mime_type, size_bytes, from_ip) \
         VALUES ($1, $2, $3::doc_kind, $4, $5, $6, $7, $8)",
    )
    .bind(member_no)
    .bind(&phone)
    .bind(&q.kind)
    .bind(&f.rel)
    .bind(&f.sha)
    .bind(f.mime)
    .bind(f.size)
    .bind(from.ip().to_string())
    .execute(&s.db)
    .await?;
    tracing::info!("phone page: {} from {}", q.kind, from.ip());
    Ok(StatusCode::CREATED)
}

// ---------------------------------------------------------------------------
// The desk: «رسیده‌ها»

#[derive(Serialize, FromRow)]
pub struct Arrived {
    id: Uuid,
    received_at: chrono::DateTime<chrono::Utc>,
    member_no: Option<i32>,
    phone: Option<String>,
    kind: String,
    mime_type: String,
    size_bytes: i32,
    /// The member with the typed number, if there is one.
    member_id: Option<Uuid>,
    member_name: Option<String>,
    member_phone: Option<String>,
    /// The typed phone ends like the member's phone on file.
    phone_matches: bool,
    /// Not on the number: the member whose phone on file is the typed one.
    by_phone_id: Option<Uuid>,
    by_phone_name: Option<String>,
    by_phone_no: Option<i32>,
}

/// GET /api/v1/inbox: what is waiting, oldest first.
pub async fn inbox(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Vec<Arrived>>, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    // Phones are compared on their last 9 digits: 0700 123 456 and +93 700 123 456 are one number.
    let rows = sqlx::query_as(
        "SELECT i.id, i.received_at, i.member_no, i.phone, i.kind::text AS kind, i.mime_type, i.size_bytes, \
                m.id AS member_id, trim(m.first_name || ' ' || COALESCE(m.last_name, '')) AS member_name, m.phone AS member_phone, \
                (i.phone IS NOT NULL AND m.phone IS NOT NULL AND right(regexp_replace(m.phone, '\\D', '', 'g'), 9) = right(i.phone, 9)) AS phone_matches, \
                p.id AS by_phone_id, trim(p.first_name || ' ' || COALESCE(p.last_name, '')) AS by_phone_name, p.member_no AS by_phone_no \
         FROM document_inbox i \
         LEFT JOIN members m ON m.member_no = i.member_no AND m.deleted_at IS NULL \
         LEFT JOIN LATERAL ( \
             SELECT x.id, x.first_name, x.last_name, x.member_no FROM members x \
             WHERE m.id IS NULL AND i.phone IS NOT NULL AND length(i.phone) >= 9 AND x.deleted_at IS NULL \
               AND right(regexp_replace(x.phone, '\\D', '', 'g'), 9) = right(i.phone, 9) \
             ORDER BY x.created_at DESC LIMIT 1 \
         ) p ON true \
         WHERE i.status = 'pending' ORDER BY i.received_at",
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(rows))
}

/// GET /api/v1/inbox/count: for the number next to «رسیده‌ها» in the menu.
pub async fn count(State(s): State<AppState>, user: CurrentUser) -> Result<Json<i64>, ApiError> {
    if !user.sees_hall() {
        return Ok(Json(0));
    }
    let mut tx = begin_as(&s.db, &user).await?;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM document_inbox WHERE status = 'pending'").fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(n))
}

/// GET /api/v1/inbox/:id/file
pub async fn file(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>) -> Result<Response, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let row: Option<(String, String)> = sqlx::query_as("SELECT file_path, mime_type FROM document_inbox WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    tx.commit().await?;
    let (rel, mime) = row.ok_or(ApiError(StatusCode::NOT_FOUND, "not_found"))?;
    let bytes = documents::read_file(&rel).await?;
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, mime.parse().map_err(|_| ApiError(StatusCode::NOT_FOUND, "not_found"))?);
    Ok((headers, bytes).into_response())
}

#[derive(Deserialize)]
pub struct Accept {
    member_id: Uuid,
    /// The desk may correct what it is (a tazkira sent as the photo).
    kind: Option<String>,
}

/// POST /api/v1/inbox/:id/accept: puts the file on the member's record.
pub async fn accept(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>, Json(b): Json<Accept>) -> Result<StatusCode, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let row: Option<(String, String, String, String, i32)> = sqlx::query_as(
        "SELECT kind::text, file_path, sha256, mime_type, size_bytes FROM document_inbox WHERE id = $1 AND status = 'pending' FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let (sent_kind, rel, sha, mime, size) = row.ok_or(ApiError(StatusCode::NOT_FOUND, "not_found"))?;
    let kind = b.kind.unwrap_or(sent_kind);
    if !documents::kind_ok(&kind) || (kind == "photo" && mime == "application/pdf") {
        return Err(ApiError::bad("bad_doc_kind"));
    }
    let mime: &'static str = match mime.as_str() {
        "image/jpeg" => "image/jpeg",
        "image/png" => "image/png",
        "image/webp" => "image/webp",
        "application/pdf" => "application/pdf",
        _ => return Err(ApiError::bad("bad_file_type")),
    };
    let doc = documents::attach(&mut tx, b.member_id, &kind, &Stored { rel, sha, mime, size }, user.id).await?;
    sqlx::query("UPDATE document_inbox SET status = 'accepted', member_id = $2, document_id = $3, handled_by = $4, handled_at = now() WHERE id = $1")
        .bind(id)
        .bind(b.member_id)
        .bind(doc)
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/v1/inbox/:id/reject: not used (a wrong or unreadable picture). It stays in the log.
pub async fn reject(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>) -> Result<StatusCode, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let done = sqlx::query("UPDATE document_inbox SET status = 'rejected', handled_by = $2, handled_at = now() WHERE id = $1 AND status = 'pending'")
        .bind(id)
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError(StatusCode::NOT_FOUND, "not_found"));
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Where the phone page is, and the QR codes for the sticker

#[derive(Serialize)]
pub struct Address {
    url: String,
    /// The laptop's own hotspot: the same address every time, so a printed QR keeps working.
    hotspot: bool,
}

#[derive(Serialize)]
pub struct Status {
    enabled: bool,
    port: u16,
    addresses: Vec<Address>,
    hotspot_url: String,
}

/// The laptop's IPv4 addresses on its networks (not loopback, not "no network" 169.254.x.x).
fn addresses() -> Vec<Address> {
    let mut list: Vec<Address> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|i| match i.ip() {
            IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() => Some(v4.to_string()),
            _ => None,
        })
        .map(|ip| Address { hotspot: ip == HOTSPOT_IP, url: format!("http://{ip}:{PORT}/") })
        .collect();
    list.sort_by_key(|a| !a.hotspot);
    list.dedup_by(|a, b| a.url == b.url);
    list
}

/// GET /api/v1/phone-upload
pub async fn status(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Status>, ApiError> {
    hall_only(&user)?;
    let addresses = tokio::task::spawn_blocking(addresses).await.unwrap_or_default();
    Ok(Json(Status { enabled: enabled(&s.db).await, port: PORT, addresses, hotspot_url: format!("http://{HOTSPOT_IP}:{PORT}/") }))
}

#[derive(Deserialize)]
pub struct SetStatus {
    enabled: bool,
}

/// PUT /api/v1/phone-upload (partners): open or close the phone page.
pub async fn set_status(State(s): State<AppState>, user: CurrentUser, Json(b): Json<SetStatus>) -> Result<StatusCode, ApiError> {
    if !user.is_partner() {
        return Err(ApiError::FORBIDDEN);
    }
    let mut tx = begin_as(&s.db, &user).await?;
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ('phone_upload', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    )
    .bind(serde_json::to_value(Setting { enabled: b.enabled }).unwrap_or_default())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct QrText {
    text: String,
}

/// GET /api/v1/qr?text=…: a QR code as SVG, for the sticker on the laptop (a web address, or
/// the hotspot's Wi-Fi name and password so a phone joins it by scanning).
pub async fn qr(user: CurrentUser, Query(q): Query<QrText>) -> Result<Response, ApiError> {
    hall_only(&user)?;
    if q.text.is_empty() || q.text.len() > 500 {
        return Err(ApiError::bad("bad_text"));
    }
    let code = qrcode::QrCode::new(q.text.as_bytes()).map_err(|_| ApiError::bad("bad_text"))?;
    let svg = code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(240, 240)
        .quiet_zone(true)
        .dark_color(qrcode::render::svg::Color("#000000"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .build();
    Ok(([(header::CONTENT_TYPE, "image/svg+xml")], svg).into_response())
}
