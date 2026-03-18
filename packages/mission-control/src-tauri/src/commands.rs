use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const KEYCHAIN_SERVICE: &str = "gsd-mission-control";

/// Open a native folder picker dialog. Returns the selected path or None if cancelled.
#[tauri::command]
pub async fn open_folder_dialog(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|p| p.to_string())
}

/// Read a credential from the OS keychain.
/// Returns None if the key does not exist or access is denied.
#[tauri::command]
pub async fn get_credential(key: String) -> Option<String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &key).ok()?;
    entry.get_password().ok()
}

/// Write a credential to the OS keychain.
/// Returns true on success, false on failure.
#[tauri::command]
pub async fn set_credential(key: String, value: String) -> bool {
    let entry = match keyring::Entry::new(KEYCHAIN_SERVICE, &key) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[commands] set_credential error creating entry: {e}");
            return false;
        }
    };
    match entry.set_password(&value) {
        Ok(_) => true,
        Err(e) => {
            eprintln!("[commands] set_credential error: {e}");
            false
        }
    }
}

/// Delete a credential from the OS keychain.
/// Returns true on success or if key did not exist, false on error.
#[tauri::command]
pub async fn delete_credential(key: String) -> bool {
    let entry = match keyring::Entry::new(KEYCHAIN_SERVICE, &key) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[commands] delete_credential error: {e}");
            return false;
        }
    };
    match entry.delete_credential() {
        Ok(_) => true,
        Err(keyring::Error::NoEntry) => true, // not found = already deleted
        Err(e) => {
            eprintln!("[commands] delete_credential error: {e}");
            false
        }
    }
}

/// Reveal a file or directory in the native file manager (Finder/Explorer).
/// Falls back to opening the path as a file:// URL if reveal_item_in_dir is unavailable.
/// Returns true on success.
#[tauri::command]
pub async fn reveal_path(app: AppHandle, path: String) -> bool {
    app.opener()
        .reveal_item_in_dir(&path)
        .map(|_| true)
        .unwrap_or_else(|_| {
            // Fallback: open directory itself in file manager
            let url = format!("file://{}", path);
            app.opener()
                .open_url(url, None::<String>)
                .map(|_| true)
                .unwrap_or(false)
        })
}

/// Open a URL in the system default browser.
/// Returns true on success.
#[tauri::command]
pub async fn open_external(app: AppHandle, url: String) -> bool {
    app.opener()
        .open_url(&url, None::<String>)
        .map(|_| true)
        .unwrap_or_else(|e| {
            eprintln!("[commands] open_external error: {e}");
            false
        })
}

/// Return the current platform as a lowercase string.
#[tauri::command]
pub fn get_platform() -> String {
    #[cfg(target_os = "macos")]
    return "macos".to_string();
    #[cfg(target_os = "windows")]
    return "windows".to_string();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return "linux".to_string();
}

/// Kill and respawn the managed Bun server process.
/// Returns true on success.
#[tauri::command]
pub async fn restart_bun(app: AppHandle) -> bool {
    crate::bun_manager::restart_bun(app).await;
    true
}

/// Re-run dependency checks (called from dep_screen.html Retry button).
#[tauri::command]
pub async fn retry_dep_check(app: AppHandle) -> bool {
    crate::dep_check::run_startup_checks(app).await;
    true
}

/// Open a new Mission Control window (independent project state).
#[tauri::command]
pub async fn open_new_window(app: AppHandle) -> Result<(), String> {
    let label = format!(
        "window-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    tauri::WebviewWindowBuilder::new(
        &app,
        label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("GSD Mission Control")
    .inner_size(1280.0, 800.0)
    .min_inner_size(1024.0, 640.0)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

