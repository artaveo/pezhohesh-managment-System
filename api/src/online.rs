//! The online copy in Neon. The laptop stays the real database; every few hours a full
//! copy of it replaces the one online, in one transaction (the online copy is never half
//! old, half new). Later, partners can read reports from it away from the office.
//! Photos and tazkira scans stay on the laptop and its backups, and so do the fingerprints
//! copied from the device (k50_fingers).
//!
//! The online database's address (with its password) is kept in
//! `%APPDATA%\Pezhohesh\online-url.txt`, never in the database: the database is what gets copied.

use std::path::PathBuf;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Connection, PgPool};

use crate::auth::{ApiError, CurrentUser};
use crate::backup::{pg_command, run};
use crate::AppState;

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Outcome {
    at: Option<DateTime<Utc>>,
    ok: bool,
    error: Option<String>,
    seconds: Option<u64>,
}

fn url_file() -> Option<PathBuf> {
    std::env::var("APPDATA").ok().map(|d| PathBuf::from(d).join("Pezhohesh").join("online-url.txt"))
}

fn target_url() -> Option<String> {
    if let Ok(u) = std::env::var("ONLINE_DATABASE_URL") {
        return Some(u);
    }
    let text = std::fs::read_to_string(url_file()?).ok()?;
    text.lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty())
}

async fn every_hours(db: &PgPool) -> Result<u32, sqlx::Error> {
    let v: Option<serde_json::Value> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'online_every_hours'").fetch_optional(db).await?;
    Ok(v.and_then(|v| v.as_u64()).map_or(6, |h| h as u32))
}

async fn last(db: &PgPool) -> Result<Option<Outcome>, sqlx::Error> {
    let v: Option<serde_json::Value> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'online_last'").fetch_optional(db).await?;
    Ok(v.and_then(|v| serde_json::from_value(v).ok()))
}

static RUNNING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The roles the row-level security policies name must exist online before the copy.
async fn prepare(target: &str) -> Result<(), String> {
    let mut c = sqlx::PgConnection::connect(target).await.map_err(|e| format!("connect: {e}"))?;
    sqlx::query(
        "DO $$ DECLARE r TEXT; BEGIN \
           FOREACH r IN ARRAY ARRAY['pz_partner', 'pz_manager', 'pz_pec'] LOOP \
             IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF; \
           END LOOP; END $$",
    )
    .execute(&mut c)
    .await
    .map_err(|e| format!("roles: {e}"))?;
    let _ = c.close().await;
    Ok(())
}

async fn copy(local: &str, target: &str) -> Result<(), String> {
    let file = std::env::temp_dir().join(format!("pezhohesh-online-{}.dump", uuid::Uuid::new_v4().simple()));
    let result = async {
        let mut dump = pg_command("pg_dump", local)?;
        // Sign-in sessions stay on the laptop.
        dump.args(["--format=custom", "--no-owner", "--no-privileges", "--exclude-table-data=user_sessions", "--exclude-table-data=k50_fingers", "--file"]).arg(&file);
        run(dump, "pg_dump").await?;
        prepare(target).await?;
        let mut restore = pg_command("pg_restore", target)?;
        restore.args(["--clean", "--if-exists", "--no-owner", "--no-privileges", "--single-transaction"]).arg(&file);
        run(restore, "pg_restore").await
    }
    .await;
    let _ = tokio::fs::remove_file(&file).await;
    result
}

/// Sends one full copy online and keeps the outcome in settings.
pub async fn run_copy(db: &PgPool, local: &str) -> Result<Outcome, sqlx::Error> {
    let _one = RUNNING.lock().await;
    let started = std::time::Instant::now();
    let result = match target_url() {
        Some(target) => copy(local, &target).await,
        None => Err("not_set".to_string()),
    };
    let out = Outcome {
        at: Some(Utc::now()),
        ok: result.is_ok(),
        seconds: Some(started.elapsed().as_secs()),
        error: result.err().inspect(|e| tracing::error!("online copy failed: {e}")),
    };
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ('online_last', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    )
    .bind(serde_json::to_value(&out).unwrap_or_default())
    .execute(db)
    .await?;
    Ok(out)
}

/// Like the backups: two minutes after start, then every 10 minutes, a copy when the last
/// good one is older than the plan says; after a failed try (no internet), an hour's wait.
pub async fn schedule(db: PgPool, url: String) {
    let mut wait = Duration::from_secs(120);
    let mut failed_at: Option<DateTime<Utc>> = None;
    loop {
        tokio::time::sleep(wait).await;
        wait = Duration::from_secs(600);
        if target_url().is_none() {
            continue;
        }
        let (Ok(hours), Ok(last)) = (every_hours(&db).await, last(&db).await) else { continue };
        if hours == 0 || failed_at.is_some_and(|t| Utc::now() - t < chrono::Duration::hours(1)) {
            continue;
        }
        let last_ok = last.filter(|o| o.ok).and_then(|o| o.at);
        if last_ok.is_none_or(|t| Utc::now() - t >= chrono::Duration::hours(hours as i64)) {
            let ok = run_copy(&db, &url).await.is_ok_and(|o| o.ok);
            failed_at = (!ok).then(Utc::now);
            tracing::info!("online copy: {}", if ok { "ok" } else { "failed" });
        }
    }
}

// ---------------------------------------------------------------------------
// On the backup page (partners)

#[derive(Serialize)]
pub struct Status {
    /// Only the server's name; the address with its password never leaves the laptop.
    host: Option<String>,
    every_hours: u32,
    last: Option<Outcome>,
}

fn partner(user: &CurrentUser) -> Result<(), ApiError> {
    if user.is_partner() { Ok(()) } else { Err(ApiError::FORBIDDEN) }
}

pub async fn status(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Status>, ApiError> {
    partner(&user)?;
    let host = target_url().and_then(|u| url::Url::parse(&u).ok()?.host_str().map(String::from));
    Ok(Json(Status { host, every_hours: every_hours(&s.db).await?, last: last(&s.db).await? }))
}

#[derive(Deserialize)]
pub struct PlanInput {
    every_hours: u32,
    /// A new address; "" removes it; left out keeps the one there is.
    url: Option<String>,
}

pub async fn set_plan(State(s): State<AppState>, user: CurrentUser, Json(p): Json<PlanInput>) -> Result<StatusCode, ApiError> {
    partner(&user)?;
    if p.every_hours > 24 * 7 {
        return Err(ApiError::bad("bad_online_plan"));
    }
    if let Some(url) = p.url.as_deref().map(str::trim) {
        let file = url_file().ok_or(ApiError::bad("bad_online_url"))?;
        if url.is_empty() {
            let _ = std::fs::remove_file(&file);
        } else {
            let ok = url::Url::parse(url).is_ok_and(|u| matches!(u.scheme(), "postgres" | "postgresql") && u.host_str().is_some());
            if !ok {
                return Err(ApiError::bad("bad_online_url"));
            }
            if let Some(dir) = file.parent() {
                std::fs::create_dir_all(dir).map_err(|_| ApiError::bad("bad_online_url"))?;
            }
            std::fs::write(&file, format!("{url}\n")).map_err(|_| ApiError::bad("bad_online_url"))?;
        }
    }
    let mut tx = crate::auth::begin_as(&s.db, &user).await?;
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ('online_every_hours', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    )
    .bind(serde_json::json!(p.every_hours))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn copy_now(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Outcome>, ApiError> {
    partner(&user)?;
    Ok(Json(run_copy(&s.db, &crate::database_url()).await?))
}
