//! The laptop's own Wi-Fi ("Mobile hotspot") for the phone page: members' phones join it to
//! send their photo and tazkira, without the office Wi-Fi and its access control. Windows
//! shares the laptop's internet over the hotspot too, so the app opens it only for a while
//! and closes it again by itself.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(serde::Serialize, Clone, Default)]
pub struct Hotspot {
    /// This laptop can make a hotspot from its current connection.
    available: bool,
    on: bool,
    clients: u32,
    /// The hotspot's Wi-Fi name and password, for the "join this Wi-Fi" QR code.
    ssid: String,
    password: String,
    /// When the app closes it by itself (seconds since 1970), if the app opened it.
    closes_at: Option<u64>,
    /// Why it is not available or did not start.
    error: Option<String>,
}

/// 0: the app did not open it, or it stays on until closed by hand.
static CLOSES_AT: AtomicU64 = AtomicU64::new(0);

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[tauri::command]
pub async fn hotspot_status() -> Hotspot {
    tauri::async_runtime::spawn_blocking(status).await.unwrap_or_default()
}

/// Opens the hotspot for `minutes` (0: until closed by hand).
#[tauri::command]
pub async fn hotspot_start(minutes: u32) -> Hotspot {
    tauri::async_runtime::spawn_blocking(move || {
        let error = set(true).err();
        CLOSES_AT.store(if minutes > 0 && error.is_none() { now() + minutes as u64 * 60 } else { 0 }, Ordering::SeqCst);
        Hotspot { error, ..status() }
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn hotspot_stop() -> Hotspot {
    tauri::async_runtime::spawn_blocking(|| {
        CLOSES_AT.store(0, Ordering::SeqCst);
        let error = set(false).err();
        Hotspot { error, ..status() }
    })
    .await
    .unwrap_or_default()
}

/// Closes the hotspot when its time is up (checked every 20 seconds while the app is open).
pub fn watch() {
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(20));
        let at = CLOSES_AT.load(Ordering::SeqCst);
        if at != 0 && now() >= at {
            CLOSES_AT.store(0, Ordering::SeqCst);
            let _ = set(false);
        }
    });
}

/// When the app closes, a hotspot it opened for a while is closed too.
pub fn close_if_opened() {
    if CLOSES_AT.swap(0, Ordering::SeqCst) != 0 {
        let _ = set(false);
    }
}

fn status() -> Hotspot {
    let at = CLOSES_AT.load(Ordering::SeqCst);
    let closes_at = (at != 0).then_some(at);
    #[cfg(windows)]
    {
        match win::status() {
            Ok(mut h) => {
                h.closes_at = closes_at.filter(|_| h.on);
                h
            }
            Err(e) => Hotspot { error: Some(e), ..Default::default() },
        }
    }
    #[cfg(not(windows))]
    Hotspot { closes_at, error: Some("not_windows".into()), ..Default::default() }
}

fn set(on: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        win::set(on)
    }
    #[cfg(not(windows))]
    {
        let _ = on;
        Err("not_windows".into())
    }
}

#[cfg(windows)]
mod win {
    use super::Hotspot;
    use windows::Networking::Connectivity::NetworkInformation;
    use windows::Networking::NetworkOperators::{
        NetworkOperatorTetheringManager, TetheringOperationStatus, TetheringOperationalState,
    };

    fn init() {
        // SAFETY: joins this thread to the multithreaded apartment; a second call only says it already is.
        unsafe {
            let _ = windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED);
        }
    }

    /// The hotspot shares the connection the laptop uses for the internet; without one,
    /// any connected network will do.
    fn manager() -> Result<NetworkOperatorTetheringManager, String> {
        init();
        if let Ok(p) = NetworkInformation::GetInternetConnectionProfile() {
            if let Ok(m) = NetworkOperatorTetheringManager::CreateFromConnectionProfile(&p) {
                return Ok(m);
            }
        }
        let all = NetworkInformation::GetConnectionProfiles().map_err(|e| e.message())?;
        for i in 0..all.Size().unwrap_or(0) {
            if let Ok(m) = all.GetAt(i).and_then(|p| NetworkOperatorTetheringManager::CreateFromConnectionProfile(&p)) {
                return Ok(m);
            }
        }
        Err("no_connection".into())
    }

    pub fn status() -> Result<Hotspot, String> {
        let m = manager()?;
        let state = m.TetheringOperationalState().map_err(|e| e.message())?;
        let cfg = m.GetCurrentAccessPointConfiguration().ok();
        Ok(Hotspot {
            available: true,
            on: state == TetheringOperationalState::On,
            clients: m.ClientCount().unwrap_or(0),
            ssid: cfg.as_ref().and_then(|c| c.Ssid().ok()).map(|s| s.to_string()).unwrap_or_default(),
            password: cfg.as_ref().and_then(|c| c.Passphrase().ok()).map(|s| s.to_string()).unwrap_or_default(),
            closes_at: None,
            error: None,
        })
    }

    pub fn set(on: bool) -> Result<(), String> {
        let m = manager()?;
        let state = m.TetheringOperationalState().map_err(|e| e.message())?;
        if (state == TetheringOperationalState::On) == on {
            return Ok(());
        }
        let op = if on { m.StartTetheringAsync() } else { m.StopTetheringAsync() }.map_err(|e| e.message())?;
        let result = op.join().map_err(|e| e.message())?;
        match result.Status().map_err(|e| e.message())? {
            TetheringOperationStatus::Success => Ok(()),
            s => {
                let detail = result.AdditionalErrorMessage().map(|m| m.to_string()).unwrap_or_default();
                Err(format!("status {}: {detail}", s.0))
            }
        }
    }
}
