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
import { resumeAutoAfterProviderDelay } from "../bootstrap/provider-error-resume.ts";
import { MAX_TRANSIENT_AUTO_RESUMES } from "../bootstrap/agent-end-recovery.ts";
import { getNextFallbackModel } from "../preferences.ts";
// Zero-import module — imported by path rather than through the package
// barrel to avoid pulling the full AgentSession / @gsd/pi-ai dep graph into
// this unit test (see #4837).
import { RETRYABLE_ERROR_RE } from "../../../../../packages/pi-coding-agent/src/core/retryable-error-regex.ts";

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

test("classifyError treats Anthropic quota-window phrasing as transient rate-limit (#4373)", () => {
  const result = classifyError("You've hit your limit · resets soon");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "rate-limit");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 60_000);
});

test("classifyError treats usage-limit phrasing as transient rate-limit (#4373)", () => {
  const result = classifyError("usage limit reached for this workspace");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "rate-limit");
});

test("classifyError treats extra-usage phrasing as transient rate-limit (#4397)", () => {
  const result = classifyError("You are out of extra usage. Please wait before retrying.");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "rate-limit");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 60_000);
});

test("classifyError treats OpenRouter affordability errors as transient rate-limit class", () => {
  const result = classifyError(
    "402 This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 329.",
  );
  assert.ok(isTransient(result));
  assert.equal(result.kind, "rate-limit");
  assert.ok("retryAfterMs" in result && result.retryAfterMs > 0);
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

test("classifyError treats plain 'Connection error.' as transient connection failure (#3594)", () => {
  const result = classifyError("Connection error.");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "connection");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 15_000);
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

// ── unsupported-model: account/plan entitlement rejection (#4513) ──────────

test("classifyError: Codex ChatGPT-account entitlement rejection is unsupported-model", () => {
  const result = classifyError(
    "The 'gpt-5.1-codex-max' model is not supported when using Codex with a ChatGPT account.",
  );
  assert.equal(result.kind, "unsupported-model");
  assert.ok(!isTransient(result));
});

test("classifyError: 'model not available for this plan' is unsupported-model", () => {
  const result = classifyError("This model is not available for your current plan.");
  assert.equal(result.kind, "unsupported-model");
});

test("classifyError: 'account does not have access to model' is unsupported-model", () => {
  const result = classifyError("Your account does not have access to the gpt-5 model.");
  assert.equal(result.kind, "unsupported-model");
});

test("classifyError: 'tier does not support deployment' is unsupported-model", () => {
  const result = classifyError("The free tier does not support this deployment.");
  assert.equal(result.kind, "unsupported-model");
});

test("classifyError: 'account suspended' stays permanent (not unsupported-model)", () => {
  const result = classifyError("Your account has been suspended. Contact support.");
  assert.equal(result.kind, "permanent");
});

test("classifyError: 'invalid account' stays permanent", () => {
  const result = classifyError("invalid account credentials");
  assert.equal(result.kind, "permanent");
});

test("classifyError: rate limit on unsupported-model phrasing stays rate-limit", () => {
  // A throttled account is not an entitlement failure.
  const result = classifyError(
    "429 rate limit — model not supported when using your account right now",
  );
  assert.equal(result.kind, "rate-limit");
});

// ── STREAM_RE: V8 JSON parse error variants (#2916) ────────────────────────

test("classifyError: 'Expected comma/brace after property value in JSON' is transient stream", () => {
  const result = classifyError(
    "Expected ',' or '}' after property value in JSON at position 2056 (line 1 column 2057)"
  );
  assert.equal(result.kind, "stream");
  assert.ok(isTransient(result));
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 15_000);
});

test("classifyError: 'Expected colon after property name in JSON' is transient stream", () => {
  const result = classifyError(
    "Expected ':' after property name in JSON at position 500 (line 1 column 501)"
  );
  assert.equal(result.kind, "stream");
  assert.ok(isTransient(result));
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 15_000);
});

test("classifyError: 'Expected property name or brace in JSON' is transient stream", () => {
  const result = classifyError(
    "Expected property name or '}' in JSON at position 42 (line 1 column 43)"
  );
  assert.equal(result.kind, "stream");
  assert.ok(isTransient(result));
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 15_000);
});

test("classifyError: 'Unterminated string in JSON' is transient stream", () => {
  const result = classifyError(
    "Unterminated string in JSON at position 100 (line 1 column 101)"
  );
  assert.equal(result.kind, "stream");
  assert.ok(isTransient(result));
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 15_000);
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

test("isTransientNetworkError detects unexpected EOF", () => {
  assert.ok(isTransientNetworkError("unexpected EOF"));
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
      resetTransientRetryState: () => {},
      resetSessionTimeoutState: () => {},
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
      resetTransientRetryState: () => {},
      resetSessionTimeoutState: () => {},
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
      resetTransientRetryState: () => {},
      resetSessionTimeoutState: () => {},
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

test("resumeAutoAfterProviderDelay resets provider retry state before restarting auto-mode", async () => {
  const calls: string[] = [];

  const result = await resumeAutoAfterProviderDelay(
    {} as any,
    { ui: { notify() {} } } as any,
    {
      getSnapshot: () => ({
        active: false,
        paused: true,
        stepMode: false,
        basePath: "/tmp/project",
      }),
      resetTransientRetryState: () => {
        calls.push("reset-transient");
      },
      resetSessionTimeoutState: () => {
        calls.push("reset-session-timeout");
      },
      startAuto: async () => {
        calls.push("start-auto");
      },
    },
  );

  assert.equal(result, "resumed");
  assert.deepEqual(calls, [
    "reset-transient",
    "reset-session-timeout",
    "start-auto",
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

test("agent-end-recovery.ts resumes transient provider pauses through startAuto instead of a hidden prompt", () => {
  const src = readFileSync(join(__dirname, "..", "bootstrap", "agent-end-recovery.ts"), "utf-8");

  assert.ok(
    src.includes("resumeAutoAfterProviderDelay"),
    "agent-end-recovery.ts must resume paused auto-mode through resumeAutoAfterProviderDelay (#2813)",
  );
  assert.ok(
    !src.includes('Continue execution — provider error recovery delay elapsed.'),
    "transient provider resume must not rely on a hidden continue prompt (#2813)",
  );
});

test("agent-end-recovery.ts does not defer rate-limit errors to core retry handler before fallback (#4373)", () => {
  const src = readFileSync(join(__dirname, "..", "bootstrap", "agent-end-recovery.ts"), "utf-8");
  assert.ok(
    src.includes('if (isTransient(cls) && cls.kind !== "rate-limit")'),
    "rate-limit errors must bypass transient core-retry deferral so fallback can execute (#4373)",
  );
});

test("agent-end-recovery.ts updates dashboard dispatched model after fallback switch", () => {
  const src = readFileSync(join(__dirname, "..", "bootstrap", "agent-end-recovery.ts"), "utf-8");
  assert.ok(
    src.includes("setCurrentDispatchedModelId"),
    "agent-end-recovery.ts should update currentDispatchedModelId when recovery switches model",
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

// ── Fix 1: resetTransientRetryState resets module-level singleton ────────────

test("resetTransientRetryState is exported from agent-end-recovery.ts", () => {
  const src = readFileSync(join(__dirname, "..", "bootstrap", "agent-end-recovery.ts"), "utf-8");
  assert.ok(
    src.includes("export function resetTransientRetryState"),
    "agent-end-recovery.ts must export resetTransientRetryState for provider-error-resume.ts",
  );
});

// ── Fix 2: Session creation timeout treated as transient in phases.ts ───────

test("phases.ts handles timeout session-creation failures with pause instead of stopAuto", () => {
  const src = readFileSync(join(__dirname, "..", "auto", "phases.ts"), "utf-8");

  // The cancelled + isTransient session-start path must pause, not hard-stop
  assert.ok(
    src.includes('errorCategory === "timeout"'),
    "phases.ts must check errorCategory === 'timeout' on transient cancelled unitResults",
  );
  assert.ok(
    src.includes('errorCategory === "session-failed"'),
    "phases.ts must also check errorCategory === 'session-failed' on transient cancelled unitResults",
  );
  // Must call pauseAuto or pauseAutoForProviderError (not stopAuto) for timeout cancellations
  assert.ok(
    /errorCategory === "timeout"[\s\S]{0,1800}pauseAuto/.test(src),
    "phases.ts must call pauseAuto for session-timeout failures (not stopAuto or continue)",
  );
  assert.ok(
    /errorCategory === "session-failed"[\s\S]{0,700}pauseAuto/.test(src),
    "phases.ts must call pauseAuto for transient session-start failures (not stopAuto or continue)",
  );
  // Must NOT use action: "continue" for transient cancellations (causes infinite loops)
  assert.ok(
    !/isTransient[\s\S]{0,500}action:\s*"continue"/.test(src),
    "phases.ts must NOT return action:continue for cancelled units — use break+pause instead",
  );
});

// ── Fix 2b: Session creation timeout schedules auto-resume timer ─────────────

test("phases.ts schedules auto-resume timer for session creation timeouts", () => {
  const src = readFileSync(join(__dirname, "..", "auto", "phases.ts"), "utf-8");

  // Must use pauseAutoForProviderError (not bare pauseAuto) for session-timeout
  assert.ok(
    src.includes("pauseAutoForProviderError"),
    "phases.ts must use pauseAutoForProviderError for session-timeout auto-resume",
  );
  // Must schedule resume via resumeAutoAfterProviderDelay
  assert.ok(
    src.includes("resumeAutoAfterProviderDelay"),
    "phases.ts must schedule resume via resumeAutoAfterProviderDelay",
  );
  // Must track consecutive session timeouts
  assert.ok(
    src.includes("consecutiveSessionTimeouts"),
    "phases.ts must track consecutive session timeouts for escalating backoff",
  );
  // Must cap session timeout auto-resumes
  assert.ok(
    /MAX_SESSION_TIMEOUT_AUTO_RESUMES\s*=\s*\d+/.test(src),
    "phases.ts must cap session timeout auto-resumes",
  );
});

test("phases.ts differentiates session creation timeout from unit hard timeout", () => {
  const src = readFileSync(join(__dirname, "..", "auto", "phases.ts"), "utf-8");
  assert.ok(
    src.includes("Session creation timed out"),
    "phases.ts must check for 'Session creation timed out' message to differentiate from unit hard timeout",
  );
});

test("phases.ts resets session timeout counter on successful unit completion", () => {
  const src = readFileSync(join(__dirname, "..", "auto", "phases.ts"), "utf-8");
  const resetIdx = src.indexOf("consecutiveSessionTimeouts = 0");
  const closeoutIdx = src.indexOf("closeoutUnit");
  assert.ok(
    resetIdx !== -1 && closeoutIdx !== -1 && resetIdx < closeoutIdx,
    "consecutiveSessionTimeouts must reset before closeoutUnit (on success path)",
  );
});

// ── Fix 3: MAX_TRANSIENT_AUTO_RESUMES raised to 8 ───────────────────────────

test("MAX_TRANSIENT_AUTO_RESUMES is at least 8 for sustained overload resilience", () => {
  // Import the real constant rather than regex-scraping the source literal —
  // this way the assertion cannot silently drift if the symbol is renamed or
  // the value is moved. See #4837.
  assert.ok(
    MAX_TRANSIENT_AUTO_RESUMES >= 8,
    `MAX_TRANSIENT_AUTO_RESUMES must be >= 8 for sustained overload resilience, got ${MAX_TRANSIENT_AUTO_RESUMES}`,
  );
});

// ── Stream idle timeout / partial response (#4558) ──────────────────────────

test("classifyError: 'Stream idle timeout - partial response received' is transient network", () => {
  const result = classifyError("API Error: Stream idle timeout - partial response received");
  assert.ok(isTransient(result), "stream idle timeout must be transient");
  assert.equal(result.kind, "network");
  assert.ok("retryAfterMs" in result && result.retryAfterMs > 0);
});

test("classifyError: 'stream idle timeout' (lowercase) is transient network", () => {
  const result = classifyError("stream idle timeout");
  assert.ok(isTransient(result), "lowercase stream idle timeout must be transient");
  assert.equal(result.kind, "network");
});

test("classifyError: 'partial response received' alone is transient network", () => {
  const result = classifyError("partial response received");
  assert.ok(isTransient(result), "partial response received must be transient");
  assert.equal(result.kind, "network");
});

// ── Context overflow / context window exceeded (#4528) ───────────────────────

test("classifyError: MiniMax context window error is transient server", () => {
  const result = classifyError("400 invalid params, context window exceeds limit (2013)");
  assert.ok(isTransient(result), "context window exceeded must be transient");
  assert.equal(result.kind, "server");
});

test("classifyError: 'context length exceeded' is transient server", () => {
  const result = classifyError("context length exceeded: max 128000 tokens");
  assert.ok(isTransient(result), "context length exceeded must be transient");
  assert.equal(result.kind, "server");
});

test("classifyError: 'context window' with 'exceed' is transient server", () => {
  const result = classifyError("context window exceeded for this model");
  assert.ok(isTransient(result), "context window exceeded must be transient");
  assert.equal(result.kind, "server");
});

// ── agent-session retryable regex handles server_error (#1166) ──────────────

test("agent-session retryable error regex matches server_error (underscore)", () => {
  // Import the real regex from the retry-handler so this test can never
  // silently drift from runtime behaviour. The regex must match both
  // "server error" (space) and "server_error" (underscore) to properly
  // classify Codex streaming errors as retryable.
  // "temporarily backed off" is intentionally excluded — see #3429 / #4837.

  // server_error (with underscore — Codex streaming error format)
  assert.ok(RETRYABLE_ERROR_RE.test("Codex server_error: An error occurred"));
  // server error (with space — traditional HTTP error format)
  assert.ok(RETRYABLE_ERROR_RE.test("server error occurred"));
  // internal_error (with underscore)
  assert.ok(RETRYABLE_ERROR_RE.test("internal_error: something went wrong"));
  // internal error (with space)
  assert.ok(RETRYABLE_ERROR_RE.test("internal error"));
  // non-retryable errors must not match
  assert.ok(!RETRYABLE_ERROR_RE.test("model not found"));
  // "temporarily backed off" must NOT be matched (intentional exclusion #3429)
  assert.ok(!RETRYABLE_ERROR_RE.test("temporarily backed off"));
});
