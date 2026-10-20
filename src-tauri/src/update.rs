//! Updates: on start the UI asks whether a newer release is out (GitHub Releases' latest.json);
//! installing downloads the new installer, checks its signature against the public key built into
//! this app (an update not signed with the release key is refused), runs it and restarts Miek.
//!
//! The updater is only switched on when tauri.conf.json carries the public key (plugins.updater.pubkey);
//! builds without it simply report that updates aren't set up.

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};

static PENDING: Mutex<Option<Update>> = Mutex::new(None);
static GOT: AtomicU64 = AtomicU64::new(0);
static TOTAL: AtomicU64 = AtomicU64::new(0);

/// Is a public key configured? Without one the plugin can't start, so it isn't registered.
pub fn configured<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.config().plugins.0.get("updater").and_then(|u| u.get("pubkey")).and_then(|k| k.as_str()).is_some_and(|k| !k.trim().is_empty())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    version: String,
    current: String,
    notes: Option<String>,
    date: Option<String>,
}

#[tauri::command]
pub fn app_version<R: Runtime>(app: AppHandle<R>) -> String {
    app.package_info().version.to_string()
}

/// A newer release, or None when this is the latest.
#[tauri::command]
pub async fn update_check<R: Runtime>(app: AppHandle<R>) -> Result<Option<Available>, String> {
    if !configured(&app) {
        return Err("Updates aren't set up in this build".into());
    }
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| format!("Couldn't check for updates: {e}"))?;
    let out = update.as_ref().map(|u| Available {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone().filter(|b| !b.trim().is_empty()),
        date: u.date.map(|d| d.date().to_string()),
    });
    *PENDING.lock().unwrap() = update;
    Ok(out)
}

/// Download (signature checked), install and restart. MIEK_UPDATE_DRY_RUN=1 stops after the
/// download and signature check (for testing without installing anything).
#[tauri::command]
pub async fn update_install<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let update = PENDING.lock().unwrap().clone().ok_or("No update to install; check again")?;
    GOT.store(0, Ordering::SeqCst);
    TOTAL.store(0, Ordering::SeqCst);
    let bytes = update
        .download(
            |chunk, total| {
                GOT.fetch_add(chunk as u64, Ordering::SeqCst);
                if let Some(t) = total {
                    TOTAL.store(t, Ordering::SeqCst);
                }
            },
            || {},
        )
        .await
        .map_err(|e| format!("The update couldn't be downloaded or isn't signed by Miek: {e}"))?;
    if std::env::var_os("MIEK_UPDATE_DRY_RUN").is_some() {
        return Ok(());
    }
    // on Windows the installer replaces the app: Miek closes here and the installer starts it again
    update.install(&bytes).map_err(|e| format!("The update couldn't be installed: {e}"))?;
    app.restart();
}

/// Bytes downloaded so far and the total (0 while unknown).
#[tauri::command]
pub fn update_progress() -> (u64, u64) {
    (GOT.load(Ordering::SeqCst), TOTAL.load(Ordering::SeqCst))
}
