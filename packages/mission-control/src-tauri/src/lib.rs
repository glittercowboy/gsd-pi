mod bun_manager;
mod commands;
mod dep_check;

use bun_manager::BunState;
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_window_state::{Builder as WindowStateBuilder, StateFlags};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let bun_state = BunState::new();

    tauri::Builder::default()
        .manage(bun_state)
        .plugin(
            WindowStateBuilder::default()
                .with_state_flags(StateFlags::all())
                .build()
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            // Handle OAuth deep link callbacks (gsd://oauth/callback?code=...&state=...)
            // tauri-plugin-deep-link registers the gsd:// scheme with the OS so the
            // external browser can redirect back to the app after OAuth authorization.
            app.deep_link().on_open_url({
                let app_handle = app.handle().clone();
                move |event: tauri_plugin_deep_link::OpenUrlEvent| {
                    for url in event.urls() {
                        let url_str = url.to_string();
                        if url_str.starts_with("gsd://oauth/callback") {
                            let params = parse_oauth_params(&url_str);
                            let _ = app_handle.emit("oauth-callback", params);
                        }
                    }
                }
            });

            // Run dependency checks before any UI
            let dep_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                dep_check::run_startup_checks(dep_handle).await;
            });

            // Spawn managed Bun server (production only — dev uses beforeDevCommand)
            #[cfg(not(dev))]
            {
                let bun_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    bun_manager::spawn_bun_server(bun_handle).await;
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                #[cfg(not(dev))]
                {
                    let app = window.app_handle().clone();
                    tauri::async_runtime::spawn(async move {
                        bun_manager::kill_bun_server(app).await;
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_folder_dialog,
            commands::get_credential,
            commands::set_credential,
            commands::delete_credential,
            commands::open_external,
            commands::get_platform,
            commands::restart_bun,
            commands::retry_dep_check,
            commands::reveal_path,
            commands::open_new_window,
            check_for_updates,
            install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Check whether a newer app version is available via the configured updater endpoint.
/// Returns true if an update is available, false if not.
#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle) -> Result<bool, String> {
    match app.updater().map_err(|e| e.to_string())?.check().await {
        Ok(Some(_update)) => Ok(true),
        Ok(None) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

/// Download and install the pending update, then restart the app.
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    if let Some(update) = updater.check().await.map_err(|e| e.to_string())? {
        update.download_and_install(|_chunk, _total| {}, || {}).await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Parse `code` and `state` query parameters from a gsd://oauth/callback URL.
/// Returns a serde_json::Value with { "code": "...", "state": "..." }.
fn parse_oauth_params(url: &str) -> serde_json::Value {
    let query = url
        .find('?')
        .map(|i| &url[i + 1..])
        .unwrap_or("");

    let mut code = String::new();
    let mut state = String::new();

    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            match k {
                "code" => code = url_decode(v),
                "state" => state = url_decode(v),
                _ => {}
            }
        }
    }

    serde_json::json!({ "code": code, "state": state })
}

/// Minimal percent-decoding for OAuth callback query params.
fn url_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '%' {
            let h1 = chars.next().unwrap_or('0');
            let h2 = chars.next().unwrap_or('0');
            let hex = format!("{h1}{h2}");
            if let Ok(b) = u8::from_str_radix(&hex, 16) {
                out.push(b as char);
            }
        } else if c == '+' {
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    out
}
