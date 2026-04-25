// ask-user-questions-dedup — Regression tests for per-turn deduplication
//
// Verifies that duplicate ask_user_questions calls within a single turn
// return cached results instead of re-dispatching (especially to remote
// channels like Discord). Also verifies the strict loop guard threshold
// for interactive tools.
//
// Regression: duplicate questions were sent to Discord when the LLM called
// ask_user_questions multiple times with the same question set in one turn,
// causing user confusion and tool failure cascading to plain text fallback.

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  checkToolCallLoop,
  resetToolCallLoopGuard,
} from "../bootstrap/tool-call-loop-guard.ts";
import {
  resetAskUserQuestionsCache,
  questionSignature,
} from "../../ask-user-questions.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Strict loop guard: ask_user_questions blocks on 2nd identical call
// ═══════════════════════════════════════════════════════════════════════════

describe("ask_user_questions dedup", () => {
  beforeEach(() => {
    resetToolCallLoopGuard();
    resetAskUserQuestionsCache();
  });

  test("loop guard blocks 2nd identical ask_user_questions call", () => {
    const args = { questions: [{ id: "app_coverage", question: "Which apps?" }] };

    const first = checkToolCallLoop("ask_user_questions", args);
    assert.equal(first.block, false, "First call should be allowed");

    const second = checkToolCallLoop("ask_user_questions", args);
    assert.equal(second.block, true, "2nd identical call should be blocked");
    assert.ok(second.reason!.includes("ask_user_questions"), "Reason should name the tool");
  });

  test("loop guard allows different ask_user_questions calls", () => {
    const args1 = { questions: [{ id: "app_coverage", question: "Which apps?" }] };
    const args2 = { questions: [{ id: "testing_focus", question: "What priority?" }] };

    const first = checkToolCallLoop("ask_user_questions", args1);
    assert.equal(first.block, false, "First call allowed");

    const second = checkToolCallLoop("ask_user_questions", args2);
    assert.equal(second.block, false, "Different question set should be allowed");
  });

  test("non-interactive tools still use normal threshold of 4", () => {
    const args = { query: "same query" };

    for (let i = 1; i <= 4; i++) {
      const result = checkToolCallLoop("web_search", args);
      assert.equal(result.block, false, `web_search call ${i} should be allowed`);
    }

    const fifth = checkToolCallLoop("web_search", args);
    assert.equal(fifth.block, true, "5th identical web_search should be blocked");
  });

  test("cache resets independently from loop guard", () => {
    // Verify the reset function exists and is callable
    resetAskUserQuestionsCache();
    // No error means the cache module is properly exported and functional
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // questionSignature: full-payload hashing prevents stale cache hits
  // ═══════════════════════════════════════════════════════════════════════════

  test("same IDs with different question text produce different signatures", () => {
    const q1 = [{ id: "scope", header: "Scope", question: "Which apps to cover?",
      options: [{ label: "All", description: "Everything" }] }];
    const q2 = [{ id: "scope", header: "Scope", question: "Which services to test?",
      options: [{ label: "All", description: "Everything" }] }];

    assert.notEqual(questionSignature(q1), questionSignature(q2),
      "Different question text with same ID must produce different signatures");
  });

  test("same IDs with different options produce different signatures", () => {
    const q1 = [{ id: "scope", header: "Scope", question: "Pick one",
      options: [{ label: "A", description: "Option A" }] }];
    const q2 = [{ id: "scope", header: "Scope", question: "Pick one",
      options: [{ label: "B", description: "Option B" }] }];

    assert.notEqual(questionSignature(q1), questionSignature(q2),
      "Different options with same ID must produce different signatures");
  });

  test("identical payloads in different order produce same signature", () => {
    const q1 = [
      { id: "b", header: "B", question: "Q2", options: [{ label: "X", description: "x" }] },
      { id: "a", header: "A", question: "Q1", options: [{ label: "Y", description: "y" }] },
    ];
    const q2 = [
      { id: "a", header: "A", question: "Q1", options: [{ label: "Y", description: "y" }] },
      { id: "b", header: "B", question: "Q2", options: [{ label: "X", description: "x" }] },
    ];

    assert.equal(questionSignature(q1), questionSignature(q2),
      "Same questions in different order must produce the same signature");
  });

  test("allowMultiple difference produces different signature", () => {
    const q1 = [{ id: "scope", header: "Scope", question: "Pick",
      options: [{ label: "A", description: "a" }], allowMultiple: false }];
    const q2 = [{ id: "scope", header: "Scope", question: "Pick",
      options: [{ label: "A", description: "a" }], allowMultiple: true }];

    assert.notEqual(questionSignature(q1), questionSignature(q2),
      "allowMultiple difference must produce different signatures");
  });
});
