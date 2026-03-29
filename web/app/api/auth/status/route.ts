import { cookies } from "next/headers";
import { verifySessionToken, getOrCreateSessionSecret } from "../../../../../src/web/web-session-auth.ts";
import { getPasswordHash } from "../../../../../src/web/web-password-storage.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  // ── Check if password is configured ───────────────────────────────
  const storedHash = await getPasswordHash();
  if (storedHash === null) {
    return Response.json({ configured: false, authenticated: false });
  }

  // ── Bearer token check (AUTH-08: bearer holders are always authenticated) ──
  const authHeader = request.headers.get("authorization");
  const expectedToken = process.env.GSD_WEB_AUTH_TOKEN;
  if (authHeader?.startsWith("Bearer ") && expectedToken) {
    const bearerToken = authHeader.slice(7);
    if (bearerToken === expectedToken) {
      return Response.json({ configured: true, authenticated: true });
    }
  }

  // ── Cookie session check ───────────────────────────────────────────
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("gsd-session")?.value;

  if (!sessionCookie) {
    return Response.json({ configured: true, authenticated: false });
  }

  // Read secret LIVE from disk (review concern #1)
  const secret = await getOrCreateSessionSecret();
  const payload = verifySessionToken(sessionCookie, secret);

  if (payload === null) {
    return Response.json({ configured: true, authenticated: false });
  }

  return Response.json({ configured: true, authenticated: true });
}
