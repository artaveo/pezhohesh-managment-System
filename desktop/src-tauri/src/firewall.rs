//! Lets phones on the office Wi-Fi (or the laptop's own hotspot) reach the phone page of the
//! core API on port 8760. Windows Firewall blocks it until a rule allows it; adding the rule
//! needs administrator rights once, through `--open-firewall` like `--fix-postgres`.

const RULE: &str = "Pezhohesh phone page";
const PORT: &str = "8760";

/// Whether the rule is there. Reading rules needs no administrator rights.
#[tauri::command]
pub fn firewall_open() -> Option<bool> {
    #[cfg(windows)]
    {
        Some(netsh(&["advfirewall", "firewall", "show", "rule", &format!("name={RULE}")]))
    }
    #[cfg(not(windows))]
    None
}

/// Adds the rule as administrator (Windows asks the person first).
#[tauri::command]
pub async fn open_firewall() -> Result<(), String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(|| crate::postgres::win::run_elevated("--open-firewall"))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    Err("not_windows".into())
}

/// `--open-firewall`: the elevated helper. Returns the process exit code.
pub fn helper(args: &[String]) -> Option<i32> {
    if args.get(1).map(String::as_str) != Some("--open-firewall") {
        return None;
    }
    #[cfg(windows)]
    {
        // Replace an older rule of the same name rather than adding a second one.
        netsh(&["advfirewall", "firewall", "delete", "rule", &format!("name={RULE}")]);
        let mut ok = netsh(&[
            "advfirewall", "firewall", "add", "rule", &format!("name={RULE}"), "dir=in", "action=allow",
            "protocol=TCP", &format!("localport={PORT}"), "profile=any",
        ]);
        // The core API itself too, so Windows does not ask about it the first time it listens.
        if let Some(api) = std::env::current_exe().ok().and_then(|e| Some(e.parent()?.join("pezhohesh-api.exe"))) {
            let name = format!("name={RULE} (api)");
            netsh(&["advfirewall", "firewall", "delete", "rule", &name]);
            ok &= netsh(&[
                "advfirewall", "firewall", "add", "rule", &name, "dir=in", "action=allow", "protocol=TCP",
                &format!("localport={PORT}"), &format!("program={}", api.display()), "profile=any",
            ]);
        }
        Some(if ok { 0 } else { 1 })
    }
    #[cfg(not(windows))]
    Some(2)
}

#[cfg(windows)]
fn netsh(args: &[&str]) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("netsh.exe")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .is_ok_and(|o| o.status.success())
}
