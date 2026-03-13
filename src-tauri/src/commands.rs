use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const KEYCHAIN_SERVICE: &str = "gsd-mission-control";

// ---------------------------------------------------------------------------
// Result structs for new OAuth commands
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct StartOAuthResult {
    pub auth_url: String,
    pub state: String,
}

#[derive(serde::Serialize)]
pub struct ProviderStatus {
    pub active_provider: Option<String>,
    pub last_refreshed: Option<String>,
    pub expires_at: Option<String>,
    pub is_expired: bool,
    pub expires_soon: bool,
}

#[derive(serde::Serialize)]
pub struct RefreshResult {
    pub needs_reauth: bool,
    pub refreshed: bool,
    pub provider: Option<String>,
}

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

// ---------------------------------------------------------------------------
// OAuth / credential commands
// ---------------------------------------------------------------------------

/// Return the currently active provider stored in the keychain, or None.
#[tauri::command]
pub async fn get_active_provider() -> Option<String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, "active_provider").ok()?;
    entry.get_password().ok()
}

/// Begin an OAuth flow for the given provider.
/// Generates PKCE + state, stores verifier in managed memory, opens browser, returns URLs.
#[tauri::command]
pub async fn start_oauth(
    app: AppHandle,
    pkce_store: State<'_, crate::PkceStore>,
    provider: String,
) -> Result<StartOAuthResult, String> {
    let pkce = crate::oauth::generate_pkce();

    // 16-byte hex-encoded random state
    let mut state_bytes = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut state_bytes);
    let state: String = state_bytes.iter().map(|b| format!("{b:02x}")).collect();

    // Store verifier in managed in-memory map (no keychain write needed for nonces)
    {
        let mut store = pkce_store.0.lock().map_err(|e| format!("pkce_store lock error: {e}"))?;
        store.insert(state.clone(), pkce.code_verifier.clone());
    }

    let auth_url = match provider.as_str() {
        "anthropic" => crate::oauth::anthropic_auth_url(&pkce, &state),
        "github-copilot" => crate::oauth::github_copilot_auth_url(&pkce, &state),
        other => {
            return Err(format!("unknown provider '{other}'"));
        }
    };

    // Open in system browser (best-effort)
    let _ = app.opener().open_url(&auth_url, None::<String>);

    Ok(StartOAuthResult { auth_url, state })
}

/// Complete an OAuth flow: exchange code, store tokens, write auth.json.
#[tauri::command]
pub async fn complete_oauth(
    pkce_store: State<'_, crate::PkceStore>,
    provider: String,
    code: String,
    state: String,
) -> Result<bool, String> {
    let verifier = {
        let mut store = pkce_store.0.lock().map_err(|e| format!("pkce_store lock error: {e}"))?;
        store.remove(&state).ok_or_else(|| format!("no verifier for state '{state}'"))?
    };

    let token_resp = match crate::oauth::exchange_code(&provider, &code, &verifier).await {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[commands] complete_oauth: exchange_code failed: {e}");
            return Ok(false);
        }
    };

    // Compute expires_at
    let expires_at: Option<String> = token_resp.expires_in.map(|secs| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let ts = now + secs;
        // Format as rough ISO 8601
        format_unix_timestamp(ts)
    });

    // Store access token
    let access_key = format!("{}_access_token", provider.replace('-', "_"));
    if let Ok(e) = keyring::Entry::new(KEYCHAIN_SERVICE, &access_key) {
        let _ = e.set_password(&token_resp.access_token);
    }

    // Store refresh token
    if let Some(ref rt) = token_resp.refresh_token {
        let refresh_key = format!("{}_refresh_token", provider.replace('-', "_"));
        if let Ok(e) = keyring::Entry::new(KEYCHAIN_SERVICE, &refresh_key) {
            let _ = e.set_password(rt);
        }
    }

    // Store expires_at
    if let Some(ref ea) = expires_at {
        let exp_key = format!("{}_expires_at", provider.replace('-', "_"));
        if let Ok(e) = keyring::Entry::new(KEYCHAIN_SERVICE, &exp_key) {
            let _ = e.set_password(ea);
        }
    }

    // Store active_provider
    if let Ok(e) = keyring::Entry::new(KEYCHAIN_SERVICE, "active_provider") {
        let _ = e.set_password(&provider);
    }

    // Write auth.json
    if let Err(e) = crate::oauth::write_auth_json(
        &provider,
        &token_resp.access_token,
        token_resp.refresh_token.as_deref(),
        expires_at.as_deref(),
    ) {
        eprintln!("[commands] complete_oauth: write_auth_json failed: {e}");
    }

    Ok(true)
}

/// Save a static API key for a provider (no OAuth flow needed).
#[tauri::command]
pub async fn save_api_key(provider: String, key: String) -> bool {
    let api_key_name = format!("{}_api_key", provider.replace('-', "_"));
    let entry = match keyring::Entry::new(KEYCHAIN_SERVICE, &api_key_name) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[commands] save_api_key: entry error: {e}");
            return false;
        }
    };
    if let Err(e) = entry.set_password(&key) {
        eprintln!("[commands] save_api_key: set_password error: {e}");
        return false;
    }

    if let Ok(e) = keyring::Entry::new(KEYCHAIN_SERVICE, "active_provider") {
        let _ = e.set_password(&provider);
    }

    if let Err(e) = crate::oauth::write_auth_json(&provider, &key, None, None) {
        eprintln!("[commands] save_api_key: write_auth_json failed: {e}");
    }

    true
}

/// Return current provider status including expiry metadata.
#[tauri::command]
pub async fn get_provider_status() -> ProviderStatus {
    let active_provider = get_credential_sync("active_provider");
    let last_refreshed = active_provider
        .as_deref()
        .and_then(|p| get_credential_sync(&format!("{}_last_refreshed", p.replace('-', "_"))));
    let expires_at = active_provider
        .as_deref()
        .and_then(|p| get_credential_sync(&format!("{}_expires_at", p.replace('-', "_"))));

    let (is_expired, expires_soon) = compute_expiry_flags(expires_at.as_deref());

    ProviderStatus {
        active_provider,
        last_refreshed,
        expires_at,
        is_expired,
        expires_soon,
    }
}

/// Clear all provider credentials and delete auth.json.
#[tauri::command]
pub async fn change_provider() -> bool {
    let keys = [
        "active_provider",
        "anthropic_access_token",
        "anthropic_refresh_token",
        "github_copilot_access_token",
        "anthropic_expires_at",
        "github_copilot_expires_at",
    ];
    for key in &keys {
        if let Ok(e) = keyring::Entry::new(KEYCHAIN_SERVICE, key) {
            let _ = e.delete_credential();
        }
    }
    if let Err(e) = crate::oauth::delete_auth_json() {
        eprintln!("[commands] change_provider: delete_auth_json error: {e}");
    }
    true
}

/// Check token expiry and attempt refresh if within 5 minutes.
#[tauri::command]
pub async fn check_and_refresh_token() -> RefreshResult {
    let provider = match get_credential_sync("active_provider") {
        Some(p) => p,
        None => {
            return RefreshResult {
                needs_reauth: false,
                refreshed: false,
                provider: None,
            }
        }
    };

    let expires_at = get_credential_sync(&format!("{}_expires_at", provider.replace('-', "_")));
    let (is_expired, expires_soon) = compute_expiry_flags(expires_at.as_deref());

    if !is_expired && !expires_soon {
        return RefreshResult {
            needs_reauth: false,
            refreshed: false,
            provider: Some(provider),
        };
    }

    // Attempt refresh
    let refresh_key = format!("{}_refresh_token", provider.replace('-', "_"));
    let refresh_tok = match get_credential_sync(&refresh_key) {
        Some(rt) => rt,
        None => {
            return RefreshResult {
                needs_reauth: true,
                refreshed: false,
                provider: Some(provider),
            }
        }
    };

    match crate::oauth::refresh_token(&provider, &refresh_tok).await {
        Ok(token_resp) => {
            // Update access token
            let access_key = format!("{}_access_token", provider.replace('-', "_"));
            if let Ok(e) = keyring::Entry::new(KEYCHAIN_SERVICE, &access_key) {
                let _ = e.set_password(&token_resp.access_token);
            }

            // Update refresh token if provider returned a new one
            if let Some(ref new_rt) = token_resp.refresh_token {
                if let Ok(e) = keyring::Entry::new(KEYCHAIN_SERVICE, &refresh_key) {
                    let _ = e.set_password(new_rt);
                }
            }

            // Compute and store new expires_at
            let new_expires_at = token_resp.expires_in.map(|secs| {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                format_unix_timestamp(now + secs)
            });

            if let Some(ref ea) = new_expires_at {
                let exp_key = format!("{}_expires_at", provider.replace('-', "_"));
                if let Ok(e) = keyring::Entry::new(KEYCHAIN_SERVICE, &exp_key) {
                    let _ = e.set_password(ea);
                }
            }

            // Update last_refreshed
            let now_str = {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                format_unix_timestamp(now)
            };
            let lr_key = format!("{}_last_refreshed", provider.replace('-', "_"));
            if let Ok(e) = keyring::Entry::new(KEYCHAIN_SERVICE, &lr_key) {
                let _ = e.set_password(&now_str);
            }

            // Update auth.json
            if let Err(e) = crate::oauth::write_auth_json(
                &provider,
                &token_resp.access_token,
                token_resp.refresh_token.as_deref(),
                new_expires_at.as_deref(),
            ) {
                eprintln!("[commands] check_and_refresh_token: write_auth_json failed: {e}");
            }

            RefreshResult {
                needs_reauth: false,
                refreshed: true,
                provider: Some(provider),
            }
        }
        Err(e) => {
            eprintln!("[commands] check_and_refresh_token: refresh failed: {e}");
            RefreshResult {
                needs_reauth: true,
                refreshed: false,
                provider: Some(provider),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn get_credential_sync(key: &str) -> Option<String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, key).ok()?;
    entry.get_password().ok()
}

/// Returns (is_expired, expires_soon) given an ISO 8601 expires_at string.
/// expires_soon = within 5 minutes of now.
fn compute_expiry_flags(expires_at: Option<&str>) -> (bool, bool) {
    let ea = match expires_at {
        Some(s) => s,
        None => return (false, false),
    };

    // Parse ISO 8601 via manual approach (no chrono dep)
    let target_secs = parse_iso8601_to_unix(ea);
    if target_secs == 0 {
        return (false, false);
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let is_expired = now >= target_secs;
    let expires_soon = !is_expired && (target_secs - now) <= 300; // 5 minutes
    (is_expired, expires_soon)
}

/// Format a UNIX timestamp as a basic ISO 8601 string: YYYY-MM-DDTHH:MM:SSZ
fn format_unix_timestamp(secs: u64) -> String {
    // Simple conversion without external deps
    let days_since_epoch = secs / 86400;
    let time_of_day = secs % 86400;

    let hh = time_of_day / 3600;
    let mm = (time_of_day % 3600) / 60;
    let ss = time_of_day % 60;

    // Compute calendar date from days since 1970-01-01
    let (year, month, day) = days_to_ymd(days_since_epoch as i64);

    format!("{year:04}-{month:02}-{day:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

/// Parse a basic ISO 8601 timestamp (YYYY-MM-DDTHH:MM:SSZ) to UNIX seconds.
/// Returns 0 on parse failure.
fn parse_iso8601_to_unix(s: &str) -> u64 {
    // Expected format: YYYY-MM-DDTHH:MM:SSZ (at minimum 19 chars)
    let bytes = s.as_bytes();
    if bytes.len() < 19 {
        return 0;
    }
    let year: u64 = parse_digits(&s[0..4]);
    let month: u64 = parse_digits(&s[5..7]);
    let day: u64 = parse_digits(&s[8..10]);
    let hour: u64 = parse_digits(&s[11..13]);
    let min: u64 = parse_digits(&s[14..16]);
    let sec: u64 = parse_digits(&s[17..19]);

    if year == 0 || month == 0 || day == 0 {
        return 0;
    }

    // Days from 1970-01-01 to given date
    let days = ymd_to_days(year as i64, month as i64, day as i64);
    (days as u64) * 86400 + hour * 3600 + min * 60 + sec
}

fn parse_digits(s: &str) -> u64 {
    s.chars().fold(0u64, |acc, c| {
        if c.is_ascii_digit() {
            acc * 10 + (c as u64 - '0' as u64)
        } else {
            acc
        }
    })
}

/// Convert days since epoch (1970-01-01) to (year, month, day).
fn days_to_ymd(mut z: i64) -> (i64, i64, i64) {
    z += 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Convert (year, month, day) to days since epoch (1970-01-01).
fn ymd_to_days(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}
