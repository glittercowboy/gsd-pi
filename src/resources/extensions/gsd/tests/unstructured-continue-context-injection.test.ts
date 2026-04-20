// GSD-2 — Regression test for #3615: unstructured "continue" must inject task context
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

/**
 * Bug #3615: When a user types "continue" (or any bare text) to resume
 * an in-progress session, buildGuidedExecuteContextInjection() only
 * matched two hardcoded regex patterns (auto-dispatch and guided-resume).
 * The function returned null for any other input, so no task context was
 * injected — causing the agent to rebuild everything from scratch and
 * burn ~86k tokens.
 *
 * This test verifies:
 *   1. Structural: the fallback exists with phase + intent guards
 *   2. Behavioral: RESUME_INTENT_PATTERNS matches expected prompts and
 *      rejects non-resume prompts (control, help, diagnostic, etc.)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const systemContextSource = readFileSync(
  join(__dirname, "..", "bootstrap", "system-context.ts"),
  "utf-8",
);

// ── Structural tests ────────────────────────────────────────────────

describe("#3615 — structural: fallback exists with correct guards", () => {
  const fnStart = systemContextSource.indexOf("async function buildGuidedExecuteContextInjection(");
  assert.ok(fnStart >= 0, "should find buildGuidedExecuteContextInjection");
  const fnEnd = systemContextSource.indexOf("\nasync function ", fnStart + 1);
  const fnBody = fnEnd >= 0
    ? systemContextSource.slice(fnStart, fnEnd)
    : systemContextSource.slice(fnStart);

  test("has a deriveState fallback after the two regex branches", () => {
    const deriveStateCalls = fnBody.match(/deriveState\(basePath\)/g);
    assert.ok(
      deriveStateCalls && deriveStateCalls.length >= 2,
      `expected >=2 deriveState(basePath) calls, got ${deriveStateCalls?.length ?? 0}`,
    );
  });

  test("fallback is phase-gated to executing only", () => {
    const afterFallback = fnBody.indexOf("// Fallback:");
    assert.ok(afterFallback >= 0, "should have a fallback comment");
    const fallbackSection = fnBody.slice(afterFallback);
    assert.ok(
      fallbackSection.includes('state.phase === "executing"'),
      'fallback must be gated on state.phase === "executing"',
    );
  });

  test("fallback is intent-gated via RESUME_INTENT_PATTERNS", () => {
    const afterFallback = fnBody.indexOf("// Fallback:");
    const fallbackSection = fnBody.slice(afterFallback);
    assert.ok(
      fallbackSection.includes("RESUME_INTENT_PATTERNS"),
      "fallback must check RESUME_INTENT_PATTERNS before deriveState",
    );
  });

  test("fallback calls buildTaskExecutionContextInjection with derived state", () => {
    const afterFallback = fnBody.indexOf("// Fallback:");
    const fallbackSection = fnBody.slice(afterFallback);
    assert.ok(
      fallbackSection.includes("buildTaskExecutionContextInjection") &&
      fallbackSection.includes("state.activeMilestone.id") &&
      fallbackSection.includes("state.activeSlice.id") &&
      fallbackSection.includes("state.activeTask.id"),
      "fallback must call buildTaskExecutionContextInjection with state-derived IDs",
    );
  });

  test("only one return null at the end", () => {
    const returnNulls = fnBody.match(/return null;/g);
    assert.ok(
      returnNulls && returnNulls.length === 1,
      `expected exactly 1 'return null' (at end after fallback), got ${returnNulls?.length ?? 0}`,
    );
  });
});

// ── Behavioral tests: RESUME_INTENT_PATTERNS ────────────────────────

describe("#3615 — behavioral: RESUME_INTENT_PATTERNS matches resume prompts", () => {
  // Extract the regex from source so the test stays in sync
  const patternMatch = systemContextSource.match(/const RESUME_INTENT_PATTERNS\s*=\s*\/(.+)\/;/);
  assert.ok(patternMatch, "should find RESUME_INTENT_PATTERNS definition");
  const pattern = new RegExp(patternMatch[1]);

  // Helper: normalize prompt the same way the production code does
  const normalize = (s: string) => s.trim().toLowerCase().replace(/[.!?,]+$/g, "");

  const shouldMatch = [
    "continue",
    "Continue",
    "CONTINUE",
    "continue.",
    "continue!",
    "resume",
    "ok",
    "OK",
    "Ok!",
    "go",
    "go ahead",
    "Go ahead.",
    "proceed",
    "keep going",
    "carry on",
    "next",
    "yes",
    "yeah",
    "yep",
    "sure",
    "do it",
    "let's go",
    "pick up where you left off",
    "  continue  ",  // whitespace padded
  ];

  const shouldNotMatch = [
    "help",
    "status",
    "/gsd auto",
    "/gsd stats",
    "what's the plan?",
    "show me the logs",
    "abort",
    "stop",
    "cancel",
    "replan this slice",
    "I think we should change the approach",
    "can you explain what you just did?",
    "run the tests",
    "check the build",
    "Execute the next task: T01",
    "what files were changed",
    "",
  ];

  for (const prompt of shouldMatch) {
    test(`matches resume prompt: "${prompt}"`, () => {
      assert.ok(
        pattern.test(normalize(prompt)),
        `expected RESUME_INTENT_PATTERNS to match "${prompt}" (normalized: "${normalize(prompt)}")`,
      );
    });
  }

  for (const prompt of shouldNotMatch) {
    test(`rejects non-resume prompt: "${prompt}"`, () => {
      assert.ok(
        !pattern.test(normalize(prompt)),
        `expected RESUME_INTENT_PATTERNS to NOT match "${prompt}" (normalized: "${normalize(prompt)}")`,
      );
    });
  }
});
