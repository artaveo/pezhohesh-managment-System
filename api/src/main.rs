//! Pezhohesh core API.
//!
//! Every client (desktop now, mobile later) talks to this API; nothing talks to the
//! database directly. The same binary runs on the office laptop against the local
//! PostgreSQL, and in the cloud against Neon.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use serde::Serialize;
use serde_json::json;
use sqlx::migrate::MigrateDatabase;
use sqlx::postgres::{PgPool, PgPoolOptions};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing_subscriber::fmt::writer::MakeWriterExt;

mod access;
mod audit;
mod auth;
mod backup;
mod books;
mod dashboard;
mod documents;
mod hall;
mod hotspot;
mod import_excel;
mod lists;
mod money;
mod online;
mod people;
mod phone;
mod registrations;
mod reports;
mod restore;
mod salaries;
mod solar;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    core: Arc<RwLock<Core>>,
}

impl AppState {
    /// The database is there and its tables are up to date.
    pub fn ready(&self) -> bool {
        self.core.read().unwrap().ready
    }
    /// Every request waits with this reason (a restore is replacing the database).
    pub fn pause(&self, problem: &'static str) {
        *self.core.write().unwrap() = Core { ready: false, problem: Some(problem), detail: None };
    }
    pub fn resume(&self) {
        *self.core.write().unwrap() = Core { ready: true, ..Default::default() };
    }
}

/// Where getting the database ready stands. Until it is ready, /health says why and every
/// other route answers 503 with the same reason, so the app can tell the person what to do.
#[derive(Clone, Default, Serialize)]
struct Core {
    ready: bool,
    /// postgres_down, db_login, migration or db_error.
    problem: Option<&'static str>,
    detail: Option<String>,
}

#[derive(Serialize)]
struct Health {
    status: &'static str,
    database: bool,
    problem: Option<&'static str>,
    detail: Option<String>,
    version: &'static str,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let logs = tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()))
        .with_ansi(false);
    match log_file() {
        Some(file) => logs.with_writer(std::io::stderr.and(Mutex::new(file))).init(),
        None => logs.init(),
    }
    let result = run().await;
    if let Err(e) = &result {
        tracing::error!("stopped: {e:#}");
    }
    result
}

async fn run() -> anyhow::Result<()> {
    let database_url = database_url();
    let bind: SocketAddr = std::env::var("API_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8750".into())
        .parse()?;

    // The API answers right away even when PostgreSQL is not running yet (after a restart,
    // or when its service was stopped); it keeps trying in the background and starts
    // serving as soon as the database is there, so the app never needs restarting for it.
    let db = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(5))
        .connect_lazy(&database_url)?;
    let core = Arc::new(RwLock::new(Core { problem: Some("starting"), ..Default::default() }));
    tokio::spawn(prepare_database(database_url, db.clone(), core.clone()));

    let state = AppState { db, core };
    tokio::spawn(phone::serve(state.clone()));
    let app = router(state);
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!("pezhohesh-api {} listening on {bind}", env!("CARGO_PKG_VERSION"));
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

/// `%APPDATA%\\Pezhohesh\\api.log`, started over once it passes 1 MB.
fn log_file() -> Option<std::fs::File> {
    let dir = std::path::Path::new(&std::env::var("APPDATA").ok()?).join("Pezhohesh");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("api.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > 1_000_000) {
        let _ = std::fs::remove_file(&path);
    }
    std::fs::OpenOptions::new().create(true).append(true).open(path).ok()
}

async fn prepare_database(url: String, db: PgPool, core: Arc<RwLock<Core>>) {
    let mut last = String::new();
    loop {
        match prepare_once(&url, &db).await {
            Ok(()) => {
                *core.write().unwrap() = Core { ready: true, ..Default::default() };
                tracing::info!("database ready");
                tokio::spawn(backup::schedule(db.clone(), url.clone()));
                tokio::spawn(salaries::schedule(db.clone()));
                tokio::spawn(online::schedule(db, url));
                return;
            }
            Err(e) => {
                let detail = format!("{e:#}");
                if detail != last {
                    tracing::error!("database not ready: {detail}");
                    last.clone_from(&detail);
                }
                *core.write().unwrap() = Core { ready: false, problem: Some(problem_of(&e)), detail: Some(detail) };
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn prepare_once(url: &str, db: &PgPool) -> anyhow::Result<()> {
    // First run on a fresh PostgreSQL: create the database itself, then the tables.
    if !sqlx::Postgres::database_exists(url).await? {
        sqlx::Postgres::create_database(url).await?;
        tracing::info!("created database");
    }
    let migrator = sqlx::migrate!("../db/migrations");
    repair_crlf_checksums(db, &migrator).await?;
    migrator.run(db).await?;
    Ok(())
}

fn problem_of(e: &anyhow::Error) -> &'static str {
    if e.downcast_ref::<sqlx::migrate::MigrateError>().is_some() {
        return "migration";
    }
    match e.downcast_ref::<sqlx::Error>() {
        Some(e) if auth::is_unreachable(e) => "postgres_down",
        // invalid_password, invalid_authorization_specification
        Some(sqlx::Error::Database(d)) if matches!(d.code().as_deref(), Some("28P01" | "28000")) => "db_login",
        _ => "db_error",
    }
}

/// Every route but /health waits for the database (CORS sits outside, so the app can read the answer).
async fn wait_for_database(State(s): State<AppState>, req: Request, next: Next) -> Response {
    let core = s.core.read().unwrap().clone();
    if core.ready || req.uri().path() == "/health" {
        return next.run(req).await;
    }
    let body = json!({ "error": core.problem.unwrap_or("starting"), "detail": core.detail });
    (StatusCode::SERVICE_UNAVAILABLE, Json(body)).into_response()
}

/// Databases first set up from a Windows checkout recorded the checksums of the migration
/// files with CRLF line endings, and sqlx then refuses to start ("migration 1 was previously
/// applied but has been modified"). The SQL is identical, so record the shipped checksum.
async fn repair_crlf_checksums(db: &PgPool, migrator: &sqlx::migrate::Migrator) -> anyhow::Result<()> {
    use sha2::{Digest, Sha384};
    let exists: bool = sqlx::query_scalar("SELECT to_regclass('_sqlx_migrations') IS NOT NULL").fetch_one(db).await?;
    if !exists {
        return Ok(());
    }
    let applied: Vec<(i64, Vec<u8>)> = sqlx::query_as("SELECT version, checksum FROM _sqlx_migrations").fetch_all(db).await?;
    for m in migrator.iter() {
        let Some((_, recorded)) = applied.iter().find(|(v, _)| *v == m.version) else { continue };
        if recorded.as_slice() == &*m.checksum {
            continue;
        }
        let crlf = Sha384::digest(m.sql.replace("\r\n", "\n").replace('\n', "\r\n").as_bytes());
        if recorded.as_slice() == crlf.as_slice() {
            sqlx::query("UPDATE _sqlx_migrations SET checksum = $2 WHERE version = $1")
                .bind(m.version)
                .bind(&*m.checksum)
                .execute(db)
                .await?;
            tracing::warn!(version = m.version, "migration checksum had been recorded with CRLF line endings; updated");
        }
    }
    Ok(())
}

fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/v1/settings/brand-color", get(brand_color))
        .route("/api/v1/setup", get(auth::setup_status).post(auth::setup))
        .route("/api/v1/auth/login", post(auth::login))
        .route("/api/v1/auth/logout", post(auth::logout))
        .route("/api/v1/me", get(auth::me))
        .route("/api/v1/me/password", put(auth::change_password))
        .route("/api/v1/me/theme", put(auth::set_theme))
        .route("/api/v1/users", get(auth::list_users).post(auth::create_user))
        .route("/api/v1/users/:id", put(auth::update_user))
        .route("/api/v1/role-access", get(access::get).put(access::set))
        .route("/api/v1/people", get(people::list))
        .route("/api/v1/people/merge", post(people::merge))
        .route("/api/v1/me/theme-mode", put(auth::set_theme_mode))
        .route("/api/v1/dashboard", get(dashboard::get))
        .route(
            "/api/v1/import/excel",
            post(import_excel::import).layer(axum::extract::DefaultBodyLimit::max(30 * 1024 * 1024)),
        )
        .route("/api/v1/reports/periods", get(reports::periods))
        .route("/api/v1/month-summaries", get(audit::summaries))
        .route("/api/v1/month-summaries/:id", put(audit::update_summary))
        .route("/api/v1/audit", get(audit::list))
        .route("/api/v1/members", get(lists::members).post(hall::create_member))
        .route("/api/v1/members/next-no", get(hall::next_member_no))
        .route("/api/v1/members/:id", get(hall::member).put(hall::update_member).delete(hall::delete_member))
        .route("/api/v1/members/:id/restore", post(hall::restore_member))
        .route("/api/v1/members/:id/periods", post(hall::add_member_period))
        .route(
            "/api/v1/members/:id/documents/:kind",
            post(documents::add).layer(axum::extract::DefaultBodyLimit::max(documents::MAX_BYTES + 1024)),
        )
        .route("/api/v1/documents/:id", get(documents::file).delete(documents::remove))
        .route("/api/v1/periods/:id", put(hall::update_period).delete(hall::delete_period))
        .route("/api/v1/daily-seats", post(hall::daily_seat))
        .route("/api/v1/registrations", get(registrations::list))
        .route("/api/v1/bills", get(hall::bills).post(hall::other_bill))
        .route("/api/v1/bills/:id", get(hall::bill))
        .route("/api/v1/bills/:id/printed", post(hall::bill_printed))
        .route("/api/v1/bills/:id/void", post(hall::void_bill))
        .route("/api/v1/plans", get(money::plans).post(money::create_plan))
        .route("/api/v1/plans/:id", put(money::update_plan))
        .route("/api/v1/expense-categories", get(money::categories).post(money::create_category))
        .route("/api/v1/expenses", get(money::expenses).post(money::create_expense))
        .route("/api/v1/expenses/:id", put(money::update_expense).delete(money::delete_expense))
        .route("/api/v1/expenses/:id/restore", post(money::restore_expense))
        .route("/api/v1/staff", get(money::staff))
        .route("/api/v1/salaries", get(salaries::list).post(salaries::create))
        .route("/api/v1/salaries/:id", put(salaries::update))
        .route("/api/v1/salaries/:id/month", put(salaries::set_month))
        .route("/api/v1/withdrawals", get(money::withdrawals).post(money::create_withdrawal))
        .route("/api/v1/withdrawals/:id", put(money::update_withdrawal).delete(money::delete_withdrawal))
        .route("/api/v1/withdrawals/:id/restore", post(money::restore_withdrawal))
        .route("/api/v1/book-rules", get(books::rules).put(books::set_rules))
        .route("/api/v1/book-titles", get(books::titles))
        .route("/api/v1/borrowers", get(books::borrowers))
        .route("/api/v1/deposits", get(books::deposits).post(books::create_deposit))
        .route("/api/v1/deposits/next-code", get(books::next_code))
        .route("/api/v1/deposits/:id", delete(books::delete_deposit))
        .route("/api/v1/deposits/:id/return", post(books::return_deposit))
        .route("/api/v1/book-loans", post(books::lend))
        .route("/api/v1/book-loans/:id", get(books::loan).delete(books::delete_loan))
        .route("/api/v1/book-loans/:id/return", post(books::return_loan))
        .route("/api/v1/hotspot/cards", get(hotspot::cards).put(hotspot::set_cards))
        .route("/api/v1/hotspot/buys", get(hotspot::buys).post(hotspot::create_buy))
        .route("/api/v1/hotspot/buys/:id", delete(hotspot::delete_buy))
        .route("/api/v1/hotspot/sales", get(hotspot::sales).post(hotspot::create_sale))
        .route("/api/v1/backup", get(backup::status).put(backup::set_plan).post(backup::backup_now))
        .route("/api/v1/backup/usb", post(backup::prepare_usb))
        .route("/api/v1/backup/restore", get(restore::list).post(restore::restore))
        .route("/api/v1/online", get(online::status).put(online::set_plan).post(online::copy_now))
        .route("/api/v1/loans", get(lists::loans))
        .route("/api/v1/inbox", get(phone::inbox))
        .route("/api/v1/inbox/count", get(phone::count))
        .route("/api/v1/inbox/:id/file", get(phone::file))
        .route("/api/v1/inbox/:id/accept", post(phone::accept))
        .route("/api/v1/inbox/:id/reject", post(phone::reject))
        .route("/api/v1/phone-upload", get(phone::status).put(phone::set_status))
        .route("/api/v1/qr", get(phone::qr))
        .layer(middleware::from_fn_with_state(state.clone(), wait_for_database))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health(State(s): State<AppState>) -> Json<Health> {
    let core = s.core.read().unwrap().clone();
    let (database, problem, detail) = if core.ready {
        match sqlx::query("SELECT 1").execute(&s.db).await {
            Ok(_) => (true, None, None),
            // Ready once, gone since: PostgreSQL was stopped while the app was open.
            Err(e) => (false, Some(if auth::is_unreachable(&e) { "postgres_down" } else { "db_error" }), Some(e.to_string())),
        }
    } else {
        (false, core.problem, core.detail)
    };
    Json(Health { status: "ok", database, problem, detail, version: env!("CARGO_PKG_VERSION") })
}

/// The official brand color; the desktop app falls back to it when a user has no personal color.
async fn brand_color(State(s): State<AppState>) -> Result<Json<serde_json::Value>, StatusCode> {
    let value: Option<serde_json::Value> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'brand_color'")
            .fetch_optional(&s.db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(value.unwrap_or_else(|| "#76b82a".into())))
}

/// DATABASE_URL from the environment, else the first line of
/// `%APPDATA%\\Pezhohesh\\database-url.txt` (written by the app's setup screen later).
fn database_url() -> String {
    if let Ok(url) = std::env::var("DATABASE_URL") {
        return url;
    }
    std::env::var("APPDATA")
        .ok()
        .and_then(|dir| std::fs::read_to_string(std::path::Path::new(&dir).join("Pezhohesh").join("database-url.txt")).ok())
        .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| "postgres://postgres@localhost:5432/pezhohesh".into())
}
