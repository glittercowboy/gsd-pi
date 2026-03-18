use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// Holds the Bun server child process handle.
pub struct BunState {
    pub child: Mutex<Option<Child>>,
}

impl BunState {
    pub fn new() -> Self {
        BunState {
            child: Mutex::new(None),
        }
    }
}

/// Resolve the packages/mission-control directory regardless of where tauri was invoked from.
/// - From packages/mission-control/ (typical `tauri dev`): return cwd as-is
/// - From packages/mission-control/src-tauri/ : go up one level
/// - From repo root (e.g. workspace scripts): append packages/mission-control
fn resolve_mc_dir() -> std::path::PathBuf {
    if let Ok(cwd) = std::env::current_dir() {
        if cwd.ends_with("src-tauri") {
            return cwd.parent().unwrap_or(&cwd).to_path_buf();
        }
        if cwd.file_name().map(|n| n == "mission-control").unwrap_or(false) {
            return cwd;
        }
        return cwd.join("packages").join("mission-control");
    }
    std::path::PathBuf::from("packages/mission-control")
}

/// Spawn the Bun server. Emits `bun-started` to all windows when ready.
/// Watches the process and emits `bun-crashed` if it exits unexpectedly.
pub async fn spawn_bun_server(app: AppHandle) {
    let mc_dir = resolve_mc_dir();

    #[cfg(target_os = "windows")]
    let bun_bin = "bun.exe";
    #[cfg(not(target_os = "windows"))]
    let bun_bin = "bun";

    let result = Command::new(bun_bin)
        .args(["run", "--cwd"])
        .arg(&mc_dir)
        .arg("dev")
        .spawn();

    match result {
        Ok(child) => {
            // Store handle in managed state
            if let Some(state) = app.try_state::<BunState>() {
                let mut guard = state.child.lock().unwrap();
                *guard = Some(child);
            }
            // Notify frontend
            let _ = app.emit("bun-started", ());

            // Watch for unexpected exit in background
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                watch_bun_process(app2).await;
            });
        }
        Err(e) => {
            eprintln!("[bun_manager] Failed to spawn Bun: {e}");
            let _ = app.emit("bun-crashed", format!("Failed to start: {e}"));
        }
    }
}

/// Poll the child process every 2 seconds. If it exits, emit `bun-crashed`.
async fn watch_bun_process(app: AppHandle) {
    loop {
        std::thread::sleep(std::time::Duration::from_secs(2));

        if let Some(state) = app.try_state::<BunState>() {
            let mut guard = state.child.lock().unwrap();
            if let Some(child) = guard.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        // Process exited — emit crash event
                        *guard = None;
                        drop(guard);
                        let msg = format!("Bun server exited with status: {status}");
                        eprintln!("[bun_manager] {msg}");
                        let _ = app.emit("bun-crashed", msg);
                        return;
                    }
                    Ok(None) => {} // still running
                    Err(e) => {
                        eprintln!("[bun_manager] Error checking process: {e}");
                    }
                }
            }
        }
    }
}

/// Kill the Bun server cleanly. Called on window close.
pub async fn kill_bun_server(app: AppHandle) {
    if let Some(state) = app.try_state::<BunState>() {
        let mut guard = state.child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            // Send SIGTERM (or TerminateProcess on Windows)
            let _ = child.kill();
            let _ = child.wait();
            eprintln!("[bun_manager] Bun server killed cleanly.");
        }
        *guard = None;
    }
}

/// Kill and respawn the Bun server. Called via IPC restart_bun command.
pub async fn restart_bun(app: AppHandle) {
    kill_bun_server(app.clone()).await;
    // Brief delay to let the port free
    std::thread::sleep(std::time::Duration::from_millis(500));
    spawn_bun_server(app).await;
}
