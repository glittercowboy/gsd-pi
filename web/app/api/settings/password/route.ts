import { cookies } from "next/headers";
import { setPassword, getPasswordHash } from "../../../../../src/web/web-password-storage.ts";
import { verifyPassword, createSessionToken, getOrCreateSessionSecret } from "../../../../../src/web/web-session-auth.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/settings/password
// Requires authentication (endpoint is under /api/settings/, NOT /api/auth/*).
// Callers under /api/auth/* are exempted from cookie/bearer checks by middleware.
// Placing password change here ensures the proxy requires a valid session first.
export async function POST(request: Request): Promise<Response> {
  try {
    // ── Parse and validate request body ─────────────────────────────────
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    if (!body || typeof body !== "object") {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    const { currentPassword, newPassword } = body as Record<string, unknown>;

    if (!newPassword || typeof newPassword !== "string" || newPassword.length < 4) {
      return Response.json(
        { error: "Password must be at least 4 characters" },
        { status: 400 },
      );
    }

    // ── Verify current password (required when password already set) ─────
    const existingHash = await getPasswordHash();
    if (existingHash !== null) {
      // Password already configured — require current password to change
      if (!currentPassword || typeof currentPassword !== "string") {
        return Response.json(
          { error: "Current password is required" },
          { status: 400 },
        );
      }
      if (!verifyPassword(currentPassword, existingHash)) {
        return Response.json(
          { error: "Current password is incorrect" },
          { status: 403 },
        );
      }
    }
    // If no password exists yet (first-time setup), skip current password check

    // ── Store password and rotate session secret (AUTH-07) ───────────────
    // setPassword hashes with scrypt, stores in ~/.gsd/web-auth.json,
    // and calls rotateSessionSecret() to invalidate all existing sessions.
    await setPassword(newPassword);

    // ── Re-issue session cookie for current browser (D-07) ───────────────
    // The secret was rotated above, so we must read the new secret and
    // mint a fresh token so the current browser session remains valid.
    const newSecret = await getOrCreateSessionSecret();
    process.env.GSD_WEB_SESSION_SECRET = newSecret;
    const token = createSessionToken(newSecret, 30);
    const cookieStore = await cookies();
    cookieStore.set("gsd-session", token, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      maxAge: 30 * 24 * 60 * 60, // 30 days
      path: "/",
    });

    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "Failed to update password" }, { status: 500 });
  }
}
