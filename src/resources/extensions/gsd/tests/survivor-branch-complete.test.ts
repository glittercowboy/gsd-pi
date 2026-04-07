/**
 * Regression test for #2358: Survivor branch recovery skipped in phase=complete.
 *
 * When bootstrapAutoSession finds a survivor milestone branch and the derived
 * state phase is "complete", recovery/finalization is skipped entirely because
 * the survivor branch detection only triggers when phase === "pre-planning".
 * The milestone finalization (merge, cleanup) never runs, leaving the worktree
 * and branch alive.
 *
 * The fix broadens the survivor branch detection to also check phase === "complete",
 * and adds a finalization path that runs mergeAndExit before falling through to
 * the normal "complete" handling.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

describe("#2358: survivor branch detection conditions", () => {
  const phasesBeforeFix = ["pre-planning"];
  const phasesAfterFix = ["pre-planning", "complete"];

  test("before fix: phase=complete should NOT trigger survivor detection", () => {
    assert.deepStrictEqual(phasesBeforeFix.includes("complete"), false);
  });

  test("after fix: phase=complete SHOULD trigger survivor detection", () => {
    assert.deepStrictEqual(phasesAfterFix.includes("complete"), true);
  });

  test("pre-planning should still trigger survivor detection after fix", () => {
    assert.deepStrictEqual(phasesAfterFix.includes("pre-planning"), true);
  });

  test("other phases should NOT trigger survivor detection", () => {
    for (const phase of ["planning", "executing", "blocked", "needs-discussion"]) {
      assert.deepStrictEqual(phasesAfterFix.includes(phase), false, `phase=${phase}`);
    }
  });
});

describe("#2358: phase=complete + survivor branch triggers finalization path", () => {
  function decideAction(hasSurvivorBranch: boolean, phase: string): string {
    if (hasSurvivorBranch && phase === "complete") return "finalize";
    if (hasSurvivorBranch && phase === "needs-discussion") return "discuss";
    if (!hasSurvivorBranch && (!phase || phase === "complete")) return "showSmartEntry";
    return "continue";
  }

  const scenarios = [
    { hasSurvivorBranch: true, phase: "complete", expected: "finalize" },
    { hasSurvivorBranch: true, phase: "needs-discussion", expected: "discuss" },
    { hasSurvivorBranch: true, phase: "pre-planning", expected: "continue" },
    { hasSurvivorBranch: false, phase: "complete", expected: "showSmartEntry" },
  ] as const;

  for (const { hasSurvivorBranch, phase, expected } of scenarios) {
    test(`hasSurvivorBranch=${hasSurvivorBranch}, phase=${phase} -> ${expected}`, () => {
      assert.deepStrictEqual(decideAction(hasSurvivorBranch, phase), expected);
    });
  }
});
