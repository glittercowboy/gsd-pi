import { cookies } from "next/headers";
import { verifyPassword, createSessionToken, getOrCreateSessionSecret } from "../../../../../src/web/web-session-auth.ts";
import { getPasswordHash } from "../../../../../src/web/web-password-storage.ts";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // ── IP extraction ──────────────────────────────────────────────────
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded
    ? forwarded.split(",")[0].trim()
    : (request.headers.get("x-real-ip") ?? "127.0.0.1");

  // ── Rate limit check ───────────────────────────────────────────────
  const { allowed, resetAt } = checkRateLimit(ip);
  if (!allowed) {
    return Response.json(
      { error: "rate_limited", resetAt },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((resetAt - Date.now()) / 1000)),
        },
      },
    );
  }

  // ── Parse and validate request body ───────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const { password } = body as Record<string, unknown>;

  if (!password || typeof password !== "string") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  if (password.length < 4) {
    return Response.json({ error: "password_too_short" }, { status: 400 });
  }

  // ── Check if password is configured ───────────────────────────────
  const storedHash = await getPasswordHash();
  if (storedHash === null) {
    return Response.json({ error: "not_configured" }, { status: 401 });
  }

  // ── Verify password ────────────────────────────────────────────────
  const valid = await verifyPassword(password, storedHash);
  if (!valid) {
    return Response.json({ error: "invalid_password" }, { status: 401 });
  }

  // ── Create session token (LIVE secret read from disk — review concern #1) ──
  const secret = await getOrCreateSessionSecret();
  const token = createSessionToken(secret, 30);

  // ── Set session cookie ─────────────────────────────────────────────
  const cookieStore = await cookies();
  cookieStore.set("gsd-session", token, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: 30 * 24 * 60 * 60,
    path: "/",
  });

  return Response.json({ ok: true });
}
