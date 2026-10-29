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

use uuid::Uuid;

use crate::auth::{begin_as, ApiError, CurrentUser};
use crate::{solar, AppState};

/// Daily backups older than this many days are deleted from each folder (the newest one and
/// the monthly folder always stay).
const KEEP_DAYS_DEFAULT: u32 = 30;

/// In each backup folder: the last backup of every Solar month, never deleted.
pub const MONTHLY_FOLDER: &str = "ماهانه";

/// In each backup folder: the app's copy of ZKTeco's SDK (%APPDATA%\Pezhohesh\zk), so a new
/// computer can take it from a USB stick or a backup.
pub const SDK_FOLDER: &str = "zk";

/// The folder that marks a USB stick (or any other drive) for backups. Whatever letter
/// Windows gives the stick, a backup finds it by this folder.
pub const USB_FOLDER: &str = "Pezhohesh-Backup";

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Plan {
    /// First: on this laptop. Second (optional): a network folder or any other folder.
    folders: Vec<String>,
    /// Also to the drive chosen for backups (a USB stick), see `usb_drive`.
    usb: bool,
    /// The drive picked on the backup page ("F:\\"), as it was named then.
    usb_drive: Option<String>,
    /// The id written on that drive (Pezhohesh-Backup\\pezhohesh-drive.txt), so it is found
    /// again when Windows gives it another letter, and no other drive is used instead.
    usb_id: Option<String>,
    /// Also to Google Drive ("Google Drive for desktop" signed in on this laptop).
    gdrive: bool,
    every_hours: u32,
    keep_days: u32,
}

impl Default for Plan {
    fn default() -> Self {
        Plan { folders: vec![default_folder()], usb: true, usb_drive: None, usb_id: None, gdrive: true, every_hours: 24, keep_days: KEEP_DAYS_DEFAULT }
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Outcome {
    at: Option<DateTime<Utc>>,
    /// At least one folder got the backup (a USB stick that is not plugged in is not a failed backup).
    pub ok: bool,
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

/// A drive other than the system drive, and whether it is outside the laptop: a USB stick or
/// a USB hard disk (which Windows calls "fixed", like the laptop's own partitions).
#[derive(Clone)]
struct Root {
    path: PathBuf,
    removable: bool,
}

/// The file on a picked drive that names it.
const DRIVE_ID_FILE: &str = "pezhohesh-drive.txt";

fn drive_id(root: &Path) -> Option<String> {
    let id = std::fs::read_to_string(root.join(USB_FOLDER).join(DRIVE_ID_FILE)).ok()?;
    Some(id.trim().to_string()).filter(|i| !i.is_empty())
}

/// Whether the volume sits on a disk connected by USB (the bus type of its disk).
#[cfg(windows)]
fn on_usb(letter: char) -> bool {
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{BusTypeUsb, CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
    use windows_sys::Win32::System::Ioctl::{
        PropertyStandardQuery, StorageDeviceProperty, IOCTL_STORAGE_QUERY_PROPERTY, STORAGE_DEVICE_DESCRIPTOR, STORAGE_PROPERTY_QUERY,
    };
    use windows_sys::Win32::System::IO::DeviceIoControl;
    let path: Vec<u16> = format!("\\\\.\\{letter}:").encode_utf16().chain([0]).collect();
    unsafe {
        // No access rights are needed to ask a volume about its disk.
        let h = CreateFileW(path.as_ptr(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE, std::ptr::null(), OPEN_EXISTING, 0, std::ptr::null_mut());
        if h == INVALID_HANDLE_VALUE {
            return false;
        }
        let query = STORAGE_PROPERTY_QUERY { PropertyId: StorageDeviceProperty, QueryType: PropertyStandardQuery, AdditionalParameters: [0] };
        let mut buf = [0u8; 1024];
        let mut got = 0u32;
        let ok = DeviceIoControl(
            h,
            IOCTL_STORAGE_QUERY_PROPERTY,
            &query as *const _ as *const _,
            size_of::<STORAGE_PROPERTY_QUERY>() as u32,
            buf.as_mut_ptr() as *mut _,
            buf.len() as u32,
            &mut got,
            std::ptr::null_mut(),
        );
        CloseHandle(h);
        if ok == 0 || (got as usize) < size_of::<STORAGE_DEVICE_DESCRIPTOR>() {
            return false;
        }
        let d: STORAGE_DEVICE_DESCRIPTOR = std::ptr::read_unaligned(buf.as_ptr() as *const _);
        d.BusType == BusTypeUsb
    }
}

/// The drives other than the system drive: D: to Z: on Windows (or PZ_DRIVES, ";"-separated, in
/// tests; a "+" in front marks a removable one).
fn drive_roots() -> Vec<Root> {
    if let Ok(list) = std::env::var("PZ_DRIVES") {
        return list
            .split(';')
            .filter(|p| !p.is_empty())
            .map(|p| Root { removable: p.starts_with('+'), path: PathBuf::from(p.trim_start_matches('+')) })
            .collect();
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
        use windows_sys::Win32::System::Diagnostics::Debug::{SetErrorMode, SEM_FAILCRITICALERRORS};
        // An empty card reader must not open a "no disk" message on the desk's screen.
        unsafe { SetErrorMode(SEM_FAILCRITICALERRORS) };
        ('D'..='Z')
            .filter_map(|c| {
                let root: Vec<u16> = format!("{c}:\\").encode_utf16().chain([0]).collect();
                // 2 removable, 3 fixed (USB hard disks say fixed), 4 network
                match unsafe { GetDriveTypeW(root.as_ptr()) } {
                    t @ (2 | 3 | 4) => Some(Root { path: PathBuf::from(format!("{c}:\\")), removable: t == 2 || (t == 3 && on_usb(c)) }),
                    _ => None,
                }
            })
            .filter(|r| r.path.exists())
            .collect()
    }
    #[cfg(not(windows))]
    Vec::new()
}

/// The backup folder on the picked drive, found by its id whatever its letter is now. Before
/// a drive was ever picked: a USB drive that carries the folder. Never quietly a partition of
/// the laptop's own disk: that is no copy for when the laptop is lost.
fn usb_dir(roots: &[Root], picked: Option<&str>) -> Option<PathBuf> {
    match picked {
        Some(id) => roots.iter().find(|r| drive_id(&r.path).as_deref() == Some(id)),
        None => roots.iter().filter(|r| r.removable).find(|r| r.path.join(USB_FOLDER).is_dir()),
    }
    .map(|r| r.path.join(USB_FOLDER))
}

/// Google Drive's "My Drive" folder, from "Google Drive for desktop" (a drive letter, or a
/// folder in the user's profile when it mirrors).
fn gdrive_root(roots: &[Root]) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = roots.iter().map(|r| r.path.join("My Drive")).collect();
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        candidates.push(Path::new(&home).join("My Drive"));
        candidates.push(Path::new(&home).join("Google Drive"));
    }
    candidates.into_iter().find(|p| p.is_dir())
}

#[derive(Serialize)]
pub struct Drive {
    root: String,
    /// The drive picked for backups.
    picked: bool,
    /// It already has the Pezhohesh-Backup folder.
    prepared: bool,
    /// A USB stick (Windows says removable); otherwise a disk inside the laptop or a USB hard disk.
    removable: bool,
}

fn drives(roots: &[Root], gdrive: Option<&Path>, picked: Option<&str>) -> Vec<Drive> {
    let gdrive = gdrive.and_then(Path::parent);
    roots
        .iter()
        .filter(|r| Some(r.path.as_path()) != gdrive)
        .map(|r| Drive {
            picked: picked.is_some() && drive_id(&r.path).as_deref() == picked,
            prepared: r.path.join(USB_FOLDER).is_dir(),
            root: r.path.display().to_string(),
            removable: r.removable,
        })
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

/// Every folder backups go to now (the plan's folders, the USB drive and Google Drive when
/// they are there), for finding a backup to restore.
pub(crate) async fn backup_dirs(db: &PgPool) -> Result<Vec<(&'static str, PathBuf)>, sqlx::Error> {
    let plan = plan_of(db).await?;
    let mut dirs: Vec<(&'static str, PathBuf)> =
        plan.folders.iter().map(|f| f.trim()).filter(|f| !f.is_empty()).map(|f| ("folder", PathBuf::from(f))).collect();
    let chosen = plan.usb_id.clone();
    let (usb, gdrive) = tokio::task::spawn_blocking(move || {
        let roots = drive_roots();
        (usb_dir(&roots, chosen.as_deref()), gdrive_root(&roots))
    })
    .await
    .unwrap_or((None, None));
    dirs.extend(usb.map(|d| ("usb", d)));
    dirs.extend(gdrive.map(|g| ("gdrive", g.join(USB_FOLDER))));
    Ok(dirs)
}

/// Copies of the fingerprint SDK that backups left: in the backup folders, and on any drive
/// with a backup folder (a USB stick brought from the other computer).
pub(crate) async fn sdk_copies(db: &PgPool) -> Result<Vec<String>, sqlx::Error> {
    let dirs = backup_dirs(db).await?;
    Ok(tokio::task::spawn_blocking(move || {
        let mut found: Vec<PathBuf> = dirs.into_iter().map(|(_, d)| d.join(SDK_FOLDER)).collect();
        found.extend(drive_roots().into_iter().map(|r| r.path.join(USB_FOLDER).join(SDK_FOLDER)));
        let mut seen = std::collections::HashSet::new();
        found
            .into_iter()
            .filter(|d| d.join("zkemkeeper.dll").is_file())
            .map(|d| d.display().to_string())
            .filter(|d| seen.insert(d.to_lowercase()))
            .collect()
    })
    .await
    .unwrap_or_default())
}

/// The files this app wrote: other .backup files in the same folder are never touched.
pub(crate) fn is_ours(name: &str) -> bool {
    name.starts_with("pezhohesh_") && name.ends_with(".backup")
}

/// pg_dump of the PostgreSQL that is installed (the newest version), or the one on PATH.
fn pg_dump() -> PathBuf {
    pg_tool("pg_dump")
}

/// Whether PostgreSQL is installed here. A partner's laptop that works on the server
/// directly needs none; its backups are the hall computer's.
pub fn has_postgres() -> bool {
    let p = pg_dump();
    p.is_absolute() && p.exists()
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
pub(crate) static RUNNING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Runs one backup into every folder of the plan and keeps the outcome in settings.
pub async fn run_backup(db: &PgPool, url: &str) -> Result<Outcome, sqlx::Error> {
    let _one = RUNNING.lock().await;
    let plan = plan_of(db).await?;
    let name = file_name(Local::now());
    let mut out = Outcome { at: Some(Utc::now()), ok: false, folders: vec![] };
    // Where to: the plan's folders, then the USB stick and Google Drive when they are there.
    let mut targets: Vec<(&str, Result<PathBuf, &str>)> =
        plan.folders.iter().map(|f| f.trim()).filter(|f| !f.is_empty()).map(|f| ("folder", Ok(PathBuf::from(f)))).collect();
    let chosen = plan.usb_id.clone();
    let (usb, gdrive) = tokio::task::spawn_blocking(move || {
        let roots = drive_roots();
        (usb_dir(&roots, chosen.as_deref()), gdrive_root(&roots))
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
                // The month's copy, replaced by each later backup of the same month, so the
                // last one of every month stays for good.
                let month = monthly_name(Local::now());
                let monthly = copy(&target, &dir.join(MONTHLY_FOLDER), &dir.join(MONTHLY_FOLDER).join(&month)).await;
                // Photos and tazkira scans are files, not in the dump: each folder gets a copy
                // too, and so does the fingerprint SDK.
                let (dir, keep) = (dir.to_path_buf(), plan.keep_days.max(1));
                let files = tokio::task::spawn_blocking(move || {
                    prune(&dir, keep);
                    let _ = copy_flat(&sdk_dir(), &dir.join(SDK_FOLDER));
                    crate::documents::mirror(&crate::documents::files_dir(), &dir.join("files"))
                })
                .await;
                let error = match (files, monthly) {
                    (Ok(Err(e)), _) => Some(format!("files: {e}")),
                    (Err(e), _) => Some(format!("files: {e}")),
                    (_, Err(e)) => Some(format!("{MONTHLY_FOLDER}: {e}")),
                    _ => None,
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

/// Deletes the folder's backups older than `days` days, always keeping the newest one. The
/// monthly folder is not touched.
fn prune(dir: &Path, days: u32) {
    let mut files = backups_in(dir);
    files.sort_by_key(|f| std::cmp::Reverse(f.modified));
    let cut = Utc::now() - chrono::Duration::days(days as i64);
    for f in files.into_iter().skip(1) {
        if f.modified.is_some_and(|m| m < cut) {
            let _ = std::fs::remove_file(dir.join(&f.name));
        }
    }
}

/// "pezhohesh_1405-08.backup": the month's copy in the monthly folder.
fn monthly_name(now: DateTime<Local>) -> String {
    let day = now.date_naive();
    let (m, _) = solar::month_day(day);
    format!("pezhohesh_{}-{m:02}.backup", solar::year_of(day))
}

/// %APPDATA%\Pezhohesh\zk: the app's copy of the fingerprint SDK (see k50-helper).
pub(crate) fn sdk_dir() -> PathBuf {
    std::env::var("APPDATA").map(|d| Path::new(&d).join("Pezhohesh").join(SDK_FOLDER)).unwrap_or_else(|_| PathBuf::from(SDK_FOLDER))
}

/// Copies the files of `from` (not its subfolders) that `to` lacks or holds in another size.
fn copy_flat(from: &Path, to: &Path) -> std::io::Result<usize> {
    let Ok(files) = std::fs::read_dir(from) else { return Ok(0) };
    let mut copied = 0;
    for f in files.flatten().filter(|f| f.path().is_file()) {
        let target = to.join(f.file_name());
        let size = f.metadata().map(|m| m.len()).ok();
        if std::fs::metadata(&target).ok().map(|m| m.len()) == size {
            continue;
        }
        std::fs::create_dir_all(to)?;
        let partial = target.with_extension("partial");
        std::fs::copy(f.path(), &partial)?;
        std::fs::rename(&partial, &target)?;
        copied += 1;
    }
    Ok(copied)
}

#[derive(Serialize)]
pub struct BackupFile {
    pub(crate) name: String,
    pub(crate) size: u64,
    pub(crate) modified: Option<DateTime<Utc>>,
}

pub(crate) fn backups_in(dir: &Path) -> Vec<BackupFile> {
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
    if crate::sync::online_device().is_some() && !has_postgres() {
        return;
    }
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
    /// Works on the server directly and has no PostgreSQL: nothing to back up from here.
    online_only: bool,
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
    let chosen = plan.usb_id.clone();
    let (usb, gdrive, drives) = tokio::task::spawn_blocking(move || {
        let roots = drive_roots();
        let gdrive = gdrive_root(&roots);
        (
            usb_dir(&roots, chosen.as_deref()).map(|p| p.display().to_string()),
            gdrive.as_ref().map(|p| p.join(USB_FOLDER).display().to_string()),
            drives(&roots, gdrive.as_deref(), chosen.as_deref()),
        )
    })
    .await
    .unwrap_or((None, None, vec![]));
    Ok(Json(Status { last: setting(&s.db, "backup_last").await?, files, pg_dump: pg_dump().display().to_string(),
        online_only: crate::sync::online_device().is_some() && !has_postgres(), plan, usb, gdrive, drives }))
}

pub async fn set_plan(State(s): State<AppState>, user: CurrentUser, Json(p): Json<Plan>) -> Result<StatusCode, ApiError> {
    partner(&user)?;
    let folders: Vec<String> = p.folders.iter().map(|f| f.trim().to_string()).filter(|f| !f.is_empty()).take(2).collect();
    if folders.is_empty() {
        return Err(ApiError::bad("folder_required"));
    }
    if p.every_hours > 24 * 7 || !(1..=3650).contains(&p.keep_days) {
        return Err(ApiError::bad("bad_backup_plan"));
    }
    // The drive is picked with its own button (prepare_usb), so a page opened earlier does not undo it.
    let stored = plan_of(&s.db).await?;
    let plan = Plan { folders, usb: p.usb, usb_drive: stored.usb_drive, usb_id: stored.usb_id, gdrive: p.gdrive, every_hours: p.every_hours, keep_days: p.keep_days };
    save_plan(&s.db, &user, &plan).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn save_plan(db: &PgPool, user: &CurrentUser, plan: &Plan) -> Result<(), ApiError> {
    let mut tx = begin_as(db, user).await?;
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ('backup_plan', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    )
    .bind(serde_json::to_value(plan).unwrap_or_default())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

#[derive(Deserialize)]
pub struct PrepareUsb {
    root: String,
}

/// POST /api/v1/backup/usb: picks the drive for the USB copy, and makes the Pezhohesh-Backup
/// folder on it if it has none yet.
pub async fn prepare_usb(State(s): State<AppState>, user: CurrentUser, Json(p): Json<PrepareUsb>) -> Result<StatusCode, ApiError> {
    partner(&user)?;
    let root = tokio::task::spawn_blocking(move || drive_roots().into_iter().find(|r| r.path.display().to_string() == p.root))
        .await
        .ok()
        .flatten()
        .ok_or(ApiError::bad("drive_not_found"))?;
    let dir = root.path.join(USB_FOLDER);
    tokio::fs::create_dir_all(&dir).await.map_err(|_| ApiError::bad("drive_not_writable"))?;
    let id = match drive_id(&root.path) {
        Some(id) => id,
        None => {
            let id = Uuid::new_v4().to_string();
            tokio::fs::write(dir.join(DRIVE_ID_FILE), &id).await.map_err(|_| ApiError::bad("drive_not_writable"))?;
            id
        }
    };
    let mut plan = plan_of(&s.db).await?;
    plan.usb_drive = Some(root.path.display().to_string());
    plan.usb_id = Some(id);
    plan.usb = true;
    save_plan(&s.db, &user, &plan).await?;
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
    fn usb_drive_choice() {
        let base = std::env::temp_dir().join(format!("pz-usb-{}", std::process::id()));
        let root = |n: &str, removable: bool| Root { path: base.join(n), removable };
        let (d, e, f) = (root("D", false), root("E", true), root("F", true));
        for r in [&d, &e, &f] {
            std::fs::create_dir_all(r.path.join(USB_FOLDER)).unwrap();
        }
        std::fs::write(f.path.join(USB_FOLDER).join(DRIVE_ID_FILE), "stick-1\n").unwrap();
        let roots = vec![d.clone(), e.clone(), f.clone()];
        // Never picked: the first USB drive with the folder, not the laptop's own D:.
        assert_eq!(usb_dir(&roots, None), Some(e.path.join(USB_FOLDER)));
        assert_eq!(usb_dir(&[d.clone()], None), None);
        // Picked: that drive, by its id, under whatever letter.
        assert_eq!(usb_dir(&roots, Some("stick-1")), Some(f.path.join(USB_FOLDER)));
        // Picked but not plugged in: no USB copy rather than a copy somewhere else.
        assert_eq!(usb_dir(&[d.clone(), e.clone()], Some("stick-1")), None);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn names() {
        assert!(is_ours("pezhohesh_1405-08-05_10-30-00.backup"));
        assert!(!is_ours("other_db.backup"));
        let t = chrono::NaiveDate::from_ymd_opt(2026, 10, 27).unwrap().and_hms_opt(10, 30, 0).unwrap();
        let local = t.and_local_timezone(Local).unwrap();
        assert_eq!(file_name(local), "pezhohesh_1405-08-05_10-30-00.backup");
    }
}
