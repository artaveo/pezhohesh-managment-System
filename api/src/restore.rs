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
    /// From the monthly folder: the last backup of a month, kept for good.
    monthly: bool,
    /// Why it was taken: manual | auto | before-restore | old (before v1.0).
    made: &'static str,
    folder: String,
    size: u64,
    modified: Option<DateTime<Utc>>,
}

async fn points(db: &PgPool) -> Result<Vec<Point>, sqlx::Error> {
    let dirs = backup::backup_dirs(db).await?;
    let mut list = tokio::task::spawn_blocking(move || {
        let mut list = vec![];
        for (kind, base) in dirs {
            for (dir, monthly) in [(base.clone(), false), (base.join(backup::MONTHLY_FOLDER), true)] {
                for f in backup::backups_in(&dir) {
                    list.push(Point {
                        made: f.made,
                        path: dir.join(&f.name).display().to_string(),
                        name: f.name,
                        kind,
                        monthly,
                        folder: dir.display().to_string(),
                        size: f.size,
                        modified: f.modified,
                    });
                }
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
    // Working on the shared server, this would replace everyone's data with this backup.
    if crate::sync::online_device().is_some() {
        return Err(ApiError::bad("restore_online"));
    }
    // Only a backup this app made, in one of its backup folders.
    let file = points(&s.db).await?.into_iter().find(|p| p.path == b.path).ok_or(ApiError(StatusCode::NOT_FOUND, "not_found"))?;
    let url = crate::database_url();

    let before = backup::run_backup(&s.db, &url, backup::Made::BeforeRestore).await?;
    if !before.ok {
        return Err(ApiError(StatusCode::CONFLICT, "safety_backup_failed"));
    }
    let before_name = before.file();

    let _one = backup::RUNNING.lock().await;
    // No sync round from here until the restored data is settled and the API has restarted.
    let sync = crate::sync::RUNNING.lock().await;
    s.pause("restoring");
    tracing::warn!("restoring {} for {}", file.path, user.username);
    let info = Kept { user: user.id, file: file.name.clone(), before: before_name.clone().unwrap_or_default() };
    if let Err(e) = replace_database(&url, Path::new(&file.path), &info).await {
        tracing::error!("restore failed: {e}");
        s.resume();
        return Err(ApiError(StatusCode::INTERNAL_SERVER_ERROR, "restore_failed"));
    }
    // The restored database is brought up to this version, then what was kept goes back
    // (the "who did what" log, accounts, this computer's settings) and, on a computer that
    // shares the server, the restore is queued to be sent there as everyone's data.
    if let Err(e) = crate::prepare_once(&url, &s.db).await {
        tracing::error!("restore: migrations after restore: {e:#}");
    }
    match merge_kept(&s.db).await {
        Ok(_) => {}
        Err(e) => tracing::error!("restore: kept data not merged yet (tried again on start): {e}"),
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
    // The sync lock goes with the process: nothing is pulled into the restored data before
    // the restore has been sent.
    tokio::spawn(async move {
        let _sync = sync;
        tokio::time::sleep(Duration::from_millis(1500)).await;
        // A talk with the fingerprint device is finished first, never cut off.
        crate::k50::quiesce(Duration::from_secs(90)).await;
        std::process::exit(0);
    });
    Ok(Json(Restored { before: before_name, files }))
}

/// Who restored which file, for the "who did what" log.
struct Kept {
    user: uuid::Uuid,
    file: String,
    before: String,
}

/// Puts back what was kept from before a restore (see restore_merge_kept in
/// 0025_restore_and_numbers.sql). Also run on start, in case the API stopped in between.
pub async fn merge_kept(db: &PgPool) -> Result<Option<String>, sqlx::Error> {
    let file: Option<String> = sqlx::query_scalar("SELECT restore_merge_kept()").fetch_one(db).await?;
    if let Some(f) = &file {
        tracing::warn!("restore of {f}: the log, accounts and this computer's settings are as before the restore");
    }
    Ok(file)
}

/// The tables whose rows stay as they are now through a restore, each kept as JSON.
const KEPT: &[(&str, &str)] = &[
    ("audit_log", "TABLE public.audit_log"),
    ("app_users", "TABLE public.app_users"),
    ("staff", "SELECT * FROM public.staff WHERE id IN (SELECT staff_id FROM public.app_users)"),
    ("devices", "TABLE public.devices"),
    ("receipt_counters", "TABLE public.receipt_counters"),
    ("settings", "TABLE public.settings"),
    ("k50_users", "TABLE public.k50_users"),
    ("k50_device_ids", "TABLE public.k50_device_ids"),
    ("k50_fingers", "TABLE public.k50_fingers"),
    ("k50_name_ok", "TABLE public.k50_name_ok"),
];

fn quoted(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

fn keep_sql(info: &Kept) -> String {
    let mut sql = String::from("DROP SCHEMA IF EXISTS pz_keep CASCADE; CREATE SCHEMA pz_keep; ");
    for (name, rows) in KEPT {
        sql.push_str(&format!("CREATE TABLE pz_keep.{name} AS SELECT to_jsonb(t) AS j FROM ({rows}) t; "));
    }
    sql.push_str(&format!(
        "CREATE TABLE pz_keep.info AS SELECT jsonb_build_object('user_id', {}, 'file', {}, 'before', {}, 'at', now()) AS j; ",
        quoted(&info.user.to_string()),
        quoted(&info.file),
        quoted(&info.before)
    ));
    sql
}

/// Keeps what must survive (see `KEPT`), empties the database and loads the backup into it,
/// in one transaction: if any step fails, the database stays exactly as it was.
async fn replace_database(url: &str, file: &Path, info: &Kept) -> Result<(), String> {
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
        .args(["--command", &format!("{} DROP SCHEMA public CASCADE; CREATE SCHEMA public;", keep_sql(info))])
        .arg("--file")
        .arg(&script);
    let result = run(psql, "psql").await;
    let _ = tokio::fs::remove_file(&script).await;
    result
}
