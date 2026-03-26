/**
 * Provider error handling tests — consolidated from:
 *   - provider-error-classify.test.ts (classifyError)
 *   - network-error-fallback.test.ts (isTransientNetworkError, getNextFallbackModel)
 *   - agent-end-provider-error.test.ts (pauseAutoForProviderError)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyError, isTransient, isTransientNetworkError } from "../error-classifier.ts";
import { pauseAutoForProviderError } from "../provider-error-pause.ts";
import { getNextFallbackModel } from "../preferences.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// ── Escalating backoff for transient errors (#1166) ─────────────────────────

test("agent-end-recovery.ts tracks consecutive transient errors for escalating backoff", () => {
  const src = readFileSync(join(__dirname, "..", "bootstrap", "agent-end-recovery.ts"), "utf-8");

  assert.ok(
    src.includes("consecutiveTransientCount"),
    "agent-end-recovery.ts must track consecutiveTransientCount for escalating backoff (#1166)",
  );
  assert.ok(
    src.includes("MAX_TRANSIENT_AUTO_RESUMES"),
    "agent-end-recovery.ts must define MAX_TRANSIENT_AUTO_RESUMES to cap infinite retries (#1166)",
  );
});

test("agent-end-recovery.ts resets retry state before resolveAgentEnd on success", () => {
  const src = readFileSync(join(__dirname, "..", "bootstrap", "agent-end-recovery.ts"), "utf-8");

  // After successful agent_end, resetRetryState must be called before resolveAgentEnd.
  assert.ok(
    /resetRetryState[\s\S]{0,250}resolveAgentEnd/.test(src),
    "resetRetryState must be called before resolveAgentEnd on the success path (#1166)",
  );
});

test("agent-end-recovery.ts applies escalating delay for repeated transient errors", () => {
  const src = readFileSync(join(__dirname, "..", "bootstrap", "agent-end-recovery.ts"), "utf-8");

  // Must contain the exponential backoff formula (may span multiple lines)
  assert.ok(
    src.includes("2 ** Math.max(0, retryState.consecutiveTransientCount"),
    "agent-end-recovery.ts must escalate retryAfterMs exponentially for consecutive transient errors (#1166)",
  );
});

// ── Codex error extraction (#1166) ──────────────────────────────────────────

test("openai-codex-responses.ts extracts nested error fields", () => {
  const codexSource = readFileSync(
    join(__dirname, "../../../../../packages/pi-ai/src/providers/openai-codex-responses.ts"),
    "utf-8",
  );

  // Must access event.error.message (nested), not just event.message (top-level)
  assert.ok(
    codexSource.includes("errorObj?.message"),
    "mapCodexEvents must extract message from nested event.error object (#1166)",
  );
  assert.ok(
    codexSource.includes("errorObj?.type"),
    "mapCodexEvents must extract type from nested event.error object (#1166)",
  );
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
