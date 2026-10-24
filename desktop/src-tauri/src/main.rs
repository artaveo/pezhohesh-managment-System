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
        Ok(child) => Some(child),
        Err(e) => {
            // In development the API may already be running on its own; the app still opens.
            eprintln!("could not start {}: {e}", path.display());
            None
        }
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
