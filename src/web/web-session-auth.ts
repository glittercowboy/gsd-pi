// ---------------------------------------------------------------------------
// Web Session Auth — password hashing, session tokens, session secret lifecycle
// ---------------------------------------------------------------------------
// Uses only node:crypto primitives — no external dependencies (AUTH-10).
// ---------------------------------------------------------------------------

import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { appRoot } from "../app-paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionPayload = { createdAt: number; expiresAt: number };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCRYPT_KEYLEN = 64;
const SESSION_SECRET_FILE = "web-session-secret";

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

/**
 * Hash a plaintext password using scrypt with a random 16-byte salt.
 * Returns a string in the format "salt_hex:hash_hex".
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

/**
 * Verify a plaintext password against a stored scrypt hash.
 * Returns false on any error (including malformed stored hash).
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const colonIndex = stored.indexOf(":");
    if (colonIndex === -1) return false;

    const saltHex = stored.slice(0, colonIndex);
    const hashHex = stored.slice(colonIndex + 1);

    if (saltHex.length !== 32 || hashHex.length !== 128) return false;

    const salt = Buffer.from(saltHex, "hex");
    const expectedHash = Buffer.from(hashHex, "hex");
    const candidateHash = scryptSync(password, salt, SCRYPT_KEYLEN);

    // AUTH-10: Use timingSafeEqual, never string equality
    if (candidateHash.length !== expectedHash.length) return false;
    return timingSafeEqual(candidateHash, expectedHash);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

/**
 * Create a signed session token.
 * Format: base64url(JSON payload) + "." + HMAC-SHA256 hex signature
 */
export function createSessionToken(secret: string, daysValid: number): string {
  const now = Date.now();
  const payload: SessionPayload = {
    createdAt: now,
    expiresAt: now + daysValid * 86_400_000,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadB64).digest("hex");
  return `${payloadB64}.${signature}`;
}

/**
 * Verify a signed session token. Returns the payload or null on any failure.
 * AUTH-10: HMAC comparison uses timingSafeEqual, never string equality.
 */
export function verifySessionToken(token: string, secret: string): SessionPayload | null {
  try {
    const dotIndex = token.indexOf(".");
    if (dotIndex === -1) return null;

    const payloadB64 = token.slice(0, dotIndex);
    const signatureHex = token.slice(dotIndex + 1);

    // Recompute expected HMAC
    const expectedHex = createHmac("sha256", secret).update(payloadB64).digest("hex");

    // AUTH-10: Convert to Buffers for timingSafeEqual (throws on length mismatch)
    const sigBuf = Buffer.from(signatureHex, "hex");
    const expBuf = Buffer.from(expectedHex, "hex");

    if (sigBuf.length !== expBuf.length) return null;
    if (!timingSafeEqual(sigBuf, expBuf)) return null;

    // Parse and validate payload
    const payloadStr = Buffer.from(payloadB64, "base64url").toString("utf-8");
    const payload = JSON.parse(payloadStr) as SessionPayload;

    if (typeof payload.createdAt !== "number" || typeof payload.expiresAt !== "number") {
      return null;
    }

    if (payload.expiresAt <= Date.now()) return null;

    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session secret lifecycle
// ---------------------------------------------------------------------------

function secretFilePath(gsdDir: string): string {
  return join(gsdDir, SESSION_SECRET_FILE);
}

/**
 * Get the current session secret, creating one if it doesn't exist.
 * Secret is stored in `{gsdDir}/web-session-secret` with mode 0o600.
 * Addresses review concern: uses gsdDir ?? appRoot, never hardcodes ~/.gsd.
 */
export async function getOrCreateSessionSecret(gsdDir?: string): Promise<string> {
  const dir = gsdDir ?? appRoot;
  const filePath = secretFilePath(dir);

  try {
    const content = await readFile(filePath, "utf-8");
    const trimmed = content.trim();
    if (trimmed.length >= 32) return trimmed;
  } catch {
    // File doesn't exist yet — create it below
  }

  return generateAndWriteSecret(dir);
}

/**
 * Rotate the session secret, invalidating all existing session tokens.
 * Generates a new 64-char hex secret and overwrites the file with mode 0o600.
 */
export async function rotateSessionSecret(gsdDir?: string): Promise<string> {
  const dir = gsdDir ?? appRoot;
  return generateAndWriteSecret(dir);
}

async function generateAndWriteSecret(dir: string): Promise<string> {
  const secret = randomBytes(32).toString("hex"); // 64 hex chars
  await mkdir(dir, { recursive: true });
  await writeFile(secretFilePath(dir), secret, { mode: 0o600 });
  return secret;
}
