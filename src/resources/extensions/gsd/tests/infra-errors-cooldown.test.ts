// gsd / infra-errors cooldown detection tests
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  isTransientCooldownError,
  getCooldownRetryAfterMs,
  MAX_COOLDOWN_RETRIES,
  COOLDOWN_FALLBACK_WAIT_MS,
} from "../auto/infra-errors.js";

// ─── Constants ────────────────────────────────────────────────────────────────

describe("infra-errors cooldown constants", () => {
  test("COOLDOWN_FALLBACK_WAIT_MS is a positive number greater than the 30s rate-limit backoff", () => {
    assert.ok(typeof COOLDOWN_FALLBACK_WAIT_MS === "number");
    assert.ok(COOLDOWN_FALLBACK_WAIT_MS > 30_000, "should exceed the 30s rate-limit window");
  });

  test("MAX_COOLDOWN_RETRIES is a positive integer", () => {
    assert.ok(typeof MAX_COOLDOWN_RETRIES === "number");
    assert.ok(Number.isInteger(MAX_COOLDOWN_RETRIES));
    assert.ok(MAX_COOLDOWN_RETRIES > 0);
  });

  test("COOLDOWN_FALLBACK_WAIT_MS is 35_000", () => {
    assert.equal(COOLDOWN_FALLBACK_WAIT_MS, 35_000);
  });

  test("MAX_COOLDOWN_RETRIES is 5", () => {
    assert.equal(MAX_COOLDOWN_RETRIES, 5);
  });
});

// ─── isTransientCooldownError: structured detection ──────────────────────────

describe("isTransientCooldownError — structured code detection", () => {
  test("returns true for an object with code === AUTH_COOLDOWN", () => {
    const err = { code: "AUTH_COOLDOWN", message: "credentials in cooldown" };
    assert.equal(isTransientCooldownError(err), true);
  });

  test("returns true for a real CredentialCooldownError-shaped error", () => {
    // Simulate CredentialCooldownError without importing sdk.ts (leaf-module rule)
    const err = Object.assign(new Error('All credentials for "anthropic" are in a cooldown window.'), {
      code: "AUTH_COOLDOWN",
      retryAfterMs: 30_000,
      name: "CredentialCooldownError",
    });
    assert.equal(isTransientCooldownError(err), true);
  });

  test("returns false for an object with a different code", () => {
    const err = { code: "ENOSPC", message: "disk full" };
    assert.equal(isTransientCooldownError(err), false);
  });

  test("returns false for an object with no code property", () => {
    const err = { message: "some random error" };
    assert.equal(isTransientCooldownError(err), false);
  });
});

// ─── isTransientCooldownError: message fallback ───────────────────────────────

describe("isTransientCooldownError — message fallback (cross-process)", () => {
  test("returns true when message contains 'in a cooldown window'", () => {
    const err = new Error('All credentials for "openai" are in a cooldown window. Please wait.');
    assert.equal(isTransientCooldownError(err), true);
  });

  test("returns true when message matches case-insensitively", () => {
    const err = new Error("credentials IN A COOLDOWN WINDOW");
    assert.equal(isTransientCooldownError(err), true);
  });

  test("returns true for a plain string containing cooldown window phrase", () => {
    assert.equal(isTransientCooldownError("all keys in a cooldown window"), true);
  });

  test("returns false for a generic error message", () => {
    const err = new Error("rate limit exceeded");
    assert.equal(isTransientCooldownError(err), false);
  });

  test("returns false for an error message about auth failure without cooldown phrase", () => {
    const err = new Error("Authentication failed: invalid API key");
    assert.equal(isTransientCooldownError(err), false);
  });
});

// ─── isTransientCooldownError: edge cases ────────────────────────────────────

describe("isTransientCooldownError — edge cases", () => {
  test("returns false for null", () => {
    assert.equal(isTransientCooldownError(null), false);
  });

  test("returns false for undefined", () => {
    assert.equal(isTransientCooldownError(undefined), false);
  });

  test("returns false for a number", () => {
    assert.equal(isTransientCooldownError(42), false);
  });

  test("returns false for an empty object", () => {
    assert.equal(isTransientCooldownError({}), false);
  });

  test("returns false for an object with code === AUTH_COOLDOWN as a non-string", () => {
    // code must be a string matching "AUTH_COOLDOWN" exactly
    const err = { code: 42 };
    assert.equal(isTransientCooldownError(err), false);
  });
});

// ─── getCooldownRetryAfterMs: structured extraction ──────────────────────────

describe("getCooldownRetryAfterMs — structured extraction", () => {
  test("returns retryAfterMs when code is AUTH_COOLDOWN and retryAfterMs is set", () => {
    const err = { code: "AUTH_COOLDOWN", retryAfterMs: 30_000 };
    assert.equal(getCooldownRetryAfterMs(err), 30_000);
  });

  test("returns undefined when code is AUTH_COOLDOWN but retryAfterMs is absent", () => {
    const err = { code: "AUTH_COOLDOWN" };
    assert.equal(getCooldownRetryAfterMs(err), undefined);
  });

  test("returns 0 when retryAfterMs is explicitly 0", () => {
    const err = { code: "AUTH_COOLDOWN", retryAfterMs: 0 };
    assert.equal(getCooldownRetryAfterMs(err), 0);
  });

  test("returns undefined for an error with a different code even if retryAfterMs is set", () => {
    const err = { code: "ENOSPC", retryAfterMs: 5_000 };
    assert.equal(getCooldownRetryAfterMs(err), undefined);
  });

  test("returns undefined for a plain Error with no code property", () => {
    const err = new Error("something went wrong");
    assert.equal(getCooldownRetryAfterMs(err), undefined);
  });

  test("returns retryAfterMs from a full CredentialCooldownError-shaped object", () => {
    const err = Object.assign(new Error('All credentials for "anthropic" are in a cooldown window.'), {
      code: "AUTH_COOLDOWN",
      retryAfterMs: 15_000,
      name: "CredentialCooldownError",
    });
    assert.equal(getCooldownRetryAfterMs(err), 15_000);
  });
});

// ─── getCooldownRetryAfterMs: edge cases ─────────────────────────────────────

describe("getCooldownRetryAfterMs — edge cases", () => {
  test("returns undefined for null", () => {
    assert.equal(getCooldownRetryAfterMs(null), undefined);
  });

  test("returns undefined for undefined", () => {
    assert.equal(getCooldownRetryAfterMs(undefined), undefined);
  });

  test("returns undefined for a plain string", () => {
    assert.equal(getCooldownRetryAfterMs("AUTH_COOLDOWN"), undefined);
  });

  test("returns undefined for an empty object", () => {
    assert.equal(getCooldownRetryAfterMs({}), undefined);
  });

  test("returns undefined for a number", () => {
    assert.equal(getCooldownRetryAfterMs(42), undefined);
  });
});
