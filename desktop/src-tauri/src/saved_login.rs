//! "Remember my password" on the sign-in screen. The username and password are kept in
//! Windows Credential Manager (encrypted for this Windows account), never in a file.

#[derive(serde::Serialize, serde::Deserialize)]
pub struct SavedLogin {
    username: String,
    password: String,
}

#[cfg(windows)]
fn entry() -> Option<keyring::Entry> {
    keyring::Entry::new("Pezhohesh", "saved-login").ok()
}

#[tauri::command]
pub fn saved_login() -> Option<SavedLogin> {
    #[cfg(windows)]
    {
        entry()?.get_password().ok().and_then(|s| serde_json::from_str(&s).ok())
    }
    #[cfg(not(windows))]
    None
}

#[tauri::command]
pub fn save_login(username: String, password: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let json = serde_json::to_string(&SavedLogin { username, password }).map_err(|e| e.to_string())?;
        entry().ok_or("no credential store")?.set_password(&json).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (username, password);
        Err("not supported".into())
    }
}

#[tauri::command]
pub fn forget_login() {
    #[cfg(windows)]
    if let Some(e) = entry() {
        let _ = e.delete_credential();
    }
}
