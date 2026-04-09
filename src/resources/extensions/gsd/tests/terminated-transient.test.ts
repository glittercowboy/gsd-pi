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

// --- Catch-all: all V8 JSON.parse variants matched by "in JSON at position" ---

test("V8 JSON.parse: 'No number after minus sign in JSON' is transient (#2882)", () => {
  const result = classifyError("No number after minus sign in JSON at position 42");
  assert.equal(isTransient(result), true);
  assert.equal(result.kind, "stream");
});

test("V8 JSON.parse: 'Expected property value after colon' is transient", () => {
  const result = classifyError("Expected ',' or '}' after property value in JSON at position 108");
  assert.equal(isTransient(result), true);
  assert.equal(result.kind, "stream");
});

test("V8 JSON.parse: 'Bad control character in string literal' is transient", () => {
  const result = classifyError("Bad control character in string literal in JSON at position 5");
  assert.equal(isTransient(result), true);
  assert.equal(result.kind, "stream");
});

test("V8 JSON.parse: 'Bad escaped character' is transient", () => {
  const result = classifyError("Bad escaped character in JSON at position 17");
  assert.equal(isTransient(result), true);
  assert.equal(result.kind, "stream");
});

test("V8 JSON.parse: 'Unexpected number' is transient", () => {
  const result = classifyError("Unexpected number in JSON at position 0");
  assert.equal(isTransient(result), true);
  assert.equal(result.kind, "stream");
});

test("V8 JSON.parse: 'Unexpected string' is transient", () => {
  const result = classifyError("Unexpected string in JSON at position 12");
  assert.equal(isTransient(result), true);
  assert.equal(result.kind, "stream");
});

test("V8 JSON.parse with line/column suffix is transient", () => {
  const result = classifyError("Unexpected token x in JSON at position 99 (line 3 column 14)");
  assert.equal(isTransient(result), true);
  assert.equal(result.kind, "stream");
});
