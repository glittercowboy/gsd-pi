/**
 * Client-side auth token management.
 *
 * The web server generates a random bearer token at launch and passes it to
 * the browser via the URL fragment (e.g. `http://127.0.0.1:3000/#token=<hex>`).
 * Fragments are never sent in HTTP requests or logged by servers/proxies,
 * keeping the token local to the machine.
 *
 * On first load this module extracts the token from the fragment, persists
 * it to localStorage (so it survives page refreshes and is accessible from
 * all tabs on the same origin), and clears the fragment from the address bar.
 * All subsequent API calls attach the token via the `Authorization: Bearer`
 * header.
 *
 * localStorage is shared across all tabs on the same origin. Because each
 * GSD instance binds to a unique random port, the origin already scopes
 * the token to that instance — no additional namespacing is needed.
 *
 * For EventSource (SSE), which cannot send custom headers, the token is
 * appended as a `?_token=` query parameter instead.
 */

const AUTH_STORAGE_KEY = "gsd-auth-token"

let cachedToken: string | null = null

/**
 * Extract the auth token from the URL fragment on first call, then return
 * the cached value. Falls back to localStorage so the token survives
 * page refreshes and is available to all tabs on the same origin.
 * Clears the fragment from the address bar after extraction.
 */
export function getAuthToken(): string | null {
  if (cachedToken !== null) return cachedToken

  if (typeof window === "undefined") return null

  // 1. Try the URL fragment (initial page load from gsd --web)
  const hash = window.location.hash
  if (hash) {
    const match = hash.match(/token=([a-fA-F0-9]+)/)
    if (match) {
      cachedToken = match[1]
      // Persist to localStorage so the token survives page refreshes and
      // is available to other tabs on the same origin (same GSD instance).
      try {
        localStorage.setItem(AUTH_STORAGE_KEY, cachedToken)
      } catch {
        // Storage unavailable (e.g. private browsing quota exceeded) — the
        // in-memory cache still works for the current page lifecycle.
      }
      // Clear the fragment so the token isn't visible in the address bar
      // or leaked via the Referer header on external navigations.
      window.history.replaceState(null, "", window.location.pathname + window.location.search)
      return cachedToken
    }
  }

  // 2. Fall back to localStorage (page refresh, second tab, bookmark without hash)
  try {
    const stored = localStorage.getItem(AUTH_STORAGE_KEY)
    if (stored) {
      cachedToken = stored
      return cachedToken
    }
  } catch {
    // Storage unavailable — fall through to null
  }

  return null
}

/**
 * Listen for token changes from other tabs via the `storage` event.
 * When another tab writes a new token to localStorage, this tab picks
 * it up immediately without requiring a page refresh.
 */
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === AUTH_STORAGE_KEY && event.newValue) {
      cachedToken = event.newValue
    }
  })
}

/**
 * Returns an object with the `Authorization` header for use with `fetch()`.
 * Merges with any additional headers provided.
 */
export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getAuthToken()
  const headers: Record<string, string> = { ...extra }
  if (token) {
    headers["Authorization"] = `Bearer ${token}`
  }
  return headers
}

/**
 * Wrapper around `fetch()` that automatically injects the auth token.
 *
 * When no token is available (missing `#token=` fragment and no localStorage
 * entry), returns a synthetic 401 Response instead of making an unauthenticated
 * request that will fail server-side anyway. This lets callers handle the
 * missing-token case uniformly rather than silently cascading 401s.
 */
export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = getAuthToken()
  if (!token) {
    return new Response(JSON.stringify({ error: "No auth token available" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })
  }

  const headers = new Headers(init?.headers)
  if (!headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`)
  }

  return fetch(input, { ...init, headers })
}

/**
 * Append the auth token as a `_token` query parameter to a URL string.
 * Used for EventSource connections which cannot send custom headers.
 */
export function appendAuthParam(url: string): string {
  const token = getAuthToken()
  if (!token) return url

  const separator = url.includes("?") ? "&" : "?"
  return `${url}${separator}_token=${token}`
}
