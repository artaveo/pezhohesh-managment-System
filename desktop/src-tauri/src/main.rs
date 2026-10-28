// Hide the extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod firewall;
mod hotspot;
mod postgres;
mod saved_login;

use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Manager, RunEvent};

/// The core API ships inside the installer next to the app (Tauri "externalBin").
/// It is started with the window and stopped when the app closes.
struct Api(Mutex<Option<Child>>);

/// Called by the offline screen while it waits: starts PostgreSQL if it was stopped (when
/// Windows allows it), and the API again if it is not running. True when a new API started.
#[tauri::command]
fn restart_api(api: tauri::State<'_, Api>) -> bool {
    keep_running(&api)
}

/// From the offline screen ("database password is wrong"): writes the PostgreSQL password
/// into `%APPDATA%\Pezhohesh\database-url.txt`, keeping the rest of the address that is
/// there, and starts the API again so it connects with it. The password is never logged.
#[tauri::command]
fn set_database_password(api: tauri::State<'_, Api>, password: String) -> Result<(), String> {
    let dir = std::path::Path::new(&std::env::var_os("APPDATA").ok_or("no_appdata")?).join("Pezhohesh");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("database-url.txt");
    let old = std::fs::read_to_string(&file).ok().and_then(|s| s.lines().next().map(|l| l.trim().to_string()));
    std::fs::write(&file, with_password(old.as_deref(), &password)).map_err(|e| e.to_string())?;
    let mut child = api.0.lock().unwrap();
    if let Some(mut c) = child.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    *child = start_api();
    Ok(())
}

/// From the offline screen when the central server cannot be reached: this computer goes
/// back to its own database (it stops working on the server directly) and the API starts
/// again on it. See api/src/sync.rs.
#[tauri::command]
fn use_local_database(api: tauri::State<'_, Api>) -> Result<(), String> {
    let dir = std::path::Path::new(&std::env::var_os("APPDATA").ok_or("no_appdata")?).join("Pezhohesh");
    let _ = std::fs::remove_file(dir.join("online-device.txt"));
    let mut child = api.0.lock().unwrap();
    if let Some(mut c) = child.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    *child = start_api();
    Ok(())
}

/// The database address with `password` in it: the one there with its password replaced,
/// or the usual local one.
fn with_password(old: Option<&str>, password: &str) -> String {
    let encoded: String = password
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect();
    let rest = old.and_then(|u| u.strip_prefix("postgres://").or_else(|| u.strip_prefix("postgresql://")));
    match rest.and_then(|r| r.rsplit_once('@')) {
        Some((userinfo, host)) => {
            let user = userinfo.split(':').next().unwrap_or("postgres");
            format!("postgres://{user}:{encoded}@{host}")
        }
        None => format!("postgres://postgres:{encoded}@localhost:5432/pezhohesh"),
    }
}

/// Set when the app is closing, so the watchdog does not start the API again.
static CLOSING: AtomicBool = AtomicBool::new(false);

fn keep_running(api: &Api) -> bool {
    if CLOSING.load(Ordering::SeqCst) {
        return false;
    }
    postgres::start_if_stopped();
    let mut child = api.0.lock().unwrap();
    if CLOSING.load(Ordering::SeqCst) {
        return false;
    }
    if let Some(c) = child.as_mut() {
        if matches!(c.try_wait(), Ok(None)) {
            return false;
        }
        *child = None;
    }
    *child = start_api();
    child.is_some()
}

/// The end of the API's log, shown under "details" on the offline screen.
#[tauri::command]
fn api_log() -> String {
    let Some(dir) = std::env::var_os("APPDATA") else { return String::new() };
    let text = std::fs::read_to_string(std::path::Path::new(&dir).join("Pezhohesh").join("api.log")).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(15)..].join("\n")
}

/// The Windows folder picker (opens at "This PC"), for the backup folders. None when cancelled.
#[tauri::command]
async fn pick_folder(window: tauri::WebviewWindow, start: Option<String>) -> Option<String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let mut dialog = rfd::FileDialog::new().set_title("انتخاب پوشه").set_parent(&window);
            if let Some(dir) = start.filter(|d| std::path::Path::new(d).is_dir()) {
                dialog = dialog.set_directory(dir);
            }
            dialog.pick_folder()
        })
        .await
        .ok()
        .flatten()
        .map(|p| p.display().to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (window, start);
        None
    }
}

fn start_api() -> Option<Child> {
    // An API that is already running (an earlier window, or one started by hand) is reused.
    if std::net::TcpStream::connect(("127.0.0.1", 8750)).is_ok() {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let name = if cfg!(windows) { "pezhohesh-api.exe" } else { "pezhohesh-api" };
    let mut path = exe.parent()?.join(name);
    if cfg!(debug_assertions) {
        // `tauri dev` overwrites the sidecar on every rebuild, which fails while it runs.
        // Run a copy instead so rebuilds can replace the original.
        let copy = std::env::temp_dir().join(format!("dev-{name}"));
        if std::fs::copy(&path, &copy).is_ok() {
            path = copy;
        }
    }
    let mut cmd = Command::new(&path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.spawn() {
        Ok(child) => {
            #[cfg(windows)]
            kill_with_app(&child);
            Some(child)
        }
        Err(e) => {
            // In development the API may already be running on its own; the app still opens.
            eprintln!("could not start {}: {e}", path.display());
            None
        }
    }
}

/// Ties the API to this app's lifetime: Windows ends it when the app's process ends for
/// any reason (closed, crashed, or restarted by `tauri dev`), so it never lingers on :8750.
#[cfg(windows)]
fn kill_with_app(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    // SAFETY: plain Win32 calls on handles we own; the job handle is deliberately never
    // closed, so the OS closes it (and kills the API) only when this process exits.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        AssignProcessToJobObject(job, child.as_raw_handle() as _);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(code) = postgres::helper(&args).or_else(|| firewall::helper(&args)) {
        std::process::exit(code);
    }
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            saved_login::saved_login,
            saved_login::save_login,
            saved_login::forget_login,
            postgres::postgres_service,
            postgres::fix_postgres,
            restart_api,
            set_database_password,
            use_local_database,
            api_log,
            pick_folder,
            firewall::firewall_open,
            firewall::open_firewall,
            hotspot::hotspot_status,
            hotspot::hotspot_start,
            hotspot::hotspot_stop
        ])
        .setup(|app| {
            postgres::start_if_stopped();
            hotspot::watch();
            app.manage(Api(Mutex::new(start_api())));
            // The API can stop while the app stays open (for example around sleep and
            // resume); bring it back within seconds instead of waiting for "try again".
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(5));
                keep_running(&handle.state::<Api>());
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Pezhohesh desktop")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                CLOSING.store(true, Ordering::SeqCst);
                hotspot::close_if_opened();
                if let Some(mut child) = app.state::<Api>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::with_password;

    #[test]
    fn database_password_goes_into_the_address() {
        assert_eq!(with_password(None, "abc"), "postgres://postgres:abc@localhost:5432/pezhohesh");
        assert_eq!(with_password(Some("postgres://postgres:old@localhost:5433/pz"), "n@w:1/"), "postgres://postgres:n%40w%3A1%2F@localhost:5433/pz");
        assert_eq!(with_password(Some("postgres://me@localhost/pezhohesh"), "x y"), "postgres://me:x%20y@localhost/pezhohesh");
        assert_eq!(with_password(Some("junk"), "a"), "postgres://postgres:a@localhost:5432/pezhohesh");
    }
}
