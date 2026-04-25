/**
 * Unified error classifier for provider/network/server errors.
 *
 * Consolidates patterns from:
 *  - isTransientNetworkError()  in preferences-models.ts
 *  - classifyProviderError()    in provider-error-pause.ts
 *
 * Single entry point: classifyError(errorMsg, retryAfterMs?)
 *
 * @see https://github.com/gsd-build/gsd/issues/2577
 */

// ── ErrorClass discriminated union ──────────────────────────────────────────

export type ErrorClass =
  | { kind: "network";      retryAfterMs: number }
  | { kind: "rate-limit";   retryAfterMs: number }
  | { kind: "server";       retryAfterMs: number }
  | { kind: "stream";       retryAfterMs: number }
  | { kind: "connection";   retryAfterMs: number }
  | { kind: "model-error" }
  | { kind: "unsupported-model" }
  | { kind: "permanent" }
  | { kind: "unknown" };

// ── RetryState ──────────────────────────────────────────────────────────────

export interface RetryState {
  networkRetryCount: number;
  consecutiveTransientCount: number;
  currentRetryModelId: string | undefined;
}

export function createRetryState(): RetryState {
  return { networkRetryCount: 0, consecutiveTransientCount: 0, currentRetryModelId: undefined };
}

export function resetRetryState(state: RetryState): void {
  state.networkRetryCount = 0;
  state.consecutiveTransientCount = 0;
  state.currentRetryModelId = undefined;
}

// ── Classification ──────────────────────────────────────────────────────────

const PERMANENT_RE = /auth|unauthorized|forbidden|invalid.*key|invalid.*api|billing|quota exceeded|account/i;
// Include provider-specific quota-window phrasing like:
// - "You've hit your limit"
// - "usage limit" / "quota reached"
// - "out of extra usage"
const RATE_LIMIT_RE = /rate.?limit|too many requests|429|hit your limit|usage limit|out of extra usage|quota (?:reached|hit)|limit.*resets?/i;
// OpenRouter affordability-style quota errors should be treated as transient
// so core retry logic can lower maxTokens and continue in-session.
const AFFORDABILITY_RE = /requires more credits|can only afford|insufficient credits|not enough credits|fewer max_tokens/i;
// "Stream idle timeout" and "partial response received" are emitted by the SDK/harness
// for mid-stream disconnects. Both indicate a transient network-level interruption.
// See: https://github.com/gsd-build/gsd-2/issues/4558
const NETWORK_RE = /network|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|fetch failed|connection.*reset|dns|unexpected eof|stream idle timeout|partial response received/i;
// Context overflow errors (context window/length exceeded) should be treated as server-class
// transient errors so auto-mode can retry with reduced budget or fall back to a larger-context model.
// See: https://github.com/gsd-build/gsd-2/issues/4528
const SERVER_RE = /internal server error|500|502|503|overloaded|server_error|api_error|service.?unavailable|context (?:window|length) exceed|context window exceed/i;
// ECONNRESET/ECONNREFUSED are in NETWORK_RE (same-model retry first).
const CONNECTION_RE = /terminated|connection.?(?:refused|error)|other side closed|EPIPE|network.?(?:is\s+)?unavailable|stream_exhausted(?:_without_result)?/i;
// Catch-all for V8 JSON.parse errors: all modern variants end with "in JSON at position \d+".
// This eliminates the need to enumerate every error message variant individually.
const STREAM_RE = /in JSON at position \d+|Unexpected end of JSON|SyntaxError.*JSON/i;
const RESET_DELAY_RE = /reset in (\d+)s/i;

// Provider-side model entitlement rejection: the SDK accepted the model switch,
// but the provider refused at request time because the current account/plan/tier
// cannot use that model.  Must match all three of: a model/deployment token,
// a negative-entitlement indicator, and an account/plan/tier/subscription token.
// Requiring all three keeps generic "account suspended" errors in `permanent`
// (no model token) while catching the phrasings providers actually use.
// See issue #4513.
const UNSUPPORTED_MODEL_MODEL_RE = /\b(?:model|deployment)\b/i;
const UNSUPPORTED_MODEL_INDICATOR_RE =
  /\bnot support(?:ed|s)?\b|\bunsupported\b|\bnot available\b|\bunavailable\b|\bno access\b|\bdoes(?:n['’]t| not) (?:have access|support)\b|\bnot authori[sz]ed\b/i;
const UNSUPPORTED_MODEL_SCOPE_RE = /\b(?:account|plan|tier|subscription)\b/i;

/**
 * Classify an error message into one of the ErrorClass kinds.
 *
 * Classification order:
 *  1. Permanent (auth/billing/quota) — unless also rate-limited
 *  2. Rate limit (429, rate.?limit, too many requests, hit-your-limit/quota-window phrasing)
 *  3. Network (ECONNRESET, ETIMEDOUT, socket hang up, fetch failed, dns)
 *  4. Stream truncation (malformed JSON from mid-stream cut)
 *  5. Server (500/502/503, overloaded, server_error)
 *  6. Connection (terminated, ECONNREFUSED, EPIPE, other side closed)
 *  7. Unknown
 */
export function classifyError(errorMsg: string, retryAfterMs?: number): ErrorClass {
  const isPermanent = PERMANENT_RE.test(errorMsg);
  const isRateLimit = RATE_LIMIT_RE.test(errorMsg) || AFFORDABILITY_RE.test(errorMsg);
  const isUnsupportedModel =
    UNSUPPORTED_MODEL_MODEL_RE.test(errorMsg) &&
    UNSUPPORTED_MODEL_INDICATOR_RE.test(errorMsg) &&
    UNSUPPORTED_MODEL_SCOPE_RE.test(errorMsg);

  // 0. Unsupported model (account/plan entitlement rejection) — checked before
  //    `permanent` because PERMANENT_RE also matches /account/i and would
  //    otherwise swallow these errors, blocking the blocklist-driven fallback.
  //    Rate limit still wins when both patterns appear (a throttled account is
  //    not an entitlement failure).
  if (isUnsupportedModel && !isRateLimit) {
    return { kind: "unsupported-model" };
  }

  // 1. Permanent — but rate limit takes precedence
  if (isPermanent && !isRateLimit) {
    return { kind: "permanent" };
  }

  // 2. Rate limit
  if (isRateLimit) {
    if (retryAfterMs != null && retryAfterMs > 0) {
      return { kind: "rate-limit", retryAfterMs };
    }
    const resetMatch = errorMsg.match(RESET_DELAY_RE);
    const delayMs = resetMatch ? Number(resetMatch[1]) * 1000 : 60_000;
    return { kind: "rate-limit", retryAfterMs: delayMs };
  }

  // 3. Network errors — same-model retry candidate
  if (NETWORK_RE.test(errorMsg)) {
    // Exclude if also matches permanent signals (already handled above for
    // rate-limit, but double-check for non-rate-limit permanent overlap like
    // "billing" appearing alongside "network").
    return { kind: "network", retryAfterMs: retryAfterMs ?? 3_000 };
  }

  // 4. Stream truncation — downstream symptom of connection drop
  if (STREAM_RE.test(errorMsg)) {
    return { kind: "stream", retryAfterMs: retryAfterMs ?? 15_000 };
  }

  // 5. Server errors — try fallback model
  if (SERVER_RE.test(errorMsg)) {
    return { kind: "server", retryAfterMs: retryAfterMs ?? 30_000 };
  }

  // 6. Connection errors — try fallback model
  if (CONNECTION_RE.test(errorMsg)) {
    return { kind: "connection", retryAfterMs: retryAfterMs ?? 15_000 };
  }

  // 7. Unknown
  return { kind: "unknown" };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Returns true for all transient (auto-resumable) error kinds. */
export function isTransient(cls: ErrorClass): boolean {
  switch (cls.kind) {
    case "network":
    case "rate-limit":
    case "server":
    case "stream":
    case "connection":
      return true;
    default:
      return false;
  }
}

/**
 * Backward-compatible thin wrapper.
 *
 * Returns true when the error is a transient *network* error specifically
 * (worth retrying the same model). Permanent signals (auth, billing, quota)
 * cause this to return false even if a network keyword is present.
 */
export function isTransientNetworkError(errorMsg: string): boolean {
  if (!errorMsg) return false;
  const cls = classifyError(errorMsg);
  return cls.kind === "network";
}
