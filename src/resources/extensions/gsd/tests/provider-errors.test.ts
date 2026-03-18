/**
 * Provider error handling tests — consolidated from:
 *   - provider-error-classify.test.ts (classifyProviderError)
 *   - network-error-fallback.test.ts (isTransientNetworkError, getNextFallbackModel)
 *   - agent-end-provider-error.test.ts (pauseAutoForProviderError)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { classifyProviderError, pauseAutoForProviderError } from "../provider-error-pause.ts";
import { getNextFallbackModel, isTransientNetworkError } from "../preferences.ts";

// ── classifyProviderError ────────────────────────────────────────────────────

test("classifyProviderError detects rate limit from 429", () => {
  const result = classifyProviderError("HTTP 429 Too Many Requests");
  assert.ok(result.isTransient);
  assert.ok(result.isRateLimit);
  assert.ok(result.suggestedDelayMs > 0);
});

test("classifyProviderError detects rate limit from message", () => {
  const result = classifyProviderError("rate limit exceeded");
  assert.ok(result.isTransient);
  assert.ok(result.isRateLimit);
});

test("classifyProviderError extracts reset delay from message", () => {
  const result = classifyProviderError("rate limit exceeded, reset in 45s");
  assert.ok(result.isRateLimit);
  assert.equal(result.suggestedDelayMs, 45000);
});

test("classifyProviderError defaults to 60s for rate limit without reset", () => {
  const result = classifyProviderError("429 too many requests");
  assert.ok(result.isRateLimit);
  assert.equal(result.suggestedDelayMs, 60_000);
});

test("classifyProviderError detects Anthropic internal server error", () => {
  const msg = '{"type":"error","error":{"details":null,"type":"api_error","message":"Internal server error"}}';
  const result = classifyProviderError(msg);
  assert.ok(result.isTransient);
  assert.ok(!result.isRateLimit);
  assert.equal(result.suggestedDelayMs, 30_000);
});

test("classifyProviderError detects overloaded error", () => {
  const result = classifyProviderError("overloaded_error: Overloaded");
  assert.ok(result.isTransient);
  assert.equal(result.suggestedDelayMs, 30_000);
});

test("classifyProviderError detects 503 service unavailable", () => {
  const result = classifyProviderError("HTTP 503 Service Unavailable");
  assert.ok(result.isTransient);
});

test("classifyProviderError detects 502 bad gateway", () => {
  const result = classifyProviderError("HTTP 502 Bad Gateway");
  assert.ok(result.isTransient);
});

test("classifyProviderError detects auth error as permanent", () => {
  const result = classifyProviderError("unauthorized: invalid API key");
  assert.ok(!result.isTransient);
  assert.ok(!result.isRateLimit);
});

test("classifyProviderError detects billing error as permanent", () => {
  const result = classifyProviderError("billing issue: payment required");
  assert.ok(!result.isTransient);
});

test("classifyProviderError detects quota exceeded as permanent", () => {
  const result = classifyProviderError("quota exceeded for this month");
  assert.ok(!result.isTransient);
});

test("classifyProviderError treats unknown error as permanent", () => {
  const result = classifyProviderError("something went wrong");
  assert.ok(!result.isTransient);
});

test("classifyProviderError treats empty string as permanent", () => {
  const result = classifyProviderError("");
  assert.ok(!result.isTransient);
});

test("classifyProviderError: rate limit takes precedence over auth keywords", () => {
  const result = classifyProviderError("429 unauthorized rate limit");
  assert.ok(result.isRateLimit);
  assert.ok(result.isTransient);
});

// ── isTransientNetworkError ──────────────────────────────────────────────────

test("isTransientNetworkError detects ECONNRESET", () => {
  assert.ok(isTransientNetworkError("fetch failed: ECONNRESET"));
});

test("isTransientNetworkError detects ETIMEDOUT", () => {
  assert.ok(isTransientNetworkError("ETIMEDOUT: request timed out"));
});

test("isTransientNetworkError detects generic network error", () => {
  assert.ok(isTransientNetworkError("network error"));
});

test("isTransientNetworkError detects socket hang up", () => {
  assert.ok(isTransientNetworkError("socket hang up"));
});

test("isTransientNetworkError detects fetch failed", () => {
  assert.ok(isTransientNetworkError("fetch failed"));
});

test("isTransientNetworkError detects connection reset", () => {
  assert.ok(isTransientNetworkError("connection was reset by peer"));
});

test("isTransientNetworkError detects DNS errors", () => {
  assert.ok(isTransientNetworkError("dns resolution failed"));
});

test("isTransientNetworkError rejects auth errors", () => {
  assert.ok(!isTransientNetworkError("unauthorized: invalid API key"));
});

test("isTransientNetworkError rejects quota errors", () => {
  assert.ok(!isTransientNetworkError("quota exceeded"));
});

test("isTransientNetworkError rejects billing errors", () => {
  assert.ok(!isTransientNetworkError("billing issue: network payment required"));
});

test("isTransientNetworkError rejects empty string", () => {
  assert.ok(!isTransientNetworkError(""));
});

test("isTransientNetworkError rejects non-network errors", () => {
  assert.ok(!isTransientNetworkError("model not found"));
});

// ── getNextFallbackModel ─────────────────────────────────────────────────────

test("getNextFallbackModel selects next fallback if current is a fallback", () => {
  const modelConfig = { primary: "model-a", fallbacks: ["model-b", "model-c"] };
  assert.equal(getNextFallbackModel("model-b", modelConfig), "model-c");
});

test("getNextFallbackModel returns undefined if fallbacks exhausted", () => {
  const modelConfig = { primary: "model-a", fallbacks: ["model-b", "model-c"] };
  assert.equal(getNextFallbackModel("model-c", modelConfig), undefined);
});

test("getNextFallbackModel finds current model with provider prefix", () => {
  const modelConfig = { primary: "p/model-a", fallbacks: ["p/model-b"] };
  assert.equal(getNextFallbackModel("model-a", modelConfig), "p/model-b");
});

test("getNextFallbackModel returns primary if current is unknown", () => {
  const modelConfig = { primary: "model-a", fallbacks: ["model-b", "model-c"] };
  assert.equal(getNextFallbackModel("model-x", modelConfig), "model-a");
});

test("getNextFallbackModel returns primary if current is undefined", () => {
  const modelConfig = { primary: "model-a", fallbacks: ["model-b", "model-c"] };
  assert.equal(getNextFallbackModel(undefined, modelConfig), "model-a");
});

// ── pauseAutoForProviderError ────────────────────────────────────────────────

test("pauseAutoForProviderError warns and pauses without requiring ctx.log", async () => {
  const notifications: Array<{ message: string; level: string }> = [];
  let pauseCalls = 0;

  await pauseAutoForProviderError(
    { notify(message, level?) { notifications.push({ message, level: level ?? "info" }); } },
    ": terminated",
    async () => { pauseCalls += 1; },
  );

  assert.equal(pauseCalls, 1);
  assert.deepEqual(notifications, [
    { message: "Auto-mode paused due to provider error: terminated", level: "warning" },
  ]);
});

test("pauseAutoForProviderError schedules auto-resume for rate limit errors", async () => {
  const notifications: Array<{ message: string; level: string }> = [];
  let pauseCalls = 0;
  let resumeCalled = false;

  const originalSetTimeout = globalThis.setTimeout;
  const timers: Array<{ fn: () => void; delay: number }> = [];
  globalThis.setTimeout = ((fn: () => void, delay: number) => {
    timers.push({ fn, delay });
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    await pauseAutoForProviderError(
      { notify(message, level?) { notifications.push({ message, level: level ?? "info" }); } },
      ": rate limit exceeded",
      async () => { pauseCalls += 1; },
      { isRateLimit: true, retryAfterMs: 90000, resume: () => { resumeCalled = true; } },
    );

    assert.equal(pauseCalls, 1);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 90000);
    assert.deepEqual(notifications[0], {
      message: "Rate limited: rate limit exceeded. Auto-resuming in 90s...",
      level: "warning",
    });

    timers[0].fn();
    assert.equal(resumeCalled, true);
    assert.deepEqual(notifications[1], {
      message: "Rate limit window elapsed. Resuming auto-mode.",
      level: "info",
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("pauseAutoForProviderError falls back to indefinite pause when not rate limit", async () => {
  const notifications: Array<{ message: string; level: string }> = [];
  let pauseCalls = 0;

  await pauseAutoForProviderError(
    { notify(message, level?) { notifications.push({ message, level: level ?? "info" }); } },
    ": connection refused",
    async () => { pauseCalls += 1; },
    { isRateLimit: false },
  );

  assert.equal(pauseCalls, 1);
  assert.deepEqual(notifications, [
    { message: "Auto-mode paused due to provider error: connection refused", level: "warning" },
  ]);
});
