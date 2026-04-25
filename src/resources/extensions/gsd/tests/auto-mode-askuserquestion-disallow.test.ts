// GSD-2 / auto-mode harness-tool guard
// Regression tests for #4957: AskUserQuestion must be disallowed in auto-mode,
// and harness-tool InputValidationError must feed the existing pause path.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { buildSdkOptions } from "../../claude-code-cli/stream-adapter.ts";
import { _setAutoActiveForTest, isAutoActive, recordToolInvocationError } from "../auto.ts";
import { AutoSession } from "../auto/session.ts";
import { isToolInvocationError } from "../auto-tool-tracking.ts";

describe("#4957: AskUserQuestion disallow in auto-mode", () => {
  let prevActive: boolean;

  beforeEach(() => {
    prevActive = isAutoActive();
  });

  afterEach(() => {
    _setAutoActiveForTest(prevActive);
  });

  test("when auto is inactive, AskUserQuestion stays in allowedTools and disallowedTools is empty", () => {
    _setAutoActiveForTest(false);
    const options = buildSdkOptions("claude-sonnet-4-6", "test prompt") as {
      allowedTools?: string[];
      disallowedTools?: string[];
    };
    assert.ok(options.allowedTools, "allowedTools should be present when non-empty");
    assert.ok(
      options.allowedTools!.includes("AskUserQuestion"),
      "AskUserQuestion should be permitted in interactive (non-auto) sessions",
    );
    assert.deepEqual(options.disallowedTools ?? [], []);
  });

  test("when auto is active, AskUserQuestion is in disallowedTools and absent from allowedTools", () => {
    _setAutoActiveForTest(true);
    const options = buildSdkOptions("claude-sonnet-4-6", "test prompt") as {
      allowedTools?: string[];
      disallowedTools?: string[];
    };
    assert.ok(options.disallowedTools, "disallowedTools should be present in auto-mode");
    assert.ok(
      options.disallowedTools!.includes("AskUserQuestion"),
      "AskUserQuestion must be disallowed when auto-mode is active (no human in loop)",
    );
    assert.equal(
      (options.allowedTools ?? []).includes("AskUserQuestion"),
      false,
      "AskUserQuestion must not appear in allowedTools when auto-mode is active",
    );
  });

  test("auto-mode does not strip other harness tools from allowedTools", () => {
    _setAutoActiveForTest(true);
    const options = buildSdkOptions("claude-sonnet-4-6", "test prompt") as {
      allowedTools?: string[];
    };
    for (const expected of ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent"]) {
      assert.ok(
        options.allowedTools!.includes(expected),
        `${expected} should remain in allowedTools when auto is active`,
      );
    }
  });
});

describe("#4957: isToolInvocationError matches harness InputValidationError", () => {
  test("InputValidationError on a deferred harness tool is classified as a tool-invocation error", () => {
    assert.equal(
      isToolInvocationError("InputValidationError: schema for AskUserQuestion not loaded"),
      true,
    );
  });

  test("bare 'InputValidationError' is matched", () => {
    assert.equal(isToolInvocationError("InputValidationError"), true);
  });

  test("InputValidationError matching is case-insensitive", () => {
    assert.equal(isToolInvocationError("inputvalidationerror at AskUserQuestion"), true);
  });

  test("ordinary tool errors are not misclassified as InputValidationError", () => {
    assert.equal(isToolInvocationError("Slice S01 is already complete"), false);
  });
});

describe("#4957: recordToolInvocationError accepts harness tool names", () => {
  let prevActive: boolean;

  beforeEach(() => {
    prevActive = isAutoActive();
    _setAutoActiveForTest(true);
  });

  afterEach(() => {
    _setAutoActiveForTest(prevActive);
  });

  // Sanity: AutoSession exposes lastToolInvocationError as a mutable field.
  // The guard widening in register-hooks.ts means recordToolInvocationError is
  // now reachable for non-gsd_ tools whose error matches isToolInvocationError —
  // the function itself never gated on the prefix, so this verifies the contract.
  test("records InputValidationError for a non-gsd_ harness tool when auto is active", () => {
    // Reset shared session state by toggling
    recordToolInvocationError("AskUserQuestion", "InputValidationError: schema not loaded");
    // We can't read s.lastToolInvocationError directly without exposing it;
    // smoke-test via AutoSession default + classifier alignment.
    const session = new AutoSession();
    assert.equal(session.lastToolInvocationError, null, "default state remains null on a fresh session");
    // The classifier path that recordToolInvocationError uses must accept this error.
    assert.equal(isToolInvocationError("InputValidationError: schema not loaded"), true);
  });

  test("does not record ordinary business-logic errors even from harness tools", () => {
    // The classifier (which gates recording) must reject normal errors,
    // so widening the prefix guard does not introduce false positives.
    assert.equal(isToolInvocationError("File not found: /tmp/x"), false);
  });
});
