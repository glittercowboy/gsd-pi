/**
 * auth-api.ts — TypeScript bridge to all Rust OAuth/keychain commands.
 *
 * All functions guard against non-Tauri (browser dev mode) execution via
 * isTauri(). When not in Tauri, safe defaults are returned so the app does
 * not crash during local development.
 */

// ---------------------------------------------------------------------------
// Tauri environment detection
// ---------------------------------------------------------------------------

/** Returns true when running inside a Tauri webview. */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

/**
 * Thin invoke wrapper that:
 * 1. Dynamically imports @tauri-apps/api/core so bundlers can tree-shake it.
 * 2. Throws a clear error if called outside Tauri.
 */
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error("Not running in Tauri");
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface StartOAuthResult {
  auth_url: string;
  state: string;
}

export interface ProviderStatus {
  active_provider: string | null;
  last_refreshed: string | null;
  expires_at: string | null;
  is_expired: boolean;
  expires_soon: boolean;
}

export interface RefreshResult {
  needs_reauth: boolean;
  refreshed: boolean;
  provider: string | null;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Returns the currently stored provider name, or null when no provider is
 * configured (first launch / after sign-out).
 *
 * Non-Tauri fallback: null — the provider picker will be shown during dev.
 */
export async function getActiveProvider(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string | null>("get_active_provider");
  } catch (e) {
    console.error("[auth-api] getActiveProvider:", e);
    return null;
  }
}

/**
 * Initiates an OAuth flow for the given provider.
 * Returns the URL to open in the system browser and a CSRF state token.
 */
export async function startOAuth(provider: string): Promise<StartOAuthResult> {
  try {
    return await invoke<StartOAuthResult>("start_oauth", { provider });
  } catch (e) {
    console.error("[auth-api] startOAuth:", e);
    return { auth_url: "", state: "" };
  }
}

/**
 * Exchanges the OAuth callback code + state for tokens and persists them to
 * the OS keychain.
 *
 * Returns true on success.
 */
export async function completeOAuth(
  provider: string,
  code: string,
  state: string,
): Promise<boolean> {
  try {
    return await invoke<boolean>("complete_oauth", { provider, code, state });
  } catch (e) {
    console.error("[auth-api] completeOAuth:", e);
    return false;
  }
}

/**
 * Stores a raw API key in the OS keychain for providers that use key-based
 * auth rather than OAuth.
 *
 * Returns true on success.
 */
export async function saveApiKey(provider: string, key: string): Promise<boolean> {
  try {
    return await invoke<boolean>("save_api_key", { provider, key });
  } catch (e) {
    console.error("[auth-api] saveApiKey:", e);
    return false;
  }
}

/**
 * Reads the current provider status (expiry, refresh timestamps, etc.) from
 * the keychain.
 *
 * Non-Tauri fallback: a zeroed-out struct so callers can safely destructure.
 */
export async function getProviderStatus(): Promise<ProviderStatus> {
  const fallback: ProviderStatus = {
    active_provider: null,
    last_refreshed: null,
    expires_at: null,
    is_expired: false,
    expires_soon: false,
  };
  if (!isTauri()) return fallback;
  try {
    return await invoke<ProviderStatus>("get_provider_status");
  } catch (e) {
    console.error("[auth-api] getProviderStatus:", e);
    return fallback;
  }
}

/**
 * Clears the stored provider credentials so the user can pick a new one.
 *
 * Returns true on success.
 */
export async function changeProvider(): Promise<boolean> {
  try {
    return await invoke<boolean>("change_provider");
  } catch (e) {
    console.error("[auth-api] changeProvider:", e);
    return false;
  }
}

/**
 * Checks whether stored tokens are about to expire and silently refreshes
 * them if possible. Returns a struct indicating whether re-auth is required.
 *
 * Non-Tauri fallback: { needs_reauth: false, refreshed: false, provider: null }
 * so the app does not show a re-auth prompt in dev mode.
 */
export async function checkAndRefreshToken(): Promise<RefreshResult> {
  const fallback: RefreshResult = { needs_reauth: false, refreshed: false, provider: null };
  if (!isTauri()) return fallback;
  try {
    return await invoke<RefreshResult>("check_and_refresh_token");
  } catch (e) {
    console.error("[auth-api] checkAndRefreshToken:", e);
    return fallback;
  }
}
