/**
 * Regression tests for #2883: gsd_complete_slice tool invocation fails with
 * JSON truncation, causing stuck retry loop.
 *
 * When a GSD tool is invoked with malformed/truncated JSON arguments, the tool
 * execution fails (isError: true). But postUnitPreVerification only checks if
 * the expected artifact exists on disk — it does not know the tool itself failed.
 * When the artifact is missing (because the tool never ran), it sets up
 * pendingVerificationRetry, re-dispatching the same unit with the same truncated
 * input, creating a stuck loop.
 *
 * The fix adds a `lastToolInvocationError` field to AutoSession. When a GSD tool
 * execution ends with isError, the error is recorded. postUnitPreVerification
 * checks this field before retrying — if a tool invocation error occurred, it
 * pauses auto-mode instead of retrying.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { AutoSession } from "../auto/session.ts";

// ─── AutoSession.lastToolInvocationError field ───────────────────────────

describe("#2883: tool invocation error tracking on AutoSession", () => {
  test("lastToolInvocationError defaults to null", () => {
    const s = new AutoSession();
    assert.equal(s.lastToolInvocationError, null);
  });

  test("lastToolInvocationError is cleared on reset()", () => {
    const s = new AutoSession();
    s.lastToolInvocationError = "Validation failed for tool gsd_complete_slice";
    assert.ok(s.lastToolInvocationError);
    s.reset();
    assert.equal(s.lastToolInvocationError, null);
  });

  test("lastToolInvocationError can store truncated JSON error", () => {
    const s = new AutoSession();
    const errorMsg = "Expected ',' or '}' in JSON at position 4096";
    s.lastToolInvocationError = errorMsg;
    assert.equal(s.lastToolInvocationError, errorMsg);
  });
});

// ─── isToolInvocationError classifier ────────────────────────────────────

import { isToolInvocationError, isQueuedUserMessageSkip } from "../auto-tool-tracking.ts";

describe("#2883: isToolInvocationError classification", () => {
  test("detects JSON validation failure pattern", () => {
    assert.equal(
      isToolInvocationError("Validation failed for tool gsd_complete_slice: Expected ',' or '}' in JSON"),
      true,
    );
  });

  test("detects truncated JSON parse error", () => {
    assert.equal(
      isToolInvocationError("Expected ',' or '}' in JSON at position 4096"),
      true,
    );
  });

  test("detects Node v18+ JSON parse variant with property-value text", () => {
    assert.equal(
      isToolInvocationError("Expected ',' or '}' after property value in JSON at position 4096"),
      true,
    );
  });

  test("detects Unexpected end of JSON input", () => {
    assert.equal(
      isToolInvocationError("Unexpected end of JSON input"),
      true,
    );
  });

  test("detects Unexpected token in JSON", () => {
    assert.equal(
      isToolInvocationError("Unexpected token < in JSON at position 0"),
      true,
    );
  });

  test("detects 'Validation failed for tool' prefix", () => {
    assert.equal(
      isToolInvocationError("Validation failed for tool gsd_slice_complete"),
      true,
    );
  });

  test("returns false for normal tool errors (business logic)", () => {
    assert.equal(
      isToolInvocationError("Slice S01 is already complete"),
      false,
    );
  });

  test("returns false for empty string", () => {
    assert.equal(isToolInvocationError(""), false);
  });

  test("returns false for generic error", () => {
    assert.equal(isToolInvocationError("Something went wrong"), false);
  });

  test("returns false for network errors (handled elsewhere)", () => {
    assert.equal(isToolInvocationError("ECONNRESET"), false);
  });
});

// ─── isQueuedUserMessageSkip classifier (#3595) ─────────────────────────

describe("#3595: isQueuedUserMessageSkip classification", () => {
  test("detects exact skip message with period", () => {
    assert.equal(isQueuedUserMessageSkip("Skipped due to queued user message."), true);
  });

  test("detects skip message without period", () => {
    assert.equal(isQueuedUserMessageSkip("Skipped due to queued user message"), true);
  });

  test("detects skip message with surrounding whitespace", () => {
    assert.equal(isQueuedUserMessageSkip("  Skipped due to queued user message.  "), true);
  });

  test("returns false for normal tool errors", () => {
    assert.equal(isQueuedUserMessageSkip("Slice S01 is already complete"), false);
  });

  test("returns false for empty string", () => {
    assert.equal(isQueuedUserMessageSkip(""), false);
  });

  test("returns false for partial match (substring)", () => {
    assert.equal(isQueuedUserMessageSkip("Error: Skipped due to queued user message. Retry later."), false);
  });
});
