import { NextResponse, type NextRequest } from "next/server"

/**
 * Next.js proxy — validates bearer token and origin on all API routes.
 *
 * The GSD_WEB_AUTH_TOKEN env var is set at server launch. Every /api/* request
 * must carry a matching `Authorization: Bearer <token>` header. EventSource
 * (SSE) connections may use the `_token` query parameter instead since the
 * EventSource API cannot set custom headers.
 *
 * Additionally, if an `Origin` header is present, it must match the expected
 * localhost origin to prevent cross-site request forgery.
 *
 * Cookie auth (Tailscale HTTPS): if a valid `gsd-session` cookie is present,
 * the request is authenticated without a bearer token. This allows cookie-based
 * sessions over Tailscale Serve (HTTPS), while the existing bearer token flow
 * is preserved for localhost HTTP usage.
 */

/**
 * Verify the custom HMAC session token in Edge Runtime using Web Crypto.
 * Token format: base64url(JSON_payload).hex(HMAC-SHA256)
 * Returns true if signature is valid and token is not expired.
 *
 * NOTE: Uses crypto.subtle directly instead of the jose library.
 * Our token format is a simple custom HMAC (not JWT/JWS), so jose offers
 * no benefit here. crypto.subtle is built into all Edge Runtimes with zero
 * dependencies.
 */
async function verifySessionCookieEdge(token: string): Promise<boolean> {
  const secret = process.env.GSD_WEB_SESSION_SECRET
  if (!secret) return false

  const dotIndex = token.indexOf(".")
  if (dotIndex === -1) return false

  const payloadB64 = token.slice(0, dotIndex)
  const signatureHex = token.slice(dotIndex + 1)

  try {
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
    const signatureBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64))
    const expectedHex = Array.from(new Uint8Array(signatureBytes))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")

    // Constant-time comparison (AUTH-10)
    if (signatureHex.length !== expectedHex.length) return false
    let mismatch = 0
    for (let i = 0; i < signatureHex.length; i++) {
      mismatch |= signatureHex.charCodeAt(i) ^ expectedHex.charCodeAt(i)
    }
    if (mismatch !== 0) return false

    // Parse and check expiry
    const payloadJson = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"))
    const payload = JSON.parse(payloadJson) as { expiresAt?: unknown }
    if (!payload.expiresAt || (payload.expiresAt as number) <= Date.now()) return false

    return true
  } catch {
    return false
  }
}

export async function proxy(request: NextRequest): Promise<NextResponse | undefined> {
  const { pathname } = request.nextUrl

  // Only gate API routes
  if (!pathname.startsWith("/api/")) return NextResponse.next()

  const expectedToken = process.env.GSD_WEB_AUTH_TOKEN
  if (!expectedToken) {
    // If no token was configured (e.g. dev mode without launch harness),
    // allow everything — the server didn't opt into auth.
    return NextResponse.next()
  }

  // ── Origin / CORS check ────────────────────────────────────────────
  const origin = request.headers.get("origin")
  if (origin) {
    const host = process.env.GSD_WEB_HOST || "127.0.0.1"
    const port = process.env.GSD_WEB_PORT || "3000"

    // Default: localhost origin for the launched host:port
    const allowed = new Set([`http://${host}:${port}`])

    // GSD_WEB_ALLOWED_ORIGINS lets users whitelist additional origins for
    // secure tunnel setups (Tailscale Serve, Cloudflare Tunnel, ngrok, etc.)
    const extra = process.env.GSD_WEB_ALLOWED_ORIGINS
    if (extra) {
      for (const entry of extra.split(",")) {
        const trimmed = entry.trim()
        if (trimmed) allowed.add(trimmed)
      }
    }

    if (!allowed.has(origin)) {
      return NextResponse.json(
        { error: "Forbidden: origin mismatch" },
        { status: 403 },
      )
    }
  }

  // ── Auth endpoint exemption (AUTH-09) ─────────────────────────────
  // Auth routes skip credential checks (cookie/bearer) but still pass
  // through the Origin validation above. This preserves CSRF protection
  // while allowing unauthenticated access to login/logout/status.
  if (pathname.startsWith("/api/auth/")) return NextResponse.next()

  // ── Cookie session check (Tailscale / HTTPS) ─────────────────────
  const sessionCookie = request.cookies.get("gsd-session")?.value
  if (sessionCookie) {
    const valid = await verifySessionCookieEdge(sessionCookie)
    if (valid) return NextResponse.next()
    // Invalid/expired cookie — fall through to bearer token check
  }

  // ── Bearer token check ─────────────────────────────────────────────
  let token: string | null = null

  // 1. Authorization header (preferred)
  const authHeader = request.headers.get("authorization")
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7)
  }

  // 2. Query parameter fallback for EventSource / SSE
  if (!token) {
    token = request.nextUrl.searchParams.get("_token")
  }

  if (!token || token !== expectedToken) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    )
  }

  return NextResponse.next()
}

export const config = {
  matcher: "/api/:path*",
}
