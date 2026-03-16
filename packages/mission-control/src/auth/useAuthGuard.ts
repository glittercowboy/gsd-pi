/**
 * useAuthGuard.ts
 *
 * Determines on app load whether the provider picker must be shown.
 *
 * Responsibilities:
 *  1. On mount: check the keychain for an active provider via getActiveProvider().
 *  2. Set up a Tauri event listener for "oauth-callback" events emitted by the
 *     Rust oauth handler. When the callback arrives it calls completeOAuth()
 *     and — on success — transitions to the "authenticated" state automatically.
 *  3. Expose setPendingProvider() so the provider picker can record which
 *     provider is currently mid-flight (needed for the oauth-callback handler
 *     to know which provider to pass to completeOAuth).
 *
 * The oauth-callback listener lives here (not in useTokenRefresh) because it
 * is auth state that must update when the flow completes.
 */

import { useState, useEffect, useRef } from "react";
import { getActiveProvider, completeOAuth } from "./auth-api";

/** Returns true when running inside a Tauri webview. */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthGuardState =
  | { status: "checking" }
  | { status: "authenticated"; provider: string }
  | { status: "needs_picker" };

export interface UseAuthGuardResult {
  state: AuthGuardState;
  setAuthenticated: (provider: string) => void;
  setPendingProvider: (provider: string) => void;
  pendingProvider: string | null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAuthGuard(): UseAuthGuardResult {
  const [state, setState] = useState<AuthGuardState>({ status: "checking" });
  const [pendingProvider, setPendingProvider] = useState<string | null>(null);

  // Keep a ref to pendingProvider so the oauth-callback closure always reads
  // the latest value without stale closure issues.
  const pendingProviderRef = useRef<string | null>(null);
  useEffect(() => {
    pendingProviderRef.current = pendingProvider;
  }, [pendingProvider]);

  const setAuthenticated = (provider: string) => {
    setState({ status: "authenticated", provider });
  };

  useEffect(() => {
    // --- 1. Check keychain on mount ---
    // Non-Tauri (browser dev mode): skip auth gate — no keychain available.
    if (!isTauri()) {
      setState({ status: "authenticated", provider: "dev" });
      return;
    }
    getActiveProvider().then((provider) => {
      if (provider) {
        setState({ status: "authenticated", provider });
      } else {
        setState({ status: "needs_picker" });
      }
    });

    // --- 2. Listen for Tauri oauth-callback event ---
    // This is a no-op in non-Tauri (browser dev) mode.
    let unlistenFn: (() => void) | null = null;

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");

        // Rust emits: { code: string, state: string } as the payload.
        unlistenFn = await listen<{ code: string; state: string }>(
          "oauth-callback",
          async ({ payload }) => {
            const provider = pendingProviderRef.current;
            if (!provider) {
              console.error("[useAuthGuard] oauth-callback received but no pending provider set");
              return;
            }
            const success = await completeOAuth(provider, payload.code, payload.state);
            if (success) {
              setAuthenticated(provider);
              setPendingProvider(null);
            } else {
              console.error("[useAuthGuard] completeOAuth failed for provider:", provider);
              setState({ status: "needs_picker" });
            }
          },
        );
      } catch (e) {
        // Not running in Tauri — silently skip event listener setup.
        // This is expected in browser dev mode.
      }
    })();

    // --- 3. Cleanup on unmount ---
    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, []);

  return { state, setAuthenticated, setPendingProvider, pendingProvider };
}
