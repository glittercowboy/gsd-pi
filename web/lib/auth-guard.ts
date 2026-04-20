// GSD Web — Inline auth token verification for sensitive API routes
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

/**
 * Defense-in-depth auth check for critical API routes (shutdown, update, etc.).
 *
 * The primary auth gate is Next.js middleware (web/middleware.ts). This helper
 * provides a second layer so that even if middleware is misconfigured or
 * bypassed, sensitive endpoints still reject unauthenticated requests.
 *
 * Returns a 401 Response if the token is missing or invalid, or null if auth
 * passes (or no token is configured).
 */
export function verifyAuthToken(request: Request): Response | null {
  const expectedToken = process.env.GSD_WEB_AUTH_TOKEN
  if (!expectedToken) {
    // No token configured (e.g. dev mode) — allow through
    return null
  }

  let token: string | null = null

  // 1. Authorization header (preferred)
  const authHeader = request.headers.get("authorization")
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7)
  }

  // 2. Query parameter fallback for EventSource / sendBeacon
  if (!token) {
    try {
      const url = new URL(request.url)
      token = url.searchParams.get("_token")
    } catch {
      // Malformed URL — reject
    }
  }

  if (!token || token !== expectedToken) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401 },
    )
  }

  return null
}
