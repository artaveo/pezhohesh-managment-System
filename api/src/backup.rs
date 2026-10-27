//! Backups of the whole database with PostgreSQL's own pg_dump, to one or two folders
//! (this laptop, and a USB stick or a network folder), on a schedule and on demand.
//! A backup file restores the database exactly as it was, with pg_restore.

use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use crate::auth::{begin_as, ApiError, CurrentUser};
use crate::{solar, AppState};

/// Backups older than this many runs are deleted from each folder.
const KEEP_DEFAULT: usize = 30;

/// The folder that marks a USB stick (or any other drive) for backups. Whatever letter
/// Windows gives the stick, a backup finds it by this folder.
pub const USB_FOLDER: &str = "Pezhohesh-Backup";

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Plan {
    /// First: on this laptop. Second (optional): a network folder or any other folder.
    folders: Vec<String>,
    /// Also to the first drive with a `Pezhohesh-Backup` folder (a USB stick).
    usb: bool,
    /// Also to Google Drive ("Google Drive for desktop" signed in on this laptop).
    gdrive: bool,
    every_hours: u32,
    keep: usize,
}

impl Default for Plan {
    fn default() -> Self {
        Plan { folders: vec![default_folder()], usb: true, gdrive: true, every_hours: 24, keep: KEEP_DEFAULT }
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Outcome {
    at: Option<DateTime<Utc>>,
    /// At least one folder got the backup (a USB stick that is not plugged in is not a failed backup).
    ok: bool,
    /// Per folder: the file written, or why not.
    folders: Vec<FolderOutcome>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct FolderOutcome {
    /// folder | usb | gdrive
    #[serde(default = "kind_folder")]
    kind: String,
    folder: String,
    file: Option<String>,
    error: Option<String>,
}

fn kind_folder() -> String {
    "folder".into()
}

/// The drives other than the system drive: D: to Z: on Windows (or PZ_DRIVES, ";"-separated, in tests).
fn drive_roots() -> Vec<PathBuf> {
    if let Ok(list) = std::env::var("PZ_DRIVES") {
        return list.split(';').filter(|p| !p.is_empty()).map(PathBuf::from).collect();
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
        use windows_sys::Win32::System::Diagnostics::Debug::{SetErrorMode, SEM_FAILCRITICALERRORS};
        // An empty card reader must not open a "no disk" message on the desk's screen.
        unsafe { SetErrorMode(SEM_FAILCRITICALERRORS) };
        ('D'..='Z')
            .filter(|c| {
                let root: Vec<u16> = format!("{c}:\\").encode_utf16().chain([0]).collect();
                // 2 removable, 3 fixed (USB hard disks say fixed), 4 network
                matches!(unsafe { GetDriveTypeW(root.as_ptr()) }, 2 | 3 | 4)
            })
            .map(|c| PathBuf::from(format!("{c}:\\")))
            .filter(|p| p.exists())
            .collect()
    }
    #[cfg(not(windows))]
    Vec::new()
}

/// The backup folder on the first drive that carries one (the USB stick).
fn usb_dir(roots: &[PathBuf]) -> Option<PathBuf> {
    roots.iter().map(|r| r.join(USB_FOLDER)).find(|p| p.is_dir())
}

/// Google Drive's "My Drive" folder, from "Google Drive for desktop" (a drive letter, or a
/// folder in the user's profile when it mirrors).
fn gdrive_root(roots: &[PathBuf]) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = roots.iter().map(|r| r.join("My Drive")).collect();
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        candidates.push(Path::new(&home).join("My Drive"));
        candidates.push(Path::new(&home).join("Google Drive"));
    }
    candidates.into_iter().find(|p| p.is_dir())
}

#[derive(Serialize)]
pub struct Drive {
    root: String,
    /// It already has the Pezhohesh-Backup folder.
    prepared: bool,
}

fn drives(roots: &[PathBuf], gdrive: Option<&Path>) -> Vec<Drive> {
    let gdrive = gdrive.and_then(Path::parent);
    roots
        .iter()
        .filter(|r| Some(r.as_path()) != gdrive)
        .map(|r| Drive { prepared: r.join(USB_FOLDER).is_dir(), root: r.display().to_string() })
        .collect()
}

fn default_folder() -> String {
    std::env::var("APPDATA")
        .map(|d| Path::new(&d).join("Pezhohesh").join("backups").display().to_string())
        .unwrap_or_else(|_| "backups".into())
}

/// A stored setting; None when it was never saved. A database error is an error, so a
/// backup never quietly falls back to the default folders.
async fn setting<T: for<'de> Deserialize<'de>>(db: &PgPool, key: &str) -> Result<Option<T>, sqlx::Error> {
    let v: Option<serde_json::Value> = sqlx::query_scalar("SELECT value FROM settings WHERE key = $1").bind(key).fetch_optional(db).await?;
    Ok(v.and_then(|v| serde_json::from_value(v).ok()))
}

async fn plan_of(db: &PgPool) -> Result<Plan, sqlx::Error> {
    Ok(setting(db, "backup_plan").await?.unwrap_or_default())
}

/// The files this app wrote: other .backup files in the same folder are never touched.
fn is_ours(name: &str) -> bool {
    name.starts_with("pezhohesh_") && name.ends_with(".backup")
}

/// pg_dump of the PostgreSQL that is installed (the newest version), or the one on PATH.
fn pg_dump() -> PathBuf {
    pg_tool("pg_dump")
}

/// A PostgreSQL program (pg_dump, pg_restore) of the newest installed version, or on PATH.
pub fn pg_tool(name: &str) -> PathBuf {
    let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    if let Ok(dir) = std::env::var("PG_BIN") {
        return Path::new(&dir).join(exe);
    }
    if cfg!(windows) {
        let root = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
        let mut found: Vec<(u32, PathBuf)> = std::fs::read_dir(Path::new(&root).join("PostgreSQL"))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let version = e.file_name().to_string_lossy().split('.').next()?.parse().ok()?;
                let path = e.path().join("bin").join(&exe);
                path.exists().then_some((version, path))
            })
            .collect();
        found.sort();
        if let Some((_, path)) = found.pop() {
            return path;
        }
    }
    PathBuf::from(exe)
}

/// "pezhohesh_1405-08-05_10-30.backup": the Solar date and time it was taken.
fn file_name(now: DateTime<Local>) -> String {
    let day = now.date_naive();
    let y = solar::year_of(day);
    let (m, d) = solar::month_day(day);
    format!("pezhohesh_{y}-{m:02}-{d:02}_{}.backup", now.format("%H-%M-%S"))
}

/// One backup at a time: the scheduler and the button never write the same file together.
static RUNNING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Runs one backup into every folder of the plan and keeps the outcome in settings.
pub async fn run_backup(db: &PgPool, url: &str) -> Result<Outcome, sqlx::Error> {
    let _one = RUNNING.lock().await;
    let plan = plan_of(db).await?;
    let name = file_name(Local::now());
    let mut out = Outcome { at: Some(Utc::now()), ok: false, folders: vec![] };
    // Where to: the plan's folders, then the USB stick and Google Drive when they are there.
    let mut targets: Vec<(&str, Result<PathBuf, &str>)> =
        plan.folders.iter().map(|f| f.trim()).filter(|f| !f.is_empty()).map(|f| ("folder", Ok(PathBuf::from(f)))).collect();
    let (usb, gdrive) = tokio::task::spawn_blocking(|| {
        let roots = drive_roots();
        (usb_dir(&roots), gdrive_root(&roots))
    })
    .await
    .unwrap_or((None, None));
    if plan.usb {
        targets.push(("usb", usb.ok_or("usb_not_found")));
    }
    if plan.gdrive {
        targets.push(("gdrive", gdrive.map(|g| g.join(USB_FOLDER)).ok_or("gdrive_not_found")));
    }
    // One dump, copied to the other folders: every copy is the same moment.
    let mut first: Option<PathBuf> = None;
    for (kind, dir) in targets {
        let dir = match dir {
            Ok(d) => d,
            Err(e) => {
                out.folders.push(FolderOutcome { kind: kind.into(), folder: String::new(), file: None, error: Some(e.into()) });
                continue;
            }
        };
        let folder = dir.display().to_string();
        let dir = dir.as_path();
        let target = dir.join(&name);
        let result = match &first {
            None => dump(url, dir, &target).await,
            Some(src) => copy(src, dir, &target).await,
        };
        match result {
            Ok(()) => {
                out.ok = true;
                first.get_or_insert(target.clone());
                // Photos and tazkira scans are files, not in the dump: each folder gets a copy too.
                let (dir, keep) = (dir.to_path_buf(), plan.keep.max(1));
                let files = tokio::task::spawn_blocking(move || {
                    prune(&dir, keep);
                    crate::documents::mirror(&crate::documents::files_dir(), &dir.join("files"))
                })
                .await;
                let error = match files {
                    Ok(Ok(_)) => None,
                    Ok(Err(e)) => Some(format!("files: {e}")),
                    Err(e) => Some(format!("files: {e}")),
                };
                out.folders.push(FolderOutcome { kind: kind.into(), folder, file: Some(name.clone()), error });
            }
            Err(e) => {
                tracing::error!("backup to {folder} failed: {e}");
                out.folders.push(FolderOutcome { kind: kind.into(), folder, file: None, error: Some(e) });
            }
        }
    }
    let _ = sqlx::query(
        "INSERT INTO settings (key, value) VALUES ('backup_last', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    )
    .bind(serde_json::to_value(&out).unwrap_or_default())
    .execute(db)
    .await;
    Ok(out)
}

async fn copy(src: &Path, dir: &Path, target: &Path) -> Result<(), String> {
    tokio::fs::create_dir_all(dir).await.map_err(|e| format!("folder: {e}"))?;
    let partial = target.with_extension("partial");
    let done = match tokio::fs::copy(src, &partial).await {
        Ok(_) => tokio::fs::rename(&partial, target).await,
        Err(e) => Err(e),
    };
    if done.is_err() {
        let _ = tokio::fs::remove_file(&partial).await;
    }
    done.map_err(|e| e.to_string())
}

pub async fn dump(url: &str, dir: &Path, target: &Path) -> Result<(), String> {
    tokio::fs::create_dir_all(dir).await.map_err(|e| format!("folder: {e}"))?;
    let partial = target.with_extension("partial");
    let mut cmd = pg_command("pg_dump", url)?;
    cmd.arg("--format=custom").arg("--file").arg(&partial);
    if let Err(e) = run(cmd, "pg_dump").await {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(e);
    }
    // Only a finished dump gets the .backup name, so a half-written file is never taken for one.
    tokio::fs::rename(&partial, target).await.map_err(|e| e.to_string())
}

/// A PostgreSQL program for the database at `url`: the password goes in the environment,
/// not on the command line, and on Windows no console window opens.
pub fn pg_command(tool: &str, url: &str) -> Result<tokio::process::Command, String> {
    let mut parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
    let password = parsed.password().map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned());
    let _ = parsed.set_password(None);
    let mut cmd = tokio::process::Command::new(pg_tool(tool));
    cmd.arg("--dbname").arg(parsed.as_str());
    if let Some(p) = password {
        cmd.env("PGPASSWORD", p);
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(cmd)
}

/// Runs it; on failure, the line that says why (PostgreSQL programs put the cause on their
/// "error:" line; detail and hint lines follow it).
pub async fn run(mut cmd: tokio::process::Command, tool: &str) -> Result<(), String> {
    let output = cmd.output().await.map_err(|e| format!("{tool}: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&output.stderr);
    let line = err.lines().find(|l| l.contains("error:")).or_else(|| err.lines().find(|l| !l.trim().is_empty()));
    Err(line.unwrap_or("failed").trim().to_string())
}

/// Keeps the newest `keep` backups of the folder.
fn prune(dir: &Path, keep: usize) {
    let mut files = backups_in(dir);
    files.sort_by_key(|f| std::cmp::Reverse(f.modified));
    for f in files.into_iter().skip(keep) {
        let _ = std::fs::remove_file(dir.join(&f.name));
    }
}

#[derive(Serialize)]
pub struct BackupFile {
    name: String,
    size: u64,
    modified: Option<DateTime<Utc>>,
}

fn backups_in(dir: &Path) -> Vec<BackupFile> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| is_ours(&e.file_name().to_string_lossy()))
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            Some(BackupFile {
                name: e.file_name().to_string_lossy().into_owned(),
                size: meta.len(),
                modified: meta.modified().ok().map(DateTime::<Utc>::from),
            })
        })
        .collect()
}

/// A minute after start, then every 10 minutes: a backup when the last good one is older
/// than the plan says. After a failed try it waits an hour before trying again.
pub async fn schedule(db: PgPool, url: String) {
    let mut wait = Duration::from_secs(60);
    let mut failed_at: Option<DateTime<Utc>> = None;
    loop {
        tokio::time::sleep(wait).await;
        wait = Duration::from_secs(600);
        let (Ok(plan), Ok(last)) = (plan_of(&db).await, setting::<Outcome>(&db, "backup_last").await) else { continue };
        if plan.every_hours == 0 || failed_at.is_some_and(|t| Utc::now() - t < chrono::Duration::hours(1)) {
            continue;
        }
        let last_ok = last.filter(|o| o.ok).and_then(|o| o.at);
        if last_ok.is_none_or(|t| Utc::now() - t >= chrono::Duration::hours(plan.every_hours as i64)) {
            let ok = run_backup(&db, &url).await.is_ok_and(|o| o.ok);
            failed_at = (!ok).then(Utc::now);
            tracing::info!("scheduled backup: {}", if ok { "ok" } else { "failed" });
        }
    }
}

// ---------------------------------------------------------------------------
// The backup page (partners)

#[derive(Serialize)]
pub struct Status {
    plan: Plan,
    last: Option<Outcome>,
    /// Backups in the first folder, newest first.
    files: Vec<BackupFile>,
    pg_dump: String,
    /// Where a backup would go now.
    usb: Option<String>,
    gdrive: Option<String>,
    drives: Vec<Drive>,
}

fn partner(user: &CurrentUser) -> Result<(), ApiError> {
    if user.is_partner() { Ok(()) } else { Err(ApiError::FORBIDDEN) }
}

pub async fn status(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Status>, ApiError> {
    partner(&user)?;
    let plan = plan_of(&s.db).await?;
    let first = plan.folders.first().map(PathBuf::from);
    let mut files = match first {
        Some(dir) => tokio::task::spawn_blocking(move || backups_in(&dir)).await.unwrap_or_default(),
        None => vec![],
    };
    files.sort_by_key(|f| std::cmp::Reverse(f.modified));
    let (usb, gdrive, drives) = tokio::task::spawn_blocking(|| {
        let roots = drive_roots();
        let gdrive = gdrive_root(&roots);
        (
            usb_dir(&roots).map(|p| p.display().to_string()),
            gdrive.as_ref().map(|p| p.join(USB_FOLDER).display().to_string()),
            drives(&roots, gdrive.as_deref()),
        )
    })
    .await
    .unwrap_or((None, None, vec![]));
    Ok(Json(Status { last: setting(&s.db, "backup_last").await?, files, pg_dump: pg_dump().display().to_string(), plan, usb, gdrive, drives }))
}

pub async fn set_plan(State(s): State<AppState>, user: CurrentUser, Json(p): Json<Plan>) -> Result<StatusCode, ApiError> {
    partner(&user)?;
    let folders: Vec<String> = p.folders.iter().map(|f| f.trim().to_string()).filter(|f| !f.is_empty()).take(2).collect();
    if folders.is_empty() {
        return Err(ApiError::bad("folder_required"));
    }
    if p.every_hours > 24 * 7 || !(1..=365).contains(&p.keep) {
        return Err(ApiError::bad("bad_backup_plan"));
    }
    let plan = Plan { folders, usb: p.usb, gdrive: p.gdrive, every_hours: p.every_hours, keep: p.keep };
    let mut tx = begin_as(&s.db, &user).await?;
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ('backup_plan', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    )
    .bind(serde_json::to_value(&plan).unwrap_or_default())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct PrepareUsb {
    root: String,
}

/// POST /api/v1/backup/usb: makes the Pezhohesh-Backup folder on a drive, so backups find it.
pub async fn prepare_usb(user: CurrentUser, Json(p): Json<PrepareUsb>) -> Result<StatusCode, ApiError> {
    partner(&user)?;
    let root = tokio::task::spawn_blocking(move || drive_roots().into_iter().find(|r| r.display().to_string() == p.root))
        .await
        .ok()
        .flatten()
        .ok_or(ApiError::bad("drive_not_found"))?;
    tokio::fs::create_dir_all(root.join(USB_FOLDER)).await.map_err(|_| ApiError::bad("drive_not_writable"))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn backup_now(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Outcome>, ApiError> {
    partner(&user)?;
    Ok(Json(run_backup(&s.db, &crate::database_url()).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert!(is_ours("pezhohesh_1405-08-05_10-30-00.backup"));
        assert!(!is_ours("other_db.backup"));
        let t = chrono::NaiveDate::from_ymd_opt(2026, 10, 27).unwrap().and_hms_opt(10, 30, 0).unwrap();
        let local = t.and_local_timezone(Local).unwrap();
        assert_eq!(file_name(local), "pezhohesh_1405-08-05_10-30-00.backup");
    }
}
