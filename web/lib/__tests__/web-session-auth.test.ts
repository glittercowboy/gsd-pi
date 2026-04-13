import { describe, test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  hashPassword,
  verifyPassword,
  createSessionToken,
  verifySessionToken,
  getOrCreateSessionSecret,
  rotateSessionSecret,
} from "../../../src/web/web-session-auth.ts";

// ---------------------------------------------------------------------------
// Password hashing tests
// ---------------------------------------------------------------------------

describe("hashPassword / verifyPassword", () => {
  test("hashPassword returns salt:hash format", async () => {
    const hash = await hashPassword("test");
    assert.equal(typeof hash, "string");
    const parts = hash.split(":");
    assert.equal(parts.length, 2);
    // salt = 16 bytes = 32 hex chars
    assert.equal(parts[0].length, 32);
    // hash = 64 bytes = 128 hex chars
    assert.equal(parts[1].length, 128);
  });

  test("verifyPassword returns true for correct password", async () => {
    const hash = await hashPassword("correct");
    const result = await verifyPassword("correct", hash);
    assert.equal(result, true);
  });

  test("verifyPassword returns false for wrong password", async () => {
    const hash = await hashPassword("correct");
    const result = await verifyPassword("wrong", hash);
    assert.equal(result, false);
  });

  test("hashPassword produces different outputs for same password (random salt)", async () => {
    const hash1 = await hashPassword("same");
    const hash2 = await hashPassword("same");
    assert.notEqual(hash1, hash2);
  });

  test("verifyPassword returns false for malformed stored hash (no colon)", async () => {
    const result = await verifyPassword("anything", "nocolonhere");
    assert.equal(result, false);
  });
});

// ---------------------------------------------------------------------------
// Session token tests
// ---------------------------------------------------------------------------

describe("createSessionToken / verifySessionToken", () => {
  const secret = "test-secret-for-session-tokens-12345";

  test("createSessionToken returns non-empty string with dot separator", () => {
    const token = createSessionToken(secret, 30);
    assert.equal(typeof token, "string");
    assert.ok(token.length > 0);
    assert.ok(token.includes("."), "token must contain a dot separator");
  });

  test("verifySessionToken returns payload for valid token", () => {
    const token = createSessionToken(secret, 30);
    const payload = verifySessionToken(token, secret);
    assert.ok(payload !== null, "payload should not be null");
    assert.equal(typeof payload!.createdAt, "number");
    assert.equal(typeof payload!.expiresAt, "number");
    assert.ok(payload!.expiresAt > payload!.createdAt);
  });

  test("verifySessionToken returns null for tampered token", () => {
    const token = createSessionToken(secret, 30);
    // Change last 4 chars of the token
    const tampered = token.slice(0, -4) + "xxxx";
    const result = verifySessionToken(tampered, secret);
    assert.equal(result, null);
  });

  test("verifySessionToken returns null for wrong secret", () => {
    const token = createSessionToken(secret, 30);
    const result = verifySessionToken(token, "wrong-secret");
    assert.equal(result, null);
  });

  test("verifySessionToken returns null for expired token", () => {
    // Create a token that expired 1 day ago
    const expiredToken = createSessionToken(secret, -1);
    const result = verifySessionToken(expiredToken, secret);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Session secret lifecycle tests
// ---------------------------------------------------------------------------

describe("getOrCreateSessionSecret / rotateSessionSecret", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gsd-session-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("getOrCreateSessionSecret creates file and returns 64-char hex string", async () => {
    const secret = await getOrCreateSessionSecret(tmpDir);
    assert.equal(typeof secret, "string");
    assert.equal(secret.length, 64);
    // Must be valid hex
    assert.match(secret, /^[0-9a-f]{64}$/);
  });

  test("getOrCreateSessionSecret called again returns same value", async () => {
    const secret1 = await getOrCreateSessionSecret(tmpDir);
    const secret2 = await getOrCreateSessionSecret(tmpDir);
    assert.equal(secret1, secret2);
  });

  test("rotateSessionSecret returns a different value than previous", async () => {
    const original = await getOrCreateSessionSecret(tmpDir);
    const rotated = await rotateSessionSecret(tmpDir);
    assert.notEqual(original, rotated);
  });

  test("after rotateSessionSecret, old tokens no longer verify against new secret", async () => {
    const original = await getOrCreateSessionSecret(tmpDir);
    const oldToken = createSessionToken(original, 30);

    // Rotate — old tokens should now fail
    const newSecret = await rotateSessionSecret(tmpDir);

    const result = verifySessionToken(oldToken, newSecret);
    assert.equal(result, null);
  });

  test("secret file is readable after creation", async () => {
    await getOrCreateSessionSecret(tmpDir);
    const { statSync } = await import("node:fs");
    const stat = statSync(join(tmpDir, "web-session-secret"));
    // Mode should be restricted (0o600)
    const mode = stat.mode & 0o777;
    assert.equal(mode, 0o600);
  });
});
