// Hide the extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{Manager, RunEvent};

/// The core API ships inside the installer next to the app (Tauri "externalBin").
/// It is started with the window and stopped when the app closes.
struct Api(Mutex<Option<Child>>);

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
    tauri::Builder::default()
        .setup(|app| {
            app.manage(Api(Mutex::new(start_api())));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Pezhohesh desktop")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(mut child) = app.state::<Api>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
