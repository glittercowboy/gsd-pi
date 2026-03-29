// ---------------------------------------------------------------------------
// Web Password Storage — dedicated auth file for web UI password hash
// ---------------------------------------------------------------------------
// Stores the web UI password hash in ~/.gsd/web-auth.json (separate from
// web-preferences.json). The GET /api/preferences endpoint returns raw JSON
// from web-preferences.json — mixing in the password hash would leak it.
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { hashPassword, rotateSessionSecret } from "./web-session-auth.ts";
import { appRoot } from "../app-paths.ts";

const AUTH_FILE = "web-auth.json";

function authFilePath(gsdDir?: string): string {
  return join(gsdDir ?? appRoot, AUTH_FILE);
}

/**
 * Set (or update) the web UI password.
 * Stores the scrypt hash in a dedicated web-auth.json file with mode 0o600.
 * Rotates the session secret to invalidate all existing sessions (AUTH-07).
 */
export async function setPassword(password: string, gsdDir?: string): Promise<void> {
  const dir = gsdDir ?? appRoot;
  const filePath = authFilePath(dir);
  const passwordHash = await hashPassword(password);

  // Read-modify-write to preserve any other keys in the auth file
  let data: Record<string, unknown> = {};
  try {
    const raw = await readFile(filePath, "utf-8");
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // File doesn't exist yet — start fresh
  }

  data.passwordHash = passwordHash;
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });

  // AUTH-07: Rotate session secret to invalidate all existing sessions
  await rotateSessionSecret(dir);
}

/**
 * Get the stored password hash, or null if no password has been set.
 * Returns null (never throws) for missing file, invalid JSON, or missing key.
 */
export async function getPasswordHash(gsdDir?: string): Promise<string | null> {
  try {
    const raw = await readFile(authFilePath(gsdDir), "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data.passwordHash === "string" && data.passwordHash.includes(":")) {
      return data.passwordHash;
    }
    return null;
  } catch {
    return null;
  }
}
