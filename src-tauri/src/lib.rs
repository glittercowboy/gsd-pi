mod bun_manager;
mod commands;
mod dep_check;

use bun_manager::BunState;
use tauri_plugin_window_state::{Builder as WindowStateBuilder, StateFlags};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let bun_state = BunState::new();

    tauri::Builder::default()
        .manage(bun_state)
        .plugin(
            WindowStateBuilder::default()
                .with_state_flags(StateFlags::ALL)
                .build()
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .register_uri_scheme_protocol("gsd", |_app, request| {
            // Stub: full OAuth callback handling implemented in a later phase.
            // Tauri requires gsd:// to be registered here (not in tauri.conf.json)
            // so the OS registers the protocol on install.
            tauri::http::Response::builder()
                .status(200)
                .body(Vec::new())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
