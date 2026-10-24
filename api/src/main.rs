//! Pezhohesh core API.
//!
//! Every client (desktop now, mobile later) talks to this API; nothing talks to the
//! database directly. The same binary runs on the office laptop against the local
//! PostgreSQL, and in the cloud against Neon.

use std::net::SocketAddr;

use axum::{extract::State, http::StatusCode, routing::{get, post, put}, Json, Router};
use serde::Serialize;
use sqlx::migrate::MigrateDatabase;
use sqlx::postgres::{PgPool, PgPoolOptions};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

mod auth;
mod dashboard;
mod lists;
mod import_excel;
mod reports;
mod solar;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
}

#[derive(Serialize)]
struct Health {
    status: &'static str,
    database: bool,
    version: &'static str,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()))
        .init();

    let database_url = database_url();
    let bind: SocketAddr = std::env::var("API_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8750".into())
        .parse()?;

    // First run on a fresh PostgreSQL: create the database itself, then the tables.
    if !sqlx::Postgres::database_exists(&database_url).await? {
        sqlx::Postgres::create_database(&database_url).await?;
        tracing::info!("created database");
    }
    let db = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await?;
    let migrator = sqlx::migrate!("../db/migrations");
    repair_crlf_checksums(&db, &migrator).await?;
    migrator.run(&db).await?;

    let app = router(AppState { db });
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!("pezhohesh-api listening on {bind}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
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
        .route("/api/v1/me/theme-mode", put(auth::set_theme_mode))
        .route("/api/v1/dashboard", get(dashboard::get))
        .route(
            "/api/v1/import/excel",
            post(import_excel::import).layer(axum::extract::DefaultBodyLimit::max(30 * 1024 * 1024)),
        )
        .route("/api/v1/reports/periods", get(reports::periods))
        .route("/api/v1/members", get(lists::members))
        .route("/api/v1/loans", get(lists::loans))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health(State(s): State<AppState>) -> Json<Health> {
    let database = sqlx::query("SELECT 1").execute(&s.db).await.is_ok();
    Json(Health {
        status: "ok",
        database,
        version: env!("CARGO_PKG_VERSION"),
    })
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
