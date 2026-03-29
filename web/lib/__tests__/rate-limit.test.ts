import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { checkRateLimit, _testResetRateLimits } from "../rate-limit.ts";

describe("rate-limit", () => {
  beforeEach(() => {
    _testResetRateLimits();
  });

  test("checkRateLimit returns allowed:true on first call", () => {
    const result = checkRateLimit("1.2.3.4");
    assert.equal(result.allowed, true);
    assert.equal(typeof result.resetAt, "number");
    assert.ok(result.resetAt > Date.now());
  });

  test("5 calls with same IP within 60s all return allowed:true", () => {
    for (let i = 0; i < 5; i++) {
      const result = checkRateLimit("1.2.3.4");
      assert.equal(result.allowed, true, `call ${i + 1} should be allowed`);
    }
  });

  test("6th call with same IP within 60s returns allowed:false", () => {
    for (let i = 0; i < 5; i++) {
      checkRateLimit("1.2.3.4");
    }
    const result = checkRateLimit("1.2.3.4");
    assert.equal(result.allowed, false);
    assert.equal(typeof result.resetAt, "number");
  });

  test("different IP is independent (allowed while first IP is blocked)", () => {
    for (let i = 0; i < 6; i++) {
      checkRateLimit("1.2.3.4");
    }
    // First IP is now blocked
    const blockedResult = checkRateLimit("1.2.3.4");
    assert.equal(blockedResult.allowed, false);

    // Different IP should still be allowed
    const otherResult = checkRateLimit("5.6.7.8");
    assert.equal(otherResult.allowed, true);
  });

  test("after clearing state, same IP is allowed again", () => {
    // Block an IP
    for (let i = 0; i < 6; i++) {
      checkRateLimit("1.2.3.4");
    }
    assert.equal(checkRateLimit("1.2.3.4").allowed, false);

    // Reset (simulates window expiry via test helper)
    _testResetRateLimits();

    // IP should be allowed again
    assert.equal(checkRateLimit("1.2.3.4").allowed, true);
  });

  test("resetAt is in the future (approximately 60s from now)", () => {
    const before = Date.now();
    const result = checkRateLimit("9.9.9.9");
    const after = Date.now();

    // resetAt should be roughly now + 60000ms
    assert.ok(result.resetAt >= before + 59_000, "resetAt should be ~60s in the future");
    assert.ok(result.resetAt <= after + 61_000, "resetAt should not be too far in the future");
  });
});
