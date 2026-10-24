// Hide the extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{Manager, RunEvent};

/// The core API ships inside the installer next to the app (Tauri "externalBin").
/// It is started with the window and stopped when the app closes.
struct Api(Mutex<Option<Child>>);

fn start_api() -> Option<Child> {
    let exe = std::env::current_exe().ok()?;
    let name = if cfg!(windows) { "pezhohesh-api.exe" } else { "pezhohesh-api" };
    let path = exe.parent()?.join(name);
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
