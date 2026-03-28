/**
 * Tests for the web auth token flow (web/lib/auth.ts) and proxy auth logic.
 *
 * Tests exercise exported functions directly rather than checking source patterns.
 * The auth module uses browser globals (window, localStorage, history), so tests
 * set up minimal mocks to exercise the logic in Node.js.
 *
 * The proxy module imports from next/server which is not available outside the
 * Next.js runtime, so its auth logic is tested as a pure extracted function.
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"

// ---------------------------------------------------------------------------
// getAuthToken — auth.ts behavioral tests
// ---------------------------------------------------------------------------

// The module caches the token in a module-level variable, so we re-import
// fresh each time using a cache-busting URL. We mock window/localStorage/history
// on globalThis before each import.

describe("getAuthToken", () => {
  let originalWindow: typeof globalThis.window | undefined
  let originalLocalStorage: typeof globalThis.localStorage | undefined

  beforeEach(() => {
    originalWindow = (globalThis as any).window
    originalLocalStorage = (globalThis as any).localStorage
  })

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as any).window
    } else {
      (globalThis as any).window = originalWindow
    }
    if (originalLocalStorage === undefined) {
      delete (globalThis as any).localStorage
    } else {
      (globalThis as any).localStorage = originalLocalStorage
    }
  })

  it("returns null when window is not defined (Node.js / SSR environment)", async () => {
    delete (globalThis as any).window
    // Fresh import via URL with cache-bust
    const url = new URL("../../../web/lib/auth.ts", import.meta.url).href + `?cb=${Date.now()}-1`
    const { getAuthToken } = await import(url)
    assert.equal(getAuthToken(), null)
  })

  it("extracts token from URL hash and persists to localStorage", async () => {
    const stored: Record<string, string> = {}
    const replacedTo: string[] = []

    ;(globalThis as any).localStorage = {
      getItem: (key: string) => stored[key] ?? null,
      setItem: (key: string, val: string) => { stored[key] = val },
    }
    ;(globalThis as any).window = {
      location: { hash: "#token=abc123def456", pathname: "/", search: "" },
      history: { replaceState: (_: unknown, __: string, url: string) => { replacedTo.push(url) } },
      addEventListener: () => {},
    }

    const url = new URL("../../../web/lib/auth.ts", import.meta.url).href + `?cb=${Date.now()}-2`
    const { getAuthToken } = await import(url)

    const token = getAuthToken()
    assert.equal(token, "abc123def456", "should extract token from hash")
    assert.equal(stored["gsd-auth-token"], "abc123def456", "should persist token to localStorage")
    assert.ok(replacedTo.length > 0, "should call replaceState to clear the hash")
    assert.ok(!replacedTo[0]!.includes("#"), "replaceState URL should not contain a fragment")
  })

  it("falls back to localStorage when hash is absent", async () => {
    const stored: Record<string, string> = { "gsd-auth-token": "stored-token-789" }

    ;(globalThis as any).localStorage = {
      getItem: (key: string) => stored[key] ?? null,
      setItem: (key: string, val: string) => { stored[key] = val },
    }
    ;(globalThis as any).window = {
      location: { hash: "", pathname: "/", search: "" },
      history: { replaceState: () => {} },
      addEventListener: () => {},
    }

    const url = new URL("../../../web/lib/auth.ts", import.meta.url).href + `?cb=${Date.now()}-3`
    const { getAuthToken } = await import(url)

    const token = getAuthToken()
    assert.equal(token, "stored-token-789", "should fall back to localStorage when hash is absent")
  })

  it("returns null when both hash and localStorage are empty", async () => {
    ;(globalThis as any).localStorage = {
      getItem: () => null,
      setItem: () => {},
    }
    ;(globalThis as any).window = {
      location: { hash: "", pathname: "/", search: "" },
      history: { replaceState: () => {} },
      addEventListener: () => {},
    }

    const url = new URL("../../../web/lib/auth.ts", import.meta.url).href + `?cb=${Date.now()}-4`
    const { getAuthToken } = await import(url)

    assert.equal(getAuthToken(), null, "should return null when no token is available anywhere")
  })
})

// ---------------------------------------------------------------------------
// appendAuthParam — auth.ts behavioral test
// ---------------------------------------------------------------------------

describe("appendAuthParam", () => {
  afterEach(() => {
    delete (globalThis as any).window
    delete (globalThis as any).localStorage
  })

  it("appends _token query parameter when token is available", async () => {
    ;(globalThis as any).localStorage = {
      getItem: (key: string) => key === "gsd-auth-token" ? "mytoken123" : null,
      setItem: () => {},
    }
    ;(globalThis as any).window = {
      location: { hash: "", pathname: "/", search: "" },
      history: { replaceState: () => {} },
      addEventListener: () => {},
    }

    const url = new URL("../../../web/lib/auth.ts", import.meta.url).href + `?cb=${Date.now()}-5`
    const { appendAuthParam } = await import(url)

    assert.equal(appendAuthParam("/api/sse"), "/api/sse?_token=mytoken123")
    assert.equal(appendAuthParam("/api/sse?foo=bar"), "/api/sse?foo=bar&_token=mytoken123")
  })

  it("returns URL unchanged when no token is available", async () => {
    delete (globalThis as any).window

    const url = new URL("../../../web/lib/auth.ts", import.meta.url).href + `?cb=${Date.now()}-6`
    const { appendAuthParam } = await import(url)

    assert.equal(appendAuthParam("/api/sse"), "/api/sse")
  })
})

// ---------------------------------------------------------------------------
// proxy auth logic — behavioral tests (pure function, no next/server import)
//
// proxy.ts imports NextRequest/NextResponse from "next/server" which is only
// available inside the Next.js runtime — not importable in bare Node.js.
// The authentication algorithm is tested here as a pure extracted function
// that mirrors the logic in proxy.ts exactly.
// ---------------------------------------------------------------------------

/**
 * Pure reimplementation of the authentication check from proxy.ts.
 * Returns { status: number; error?: string } for error cases,
 * or { status: 200 } for pass-through.
 */
function checkProxyAuth(opts: {
  pathname: string
  authToken: string | undefined
  origin: string | null
  bearerToken: string | null
  queryToken: string | null
  host?: string
  port?: string
  allowedOrigins?: string
}): { status: number; error?: string } {
  // Only gate API routes
  if (!opts.pathname.startsWith("/api/")) return { status: 200 }

  const expectedToken = opts.authToken
  if (!expectedToken) return { status: 200 }

  // Origin check
  if (opts.origin) {
    const host = opts.host ?? "127.0.0.1"
    const port = opts.port ?? "3000"
    const allowed = new Set([`http://${host}:${port}`])
    if (opts.allowedOrigins) {
      for (const entry of opts.allowedOrigins.split(",")) {
        const trimmed = entry.trim()
        if (trimmed) allowed.add(trimmed)
      }
    }
    if (!allowed.has(opts.origin)) {
      return { status: 403, error: "Forbidden: origin mismatch" }
    }
  }

  // Bearer token check
  let token: string | null = opts.bearerToken
  if (!token) token = opts.queryToken

  if (!token || token !== expectedToken) {
    return { status: 401, error: "Unauthorized" }
  }

  return { status: 200 }
}

describe("proxy auth logic", () => {
  it("passes through non-API routes without auth check", () => {
    const result = checkProxyAuth({
      pathname: "/",
      authToken: "secret",
      origin: null,
      bearerToken: null,
      queryToken: null,
    })
    assert.equal(result.status, 200)
  })

  it("passes through all requests when GSD_WEB_AUTH_TOKEN is not set", () => {
    const result = checkProxyAuth({
      pathname: "/api/boot",
      authToken: undefined,
      origin: null,
      bearerToken: null,
      queryToken: null,
    })
    assert.equal(result.status, 200)
  })

  it("rejects API request with missing token (401)", () => {
    const result = checkProxyAuth({
      pathname: "/api/boot",
      authToken: "secret",
      origin: null,
      bearerToken: null,
      queryToken: null,
    })
    assert.equal(result.status, 401)
    assert.equal(result.error, "Unauthorized")
  })

  it("rejects API request with wrong token (401)", () => {
    const result = checkProxyAuth({
      pathname: "/api/boot",
      authToken: "secret-token",
      origin: null,
      bearerToken: "wrong-token",
      queryToken: null,
    })
    assert.equal(result.status, 401)
  })

  it("accepts API request with correct Bearer token", () => {
    const result = checkProxyAuth({
      pathname: "/api/boot",
      authToken: "correct-token",
      origin: null,
      bearerToken: "correct-token",
      queryToken: null,
    })
    assert.equal(result.status, 200)
  })

  it("accepts API request with correct _token query parameter (SSE/sendBeacon fallback)", () => {
    const result = checkProxyAuth({
      pathname: "/api/sse",
      authToken: "sse-token",
      origin: null,
      bearerToken: null,
      queryToken: "sse-token",
    })
    assert.equal(result.status, 200)
  })

  it("rejects request with mismatched origin (403)", () => {
    const result = checkProxyAuth({
      pathname: "/api/boot",
      authToken: "token",
      origin: "http://evil.example.com",
      bearerToken: "token",
      queryToken: null,
      host: "127.0.0.1",
      port: "3000",
    })
    assert.equal(result.status, 403)
    assert.ok(result.error?.includes("origin"))
  })

  it("allows request with matching origin", () => {
    const result = checkProxyAuth({
      pathname: "/api/boot",
      authToken: "token",
      origin: "http://127.0.0.1:3000",
      bearerToken: "token",
      queryToken: null,
      host: "127.0.0.1",
      port: "3000",
    })
    assert.equal(result.status, 200)
  })

  it("allows additional origins via GSD_WEB_ALLOWED_ORIGINS", () => {
    const result = checkProxyAuth({
      pathname: "/api/boot",
      authToken: "token",
      origin: "https://my-tunnel.tailscale.net",
      bearerToken: "token",
      queryToken: null,
      allowedOrigins: "https://my-tunnel.tailscale.net",
    })
    assert.equal(result.status, 200)
  })

  it("skips auth check for non-API paths (static assets, pages)", () => {
    for (const path of ["/", "/_next/static/chunk.js", "/dashboard"]) {
      const result = checkProxyAuth({
        pathname: path,
        authToken: "token",
        origin: null,
        bearerToken: null,
        queryToken: null,
      })
      assert.equal(result.status, 200, `${path} should pass through without auth`)
    }
  })
})
