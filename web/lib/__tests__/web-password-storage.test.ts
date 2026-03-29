import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";

import { setPassword, getPasswordHash } from "../../../src/web/web-password-storage.ts";
import { verifyPassword } from "../../../src/web/web-session-auth.ts";

describe("web-password-storage", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gsd-password-storage-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("setPassword writes a JSON file at web-auth.json with a passwordHash key", async () => {
    await setPassword("mypassword", tmpDir);
    const filePath = join(tmpDir, "web-auth.json");
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    assert.equal(typeof data.passwordHash, "string");
    assert.ok(data.passwordHash.includes(":"), "hash should be in salt:hash format");
  });

  test("getPasswordHash returns the stored hash string when a password is set", async () => {
    await setPassword("mypassword", tmpDir);
    const hash = await getPasswordHash(tmpDir);
    assert.ok(hash !== null, "should return a hash string");
    assert.equal(typeof hash, "string");
    assert.ok(hash!.includes(":"), "hash should be in salt:hash format");
  });

  test("getPasswordHash returns null when no password has been set (file missing)", async () => {
    const hash = await getPasswordHash(tmpDir);
    assert.equal(hash, null);
  });

  test("setPassword preserves other keys in the auth file (read-modify-write)", async () => {
    // Pre-populate file with an extra key
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(tmpDir, "web-auth.json"),
      JSON.stringify({ otherKey: "keep-this" }, null, 2),
    );
    await setPassword("mypassword", tmpDir);
    const raw = readFileSync(join(tmpDir, "web-auth.json"), "utf-8");
    const data = JSON.parse(raw);
    assert.equal(data.otherKey, "keep-this", "otherKey should be preserved");
    assert.ok(typeof data.passwordHash === "string", "passwordHash should be added");
  });

  test("stored hash can be verified with verifyPassword", async () => {
    await setPassword("mypassword", tmpDir);
    const hash = await getPasswordHash(tmpDir);
    assert.ok(hash !== null);
    const valid = await verifyPassword("mypassword", hash!);
    assert.equal(valid, true);
  });

  test("setPassword rotates session secret to invalidate existing sessions", async () => {
    // First set password to create a session secret
    await setPassword("password1", tmpDir);
    const secretFile = join(tmpDir, "web-session-secret");
    const { readFileSync: readFS } = await import("node:fs");
    const { existsSync } = await import("node:fs");

    assert.ok(existsSync(secretFile), "session secret file should exist after setPassword");

    const secret1 = readFS(secretFile, "utf-8").trim();

    // Set password again — should rotate the secret
    await setPassword("password2", tmpDir);
    const secret2 = readFS(secretFile, "utf-8").trim();

    assert.notEqual(secret1, secret2, "session secret should be rotated on password change");
  });
});
