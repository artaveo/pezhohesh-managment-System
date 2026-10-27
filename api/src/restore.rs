//! Bringing the database and the photo files back from a backup, from the backup page.
//! It replaces everything typed since that backup, so a fresh backup is taken first: a
//! restore by mistake can itself be undone by restoring that one.

use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use crate::auth::{ApiError, CurrentUser};
use crate::backup::{self, pg_command, pg_tool, run};
use crate::AppState;

#[derive(Serialize)]
pub struct Point {
    /// The backup file, as given back to restore it.
    path: String,
    name: String,
    /// folder | usb | gdrive
    kind: &'static str,
    folder: String,
    size: u64,
    modified: Option<DateTime<Utc>>,
}

async fn points(db: &PgPool) -> Result<Vec<Point>, sqlx::Error> {
    let dirs = backup::backup_dirs(db).await?;
    let mut list = tokio::task::spawn_blocking(move || {
        let mut list = vec![];
        for (kind, dir) in dirs {
            for f in backup::backups_in(&dir) {
                list.push(Point {
                    path: dir.join(&f.name).display().to_string(),
                    name: f.name,
                    kind,
                    folder: dir.display().to_string(),
                    size: f.size,
                    modified: f.modified,
                });
            }
        }
        list
    })
    .await
    .unwrap_or_default();
    list.sort_by_key(|p| std::cmp::Reverse(p.modified));
    Ok(list)
}

/// GET /api/v1/backup/restore: every backup in every backup folder, newest first.
pub async fn list(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Vec<Point>>, ApiError> {
    if !user.is_partner() {
        return Err(ApiError::FORBIDDEN);
    }
    Ok(Json(points(&s.db).await?))
}

#[derive(Deserialize)]
pub struct Restore {
    path: String,
    /// The person typed the confirmation word on the page.
    confirm: bool,
}

#[derive(Serialize)]
pub struct Restored {
    /// The backup taken just before, of everything as it was.
    before: Option<String>,
    files: usize,
}

/// POST /api/v1/backup/restore (partners). Afterwards the core API restarts itself (the app
/// starts it again within seconds) so nothing remembers the database as it was.
pub async fn restore(State(s): State<AppState>, user: CurrentUser, Json(b): Json<Restore>) -> Result<Json<Restored>, ApiError> {
    if !user.is_partner() {
        return Err(ApiError::FORBIDDEN);
    }
    if !b.confirm {
        return Err(ApiError::bad("confirm_required"));
    }
    // Only a backup this app made, in one of its backup folders.
    let file = points(&s.db).await?.into_iter().find(|p| p.path == b.path).ok_or(ApiError(StatusCode::NOT_FOUND, "not_found"))?;
    let url = crate::database_url();

    let before = backup::run_backup(&s.db, &url).await?;
    if !before.ok {
        return Err(ApiError(StatusCode::CONFLICT, "safety_backup_failed"));
    }
    let before_name = points(&s.db).await?.into_iter().next().map(|p| p.name);

    let _one = backup::RUNNING.lock().await;
    s.pause("restoring");
    tracing::warn!("restoring {} for {}", file.path, user.username);
    if let Err(e) = replace_database(&url, Path::new(&file.path)).await {
        tracing::error!("restore failed: {e}");
        s.resume();
        return Err(ApiError(StatusCode::INTERNAL_SERVER_ERROR, "restore_failed"));
    }
    // The photos and tazkira scans that were in the backup's files folder. Files of the
    // laptop that the backup does not know stay; nothing points at them any more.
    let from = Path::new(&file.folder).join("files");
    let files = tokio::task::spawn_blocking(move || crate::documents::mirror(&from, &crate::documents::files_dir()))
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or(0);
    tracing::warn!("restored {}; {files} files copied back; restarting", file.name);
    tokio::spawn(async {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        std::process::exit(0);
    });
    Ok(Json(Restored { before: before_name, files }))
}

/// Empties the database and loads the backup into it, in one transaction: if any step fails,
/// the database stays exactly as it was.
async fn replace_database(url: &str, file: &Path) -> Result<(), String> {
    let script: PathBuf = std::env::temp_dir().join(format!("pezhohesh-restore-{}.sql", std::process::id()));
    // pg_restore writes the SQL instead of running it, so psql can run it after emptying the schema.
    let mut to_sql = tokio::process::Command::new(pg_tool("pg_restore"));
    to_sql.arg("--no-owner").arg("--file").arg(&script).arg(file);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        to_sql.creation_flags(CREATE_NO_WINDOW);
    }
    run(to_sql, "pg_restore").await?;
    let mut psql = pg_command("psql", url)?;
    psql.args(["--no-psqlrc", "--quiet", "--single-transaction", "--set", "ON_ERROR_STOP=1"])
        .args(["--command", "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"])
        .arg("--file")
        .arg(&script);
    let result = run(psql, "psql").await;
    let _ = tokio::fs::remove_file(&script).await;
    result
}
