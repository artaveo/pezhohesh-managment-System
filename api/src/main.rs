//! Pezhohesh core API.
//!
//! Every client (desktop now, mobile later) talks to this API; nothing talks to the
//! database directly. The same binary runs on the office laptop against the local
//! PostgreSQL, and in the cloud against Neon.

use std::net::SocketAddr;

use axum::{extract::State, http::StatusCode, routing::get, Json, Router};
use serde::Serialize;
use sqlx::postgres::{PgPool, PgPoolOptions};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

#[derive(Clone)]
struct AppState {
    db: PgPool,
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

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres@localhost:5432/pezhohesh".into());
    let bind: SocketAddr = std::env::var("API_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8750".into())
        .parse()?;

    let db = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await?;
    sqlx::migrate!("../db/migrations").run(&db).await?;

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

fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/v1/settings/brand-color", get(brand_color))
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
