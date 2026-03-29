/**
 * Provider error handling tests — consolidated from:
 *   - provider-error-classify.test.ts (classifyError)
 *   - network-error-fallback.test.ts (isTransientNetworkError, getNextFallbackModel)
 *   - agent-end-provider-error.test.ts (pauseAutoForProviderError)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { classifyError, isTransient, isTransientNetworkError, createRetryState, resetRetryState } from "../error-classifier.ts";
import { pauseAutoForProviderError } from "../provider-error-pause.ts";
import { resumeAutoAfterProviderDelay } from "../bootstrap/provider-error-resume.ts";
import { getNextFallbackModel } from "../preferences.ts";

// ── classifyError ────────────────────────────────────────────────────────────

test("classifyError detects rate limit from 429", () => {
  const result = classifyError("HTTP 429 Too Many Requests");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "rate-limit");
  assert.ok("retryAfterMs" in result && result.retryAfterMs > 0);
});

test("classifyError detects rate limit from message", () => {
  const result = classifyError("rate limit exceeded");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "rate-limit");
});

test("classifyError extracts reset delay from message", () => {
  const result = classifyError("rate limit exceeded, reset in 45s");
  assert.equal(result.kind, "rate-limit");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 45000);
});

test("classifyError defaults to 60s for rate limit without reset", () => {
  const result = classifyError("429 too many requests");
  assert.equal(result.kind, "rate-limit");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 60_000);
});

test("classifyError treats stream_exhausted_without_result as transient connection failure", () => {
  const result = classifyError("stream_exhausted_without_result");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "connection");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 15_000);
});

test("classifyError detects Anthropic internal server error", () => {
  const msg = '{"type":"error","error":{"details":null,"type":"api_error","message":"Internal server error"}}';
  const result = classifyError(msg);
  assert.ok(isTransient(result));
  assert.equal(result.kind, "server");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 30_000);
});

test("classifyError detects Codex server_error from extracted message", () => {
  // After fix, mapCodexEvents extracts the nested error type and produces
  // "Codex server_error: <message>" instead of raw JSON.
  const msg = "Codex server_error: An error occurred while processing your request.";
  const result = classifyError(msg);
  assert.ok(isTransient(result));
  assert.equal(result.kind, "server");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 30_000);
});

test("classifyError detects overloaded error", () => {
  const result = classifyError("overloaded_error: Overloaded");
  assert.ok(isTransient(result));
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 30_000);
});

test("classifyError detects 503 service unavailable", () => {
  const result = classifyError("HTTP 503 Service Unavailable");
  assert.ok(isTransient(result));
});

test("classifyError detects 502 bad gateway", () => {
  const result = classifyError("HTTP 502 Bad Gateway");
  assert.ok(isTransient(result));
});

test("classifyError detects auth error as permanent", () => {
  const result = classifyError("unauthorized: invalid API key");
  assert.ok(!isTransient(result));
  assert.equal(result.kind, "permanent");
});

test("classifyError detects billing error as permanent", () => {
  const result = classifyError("billing issue: payment required");
  assert.ok(!isTransient(result));
});

test("classifyError detects quota exceeded as permanent", () => {
  const result = classifyError("quota exceeded for this month");
  assert.ok(!isTransient(result));
});

test("classifyError treats unknown error as not transient", () => {
  const result = classifyError("something went wrong");
  assert.ok(!isTransient(result));
  assert.equal(result.kind, "unknown");
});

test("classifyError treats empty string as not transient", () => {
  const result = classifyError("");
  assert.ok(!isTransient(result));
});

test("classifyError: rate limit takes precedence over auth keywords", () => {
  const result = classifyError("429 unauthorized rate limit");
  assert.equal(result.kind, "rate-limit");
  assert.ok(isTransient(result));
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

// ── resumeAutoAfterProviderDelay ────────────────────────────────────────────

test("resumeAutoAfterProviderDelay restarts paused auto-mode from the recorded base path", async () => {
  const startCalls: Array<{ base: string; verboseMode: boolean; step?: boolean }> = [];
  const result = await resumeAutoAfterProviderDelay(
    {} as any,
    { ui: { notify() {} } } as any,
    {
      getSnapshot: () => ({
        active: false,
        paused: true,
        stepMode: true,
        basePath: "/tmp/project",
      }),
      startAuto: async (_ctx, _pi, base, verboseMode, options) => {
        startCalls.push({ base, verboseMode, step: options?.step });
      },
    },
  );

  assert.equal(result, "resumed");
  assert.deepEqual(startCalls, [
    { base: "/tmp/project", verboseMode: false, step: true },
  ]);
});

test("resumeAutoAfterProviderDelay does not double-start when auto-mode is already active", async () => {
  let startCalls = 0;
  const result = await resumeAutoAfterProviderDelay(
    {} as any,
    { ui: { notify() {} } } as any,
    {
      getSnapshot: () => ({
        active: true,
        paused: false,
        stepMode: false,
        basePath: "/tmp/project",
      }),
      startAuto: async () => {
        startCalls += 1;
      },
    },
  );

  assert.equal(result, "already-active");
  assert.equal(startCalls, 0);
});

test("resumeAutoAfterProviderDelay leaves auto paused when no base path is available", async () => {
  const notifications: Array<{ message: string; level: string }> = [];
  let startCalls = 0;

  const result = await resumeAutoAfterProviderDelay(
    {} as any,
    {
      ui: {
        notify(message: string, level?: string) {
          notifications.push({ message, level: level ?? "info" });
        },
      },
    } as any,
    {
      getSnapshot: () => ({
        active: false,
        paused: true,
        stepMode: false,
        basePath: "",
      }),
      startAuto: async () => {
        startCalls += 1;
      },
    },
  );

  assert.equal(result, "missing-base");
  assert.equal(startCalls, 0);
  assert.deepEqual(notifications, [
    {
      message: "Provider error recovery delay elapsed, but no paused auto-mode base path was available. Leaving auto-mode paused.",
      level: "warning",
    },
  ]);
});

// ── Escalating backoff for transient errors (#1166) ─────────────────────────

test("RetryState.consecutiveTransientCount initializes to 0", () => {
  const state = createRetryState();
  assert.equal(state.consecutiveTransientCount, 0);
  assert.equal(state.networkRetryCount, 0);
  assert.equal(state.currentRetryModelId, undefined);
});

test("resetRetryState zeroes consecutiveTransientCount to stop escalating backoff", () => {
  const state = createRetryState();
  state.consecutiveTransientCount = 5;
  state.networkRetryCount = 2;
  state.currentRetryModelId = "some-model";
  resetRetryState(state);
  assert.equal(state.consecutiveTransientCount, 0);
  assert.equal(state.networkRetryCount, 0);
  assert.equal(state.currentRetryModelId, undefined);
});

test("escalating backoff doubles retryAfterMs per consecutive transient error", () => {
  // Contract: retryAfterMs = baseMs * 2 ** Math.max(0, consecutiveTransientCount - 1)
  const base = 30_000;
  const escalate = (count: number) => base * 2 ** Math.max(0, count - 1);
  assert.equal(escalate(1), 30_000);   // first: no escalation
  assert.equal(escalate(2), 60_000);   // second: 2×
  assert.equal(escalate(3), 120_000);  // third: 4×
  assert.equal(escalate(4), 240_000);  // fourth: 8×
  // count=0 is same as count=1 (Math.max floor)
  assert.equal(escalate(0), 30_000);
});

test("resumeAutoAfterProviderDelay calls startAuto with the recorded basePath, not a hidden prompt", async () => {
  const startCalls: string[] = [];
  const result = await resumeAutoAfterProviderDelay(
    {} as any,
    { ui: { notify() {} } } as any,
    {
      getSnapshot: () => ({ active: false, paused: true, stepMode: false, basePath: "/tmp/project" }),
      startAuto: async (_ctx: any, _pi: any, base: string) => { startCalls.push(base); },
    },
  );
  assert.equal(result, "resumed");
  assert.deepEqual(startCalls, ["/tmp/project"]);
});

// ── Codex error extraction (#1166) ──────────────────────────────────────────

test("Codex server_error format is classified as a transient server error", () => {
  // mapCodexEvents formats Codex error events as: "Codex ${errorType}: ${message}"
  // Verify the classifier handles the nested error.type extraction correctly.
  const msg = "Codex server_error: An error occurred while processing your request.";
  const result = classifyError(msg);
  assert.equal(result.kind, "server");
  assert.ok(isTransient(result));
  assert.ok("retryAfterMs" in result && result.retryAfterMs > 0);
});

// ── agent-session retryable regex handles server_error (#1166) ──────────────

test("agent-session retryable error regex matches server_error (underscore)", () => {
  // This regex is extracted from _isRetryableError in agent-session.ts.
  // It must match both "server error" (space) and "server_error" (underscore)
  // to properly classify Codex streaming errors as retryable.
  const retryableRegex = /overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|terminated|retry delay|network.?(?:is\s+)?unavailable|credentials.*expired|temporarily backed off/i;

  // server_error (with underscore — Codex streaming error format)
  assert.ok(retryableRegex.test("Codex server_error: An error occurred"));
  // server error (with space — traditional HTTP error format)
  assert.ok(retryableRegex.test("server error occurred"));
  // internal_error (with underscore)
  assert.ok(retryableRegex.test("internal_error: something went wrong"));
  // internal error (with space)
  assert.ok(retryableRegex.test("internal error"));
  // non-retryable errors must not match
  assert.ok(!retryableRegex.test("model not found"));
});
