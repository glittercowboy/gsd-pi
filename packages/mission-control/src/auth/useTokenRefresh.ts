/**
 * useTokenRefresh.ts
 *
 * Called from App.tsx (or the authenticated shell) after useAuthGuard confirms
 * a provider is set.
 *
 * On mount it silently calls checkAndRefreshToken():
 *  - If tokens are still valid and don't need refreshing: no-op.
 *  - If tokens were refreshed successfully: checked = true, needsReauth = false.
 *  - If tokens are expired and can't be refreshed: needsReauth = true.
 *
 * When needsReauth is true, App.tsx should re-show the provider picker with a
 * "Re-connect [Provider]" heading instead of the first-launch heading.
 */

import { useEffect, useState } from "react";
import { checkAndRefreshToken } from "./auth-api";
import type { RefreshResult } from "./auth-api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenRefreshState {
  checked: boolean;
  needsReauth: boolean;
  provider: string | null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTokenRefresh(): TokenRefreshState {
  const [state, setState] = useState<TokenRefreshState>({
    checked: false,
    needsReauth: false,
    provider: null,
  });

  useEffect(() => {
    checkAndRefreshToken().then((result: RefreshResult) => {
      setState({
        checked: true,
        needsReauth: result.needs_reauth,
        provider: result.provider,
      });
    });
  }, []);

  return state;
}
