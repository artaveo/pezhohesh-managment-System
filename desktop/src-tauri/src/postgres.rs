//! Keeps the local PostgreSQL service running. Without it the core API has no database,
//! and the person would have to open Windows "Services" and start it by hand.
//!
//! The app first tries to start a stopped service itself. If Windows does not allow that
//! (the default for a normal user), the "start PostgreSQL" button runs this same program
//! once as administrator with `--fix-postgres`, which starts the service and also sets it
//! up so the problem does not come back: it starts with Windows, Windows restarts it if it
//! crashes, and from then on the app may start it without asking for administrator rights.

#[derive(serde::Serialize, Clone)]
pub struct Service {
    name: String,
    running: bool,
    /// Starting or stopping right now.
    pending: bool,
    auto_start: bool,
}

#[tauri::command]
pub fn postgres_service() -> Option<Service> {
    #[cfg(windows)]
    {
        win::find()
    }
    #[cfg(not(windows))]
    None
}

/// Starts PostgreSQL with administrator rights (Windows asks the person first) and fixes its setup.
#[tauri::command]
pub async fn fix_postgres() -> Result<(), String> {
    #[cfg(windows)]
    {
        let name = win::find().ok_or("not_installed")?.name;
        tauri::async_runtime::spawn_blocking(move || win::run_elevated(&format!("--fix-postgres {name}")))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    Err("not_installed".into())
}

/// Starts a stopped PostgreSQL service if this Windows account is allowed to; quietly does nothing otherwise.
pub fn start_if_stopped() {
    #[cfg(windows)]
    if let Some(s) = win::find() {
        if !s.running && !s.pending {
            win::start(&s.name);
        }
    }
}

/// `--fix-postgres <service>`: the elevated helper. Returns the process exit code.
pub fn helper(args: &[String]) -> Option<i32> {
    if args.get(1).map(String::as_str) != Some("--fix-postgres") {
        return None;
    }
    #[cfg(windows)]
    {
        Some(args.get(2).map_or(2, |name| win::fix(name)))
    }
    #[cfg(not(windows))]
    Some(2)
}

#[cfg(windows)]
pub(crate) mod win {
    use super::Service;
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
    use windows_sys::Win32::System::Services::*;
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SEE_MASK_NO_CONSOLE, SHELLEXECUTEINFOW};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const ERROR_CANCELLED: u32 = 1223;
    /// Start and query rights for interactive users, added to the service's permissions.
    const USERS_MAY_START: &str = "(A;;RPLC;;;IU)";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    /// The PostgreSQL installer names its service after the version: postgresql-x64-17.
    pub fn find() -> Option<Service> {
        // SAFETY: plain service-manager calls; every handle opened here is closed here.
        unsafe {
            let scm = OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT);
            if scm.is_null() {
                return None;
            }
            let mut found = None;
            for v in (9..=20).rev() {
                for name in [format!("postgresql-x64-{v}"), format!("postgresql-{v}")] {
                    let svc = OpenServiceW(scm, wide(&name).as_ptr(), SERVICE_QUERY_STATUS | SERVICE_QUERY_CONFIG);
                    if svc.is_null() {
                        continue;
                    }
                    let mut status: SERVICE_STATUS = std::mem::zeroed();
                    let state = if QueryServiceStatus(svc, &mut status) != 0 { status.dwCurrentState } else { 0 };
                    // QUERY_SERVICE_CONFIGW is followed by its strings; 8 KB is far more than needed.
                    let mut buf = vec![0u64; 1024];
                    let mut needed = 0;
                    let cfg = buf.as_mut_ptr() as *mut QUERY_SERVICE_CONFIGW;
                    let auto_start = QueryServiceConfigW(svc, cfg, 8192, &mut needed) != 0 && (*cfg).dwStartType == SERVICE_AUTO_START;
                    CloseServiceHandle(svc);
                    found = Some(Service {
                        name,
                        running: state == SERVICE_RUNNING,
                        pending: state != SERVICE_RUNNING && state != SERVICE_STOPPED,
                        auto_start,
                    });
                    break;
                }
                if found.is_some() {
                    break;
                }
            }
            CloseServiceHandle(scm);
            found
        }
    }

    /// Asks Windows to start the service; true when it accepted (or it is already running).
    pub fn start(name: &str) -> bool {
        // SAFETY: as in `find`.
        unsafe {
            let scm = OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT);
            if scm.is_null() {
                return false;
            }
            let svc = OpenServiceW(scm, wide(name).as_ptr(), SERVICE_START);
            let ok = !svc.is_null() && (StartServiceW(svc, 0, std::ptr::null()) != 0 || GetLastError() == 1056); // already running
            if !svc.is_null() {
                CloseServiceHandle(svc);
            }
            CloseServiceHandle(scm);
            ok
        }
    }

    /// Runs `<this exe> <params>` (`--fix-postgres <name>`, `--open-firewall`) as administrator and waits for it.
    pub fn run_elevated(params: &str) -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let file = wide(&exe.to_string_lossy());
        let params = wide(params);
        let verb = wide("runas");
        // SAFETY: the info struct and the strings it points to outlive the call; the
        // process handle it returns is closed below.
        unsafe {
            let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
            info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NO_CONSOLE;
            info.lpVerb = verb.as_ptr();
            info.lpFile = file.as_ptr();
            info.lpParameters = params.as_ptr();
            info.nShow = 0; // SW_HIDE
            if ShellExecuteExW(&mut info) == 0 {
                return Err(if GetLastError() == ERROR_CANCELLED { "cancelled".into() } else { "elevation_failed".into() });
            }
            if info.hProcess.is_null() {
                return Ok(());
            }
            WaitForSingleObject(info.hProcess, INFINITE);
            let mut code = 1;
            GetExitCodeProcess(info.hProcess, &mut code);
            CloseHandle(info.hProcess);
            if code == 0 { Ok(()) } else { Err("start_failed".into()) }
        }
    }

    fn sc(args: &[&str]) -> Option<String> {
        let out = Command::new("sc.exe").args(args).creation_flags(CREATE_NO_WINDOW).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// The elevated part: set the service up for good, then start it. Exit code 0 when it runs.
    pub fn fix(name: &str) -> i32 {
        // Start with Windows.
        sc(&["config", name, "start=", "auto"]);
        // If it crashes, Windows starts it again after 5 s, 15 s and 60 s (counter resets daily).
        sc(&["failure", name, "reset=", "86400", "actions=", "restart/5000/restart/15000/restart/60000"]);
        // Let this computer's users start it, so next time the app can do it without asking.
        if let Some(sddl) = sc(&["sdshow", name]).map(|s| s.trim().to_string()) {
            if !sddl.contains(USERS_MAY_START) {
                if let Some(at) = sddl.find("D:").and_then(|d| sddl[d..].find('(').map(|p| d + p)) {
                    let updated = format!("{}{USERS_MAY_START}{}", &sddl[..at], &sddl[at..]);
                    sc(&["sdset", name, &updated]);
                }
            }
        }
        if !start(name) {
            return 1;
        }
        // Wait up to 30 s for it to be running.
        for _ in 0..60 {
            if find().is_some_and(|s| s.running) {
                return 0;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        1
    }
}
