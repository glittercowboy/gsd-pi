import { NextResponse, type NextRequest } from "next/server"
import { isAllowedOrigin } from "./lib/origin-guard"

/**
 * Next.js middleware — validates bearer token and origin on all API routes.
 *
 * The GSD_WEB_AUTH_TOKEN env var is set at server launch. Every /api/* request
 * must carry a matching `Authorization: Bearer <token>` header. EventSource
 * (SSE) connections may use the `_token` query parameter instead since the
 * EventSource API cannot set custom headers.
 *
 * Additionally, if an `Origin` header is present, it must match the launched
 * origin, the actual request host/forwarded host, or an explicitly allowed
 * origin to prevent cross-site request forgery while supporting remote access.
 */
export function middleware(request: NextRequest): NextResponse | undefined {
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
    if (!isAllowedOrigin(request, origin)) {
      return NextResponse.json(
        { error: "Forbidden: origin mismatch" },
        { status: 403 },
      )
    }
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
