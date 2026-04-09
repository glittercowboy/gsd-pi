/**
 * Tests for #2676: idle watchdog must exempt user-interactive tools
 * (ask_user_questions, secure_env_collect) from stall detection.
 */
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  markToolStart,
  markToolEnd,
  hasInteractiveToolInFlight,
  getInFlightToolCount,
  getOldestInFlightToolStart,
  getOldestInFlightToolAgeMs,
  clearInFlightTools,
} from "../auto-tool-tracking.ts";

// These tests call the tracking module directly (bypassing the auto.ts
// wrapper which guards on s.active) so we always pass isActive=true.

beforeEach(() => {
  clearInFlightTools();
});

describe("hasInteractiveToolInFlight", () => {
  test("returns false when no tools are in-flight", () => {
    assert.equal(hasInteractiveToolInFlight(), false);
  });

  test("returns false when only non-interactive tools are in-flight", () => {
    markToolStart("call-1", true, "bash");
    markToolStart("call-2", true, "read");
    assert.equal(hasInteractiveToolInFlight(), false);
  });

  test("returns true when ask_user_questions is in-flight", () => {
    markToolStart("call-1", true, "bash");
    markToolStart("call-2", true, "ask_user_questions");
    assert.equal(hasInteractiveToolInFlight(), true);
  });

  test("returns true when secure_env_collect is in-flight", () => {
    markToolStart("call-1", true, "secure_env_collect");
    assert.equal(hasInteractiveToolInFlight(), true);
  });

  test("returns false after interactive tool completes", () => {
    markToolStart("call-1", true, "ask_user_questions");
    assert.equal(hasInteractiveToolInFlight(), true);
    markToolEnd("call-1");
    assert.equal(hasInteractiveToolInFlight(), false);
  });

  test("returns true if one of multiple tools is interactive", () => {
    markToolStart("call-1", true, "bash");
    markToolStart("call-2", true, "edit");
    markToolStart("call-3", true, "ask_user_questions");
    markToolStart("call-4", true, "write");
    assert.equal(hasInteractiveToolInFlight(), true);
  });
});

describe("toolName tracking in markToolStart", () => {
  test("defaults toolName to 'unknown' when not provided", () => {
    markToolStart("call-1", true);
    // unknown tool should not be treated as interactive
    assert.equal(hasInteractiveToolInFlight(), false);
    assert.equal(getInFlightToolCount(), 1);
  });

  test("no-ops when isActive is false", () => {
    markToolStart("call-1", false, "ask_user_questions");
    assert.equal(getInFlightToolCount(), 0);
    assert.equal(hasInteractiveToolInFlight(), false);
  });
});

describe("existing tracking behavior preserved with toolName", () => {
  test("getInFlightToolCount tracks correctly", () => {
    assert.equal(getInFlightToolCount(), 0);
    markToolStart("call-1", true, "bash");
    assert.equal(getInFlightToolCount(), 1);
    markToolStart("call-2", true, "ask_user_questions");
    assert.equal(getInFlightToolCount(), 2);
    markToolEnd("call-1");
    assert.equal(getInFlightToolCount(), 1);
    markToolEnd("call-2");
    assert.equal(getInFlightToolCount(), 0);
  });

  test("getOldestInFlightToolStart returns correct timestamp", () => {
    assert.equal(getOldestInFlightToolStart(), undefined);
    const before = Date.now();
    markToolStart("call-1", true, "bash");
    const after = Date.now();
    const oldest = getOldestInFlightToolStart();
    assert.ok(oldest !== undefined);
    assert.ok(oldest! >= before && oldest! <= after);
  });

  test("getOldestInFlightToolAgeMs returns 0 with no tools", () => {
    assert.equal(getOldestInFlightToolAgeMs(), 0);
  });

  test("getOldestInFlightToolAgeMs returns positive value with tools", () => {
    markToolStart("call-1", true, "read");
    const age = getOldestInFlightToolAgeMs();
    assert.ok(age >= 0, `age should be non-negative, got ${age}`);
  });

  test("clearInFlightTools resets all state", () => {
    markToolStart("call-1", true, "ask_user_questions");
    markToolStart("call-2", true, "bash");
    assert.equal(getInFlightToolCount(), 2);
    assert.equal(hasInteractiveToolInFlight(), true);
    clearInFlightTools();
    assert.equal(getInFlightToolCount(), 0);
    assert.equal(hasInteractiveToolInFlight(), false);
  });
});
