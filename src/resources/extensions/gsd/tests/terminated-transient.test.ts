/**
 * terminated-transient.test.ts — Regression test for #2309.
 *
 * classifyError should treat 'terminated' errors (process killed,
 * connection reset) as transient with auto-resume, not permanent.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { classifyError, isTransient } from "../error-classifier.ts";

test("#2309: 'terminated' errors should be classified as transient", () => {
  const result = classifyError("terminated");
  assert.equal(isTransient(result), true, "'terminated' should be transient");
  assert.equal(result.kind, "connection", "'terminated' matches connection");
  assert.ok("retryAfterMs" in result && result.retryAfterMs > 0, "'terminated' should have a retry delay");
  assert.equal("retryAfterMs" in result && result.retryAfterMs, 15_000, "'terminated' should use 15s backoff");
});

test("#2309: 'connection reset by peer' errors should be classified as transient (network)", () => {
  const result = classifyError("connection reset by peer");
  assert.equal(isTransient(result), true, "'connection reset by peer' should be transient");
  assert.equal(result.kind, "network", "'connection reset by peer' matches NETWORK_RE (connection.*reset) before CONNECTION_RE");
  assert.equal("retryAfterMs" in result && result.retryAfterMs, 3_000, "network errors use 3s backoff");
});

test("#2309: 'other side closed' errors should be classified as transient", () => {
  const result = classifyError("other side closed the connection");
  assert.equal(isTransient(result), true, "'other side closed' should be transient");
  assert.equal(result.kind, "connection", "'other side closed' matches CONNECTION_RE");
});

test("#2309: 'fetch failed' errors should be classified as transient", () => {
  const result = classifyError("fetch failed: network error");
  assert.equal(isTransient(result), true, "'fetch failed' should be transient");
  assert.equal(result.kind, "network", "'fetch failed' matches NETWORK_RE");
  assert.equal("retryAfterMs" in result && result.retryAfterMs, 3_000, "network errors use 3s backoff");
});

test("#2309: 'connection refused' errors should be classified as transient", () => {
  const result = classifyError("ECONNREFUSED: connection refused");
  assert.equal(isTransient(result), true, "'connection refused' should be transient");
  assert.equal(result.kind, "network", "'ECONNREFUSED' matches NETWORK_RE (same-model retry)");
});

test("#2309: permanent errors are still permanent", () => {
  const authResult = classifyError("unauthorized: invalid API key");
  assert.equal(isTransient(authResult), false, "auth errors should stay permanent");
  assert.equal(authResult.kind, "permanent", "auth errors are permanent");
  assert.equal("retryAfterMs" in authResult, false, "permanent errors have no retryAfterMs");
});

test("#2309: rate limits are still transient", () => {
  const rlResult = classifyError("rate limit exceeded (429)");
  assert.equal(isTransient(rlResult), true, "rate limits are still transient");
  assert.equal(rlResult.kind, "rate-limit", "rate limits are flagged as rate-limit kind");
});

// --- #2572: stream-truncation JSON parse errors should be transient ---

test("#2572: 'Expected double-quoted property name' (truncated stream) is transient", () => {
  const result = classifyError("Expected double-quoted property name in JSON at position 23 (line 1 column 24)");
  assert.equal(isTransient(result), true, "truncated-stream JSON parse error should be transient");
  assert.equal(result.kind, "stream", "JSON parse errors are stream kind");
  assert.equal("retryAfterMs" in result && result.retryAfterMs, 15_000, "should use 15s backoff");
});

const streamVariantCases = [
  "Expected ',' or '}' after property value in JSON at position 2056 (line 1 column 2057)",
  "Expected ':' after property name in JSON at position 42 (line 1 column 43)",
  "Expected property name or '}' in JSON at position 0 (line 1 column 1)",
  "Unterminated string in JSON at position 100 (line 1 column 101)",
];

for (const errorMsg of streamVariantCases) {
  test(`#2916: '${errorMsg}' is transient`, () => {
    const result = classifyError(errorMsg);
    assert.equal(isTransient(result), true, `'${errorMsg}' should be transient`);
    assert.equal(result.kind, "stream", `'${errorMsg}' should be stream`);
    assert.equal("retryAfterMs" in result && result.retryAfterMs, 15_000, "should use 15s backoff");
  });
}

test("#2572: 'Unexpected end of JSON input' (truncated stream) is transient", () => {
  const result = classifyError("Unexpected end of JSON input");
  assert.equal(isTransient(result), true, "'Unexpected end of JSON input' should be transient");
  assert.equal(result.kind, "stream", "JSON parse errors are stream kind");
});

test("#2572: 'Unexpected token' in JSON (truncated stream) is transient", () => {
  const result = classifyError("Unexpected token < in JSON at position 0");
  assert.equal(isTransient(result), true, "'Unexpected token in JSON' should be transient");
  assert.equal(result.kind, "stream", "JSON parse errors are stream kind");
});

test("#2572: 'SyntaxError' with JSON context (truncated stream) is transient", () => {
  const result = classifyError("SyntaxError: JSON.parse: unexpected character at line 1 column 1");
  assert.equal(isTransient(result), true, "'SyntaxError...JSON' should be transient");
  assert.equal(result.kind, "stream", "JSON parse errors are stream kind");
});

const nonJsonGuardCases = [
  "Expected ',' or '}' after property value at position 2056 (line 1 column 2057)",
  "Expected ':' after property name at position 42 (line 1 column 43)",
  "Unterminated string at position 100 (line 1 column 101)",
  "SyntaxError: unexpected character at line 1 column 1",
];

for (const errorMsg of nonJsonGuardCases) {
  test(`#2916: '${errorMsg}' stays non-transient without JSON context`, () => {
    const result = classifyError(errorMsg);
    assert.equal(isTransient(result), false, `'${errorMsg}' should not be transient`);
    assert.equal(result.kind, "unknown", `'${errorMsg}' should stay unknown`);
  });
}
