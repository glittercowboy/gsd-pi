/**
 * Tests for ask_user_questions per-turn deduplication (#3513).
 *
 * Verifies:
 * 1. The dedup cache prevents duplicate question prompts within a turn
 * 2. The cache resets at turn boundaries
 * 3. Interactive tools have a stricter loop guard threshold
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  checkToolCallLoop,
  resetToolCallLoopGuard,
} from "../bootstrap/tool-call-loop-guard.ts";

describe("ask_user_questions dedup — loop guard threshold (#3513)", () => {
  beforeEach(() => {
    resetToolCallLoopGuard();
  });

  test("ask_user_questions is blocked after 1 identical call (threshold = 1)", () => {
    const args = {
      questions: [{ id: "q1", header: "Test", question: "Pick one", options: [{ label: "A", description: "a" }] }],
    };

    // First call is allowed
    const first = checkToolCallLoop("ask_user_questions", args);
    assert.equal(first.block, false, "first call should not be blocked");

    // Second identical call is blocked (threshold = 1 for interactive tools)
    const second = checkToolCallLoop("ask_user_questions", args);
    assert.equal(second.block, true, "second identical ask_user_questions should be blocked");
    assert.ok(second.reason?.includes("Tool loop detected"), "should include loop detection reason");
  });

  test("non-interactive tools still allow 4 consecutive calls", () => {
    const args = { path: "/tmp/test.ts" };

    for (let i = 0; i < 4; i++) {
      const result = checkToolCallLoop("read", args);
      assert.equal(result.block, false, `call ${i + 1} should not be blocked`);
    }

    // 5th identical call is blocked
    const fifth = checkToolCallLoop("read", args);
    assert.equal(fifth.block, true, "5th identical read should be blocked");
  });

  test("different questions are not deduplicated by loop guard", () => {
    const args1 = {
      questions: [{ id: "q1", header: "Test", question: "First question", options: [{ label: "A", description: "a" }] }],
    };
    const args2 = {
      questions: [{ id: "q2", header: "Test", question: "Different question", options: [{ label: "B", description: "b" }] }],
    };

    const first = checkToolCallLoop("ask_user_questions", args1);
    assert.equal(first.block, false);

    // Different args resets the streak
    const second = checkToolCallLoop("ask_user_questions", args2);
    assert.equal(second.block, false, "different questions should not be blocked");
  });

  test("reset clears the guard state", () => {
    const args = {
      questions: [{ id: "q1", header: "Test", question: "Pick one", options: [{ label: "A", description: "a" }] }],
    };

    checkToolCallLoop("ask_user_questions", args);
    checkToolCallLoop("ask_user_questions", args); // would be blocked

    resetToolCallLoopGuard();

    // After reset, the same call is allowed again
    const afterReset = checkToolCallLoop("ask_user_questions", args);
    assert.equal(afterReset.block, false, "should not be blocked after reset");
  });
});
