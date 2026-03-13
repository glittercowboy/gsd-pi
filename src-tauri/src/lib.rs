mod bun_manager;
mod commands;
mod dep_check;
mod oauth;

use bun_manager::BunState;
use tauri::{Emitter, Manager};

/// In-memory store for PKCE verifiers keyed by OAuth state token.
/// Avoids writing short-lived nonces to the OS keychain.
pub struct PkceStore(pub std::sync::Mutex<std::collections::HashMap<String, String>>);
use tauri_plugin_window_state::{Builder as WindowStateBuilder, StateFlags};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let bun_state = BunState::new();
    let pkce_store = PkceStore(std::sync::Mutex::new(std::collections::HashMap::new()));

    tauri::Builder::default()
        .manage(bun_state)
        .manage(pkce_store)
        .plugin(
            WindowStateBuilder::default()
                .with_state_flags(StateFlags::all())
                .build()
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .register_uri_scheme_protocol("gsd", |app, request| {
            let url = request.uri().to_string();
            if url.starts_with("gsd://oauth/callback") {
                let params = parse_oauth_params(&url);
                let _ = app.app_handle().emit("oauth-callback", params);
            }
            tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", "text/html")
                .body(b"<html><body>Authentication complete. Return to GSD Mission Control.</body></html>".to_vec())
                .unwrap()
        })
        .setup(|app| {
            // Run dependency checks before any UI
            let dep_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                dep_check::run_startup_checks(dep_handle).await;
            });

            // Spawn managed Bun server
            let bun_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                bun_manager::spawn_bun_server(bun_handle).await;
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    bun_manager::kill_bun_server(app).await;
                });
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
            commands::get_active_provider,
            commands::start_oauth,
            commands::complete_oauth,
            commands::save_api_key,
            commands::get_provider_status,
            commands::change_provider,
            commands::check_and_refresh_token,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
