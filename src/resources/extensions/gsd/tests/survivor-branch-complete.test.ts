/**
 * survivor-branch-complete.test.ts — #2358
 *
 * The bug: `bootstrapAutoSession` found a survivor milestone branch
 * (previous session's worktree/branch that was never merged) but only
 * triggered recovery when `state.phase === "pre-planning"`. In
 * `phase === "complete"` the milestone artifacts existed but the
 * finalization path (merge + cleanup) never ran, leaving the worktree
 * and branch alive indefinitely.
 *
 * The fix broadens the detection to include `phase === "complete"` and
 * routes to a finalize-via-mergeAndExit path.
 *
 * The previous version of this file was 4 scenarios that re-implemented
 * the decision logic inline and called `.includes(phase)` on
 * locally-declared arrays — testing the test, not the code. Called out
 * in #4832 and parent #4784 as a pure-tautology case (zero imports
 * from production).
 *
 * This rewrite imports `decideSurvivorAction` from auto-start.ts (a
 * helper extracted in the accompanying refactor) and drives the full
 * decision table through the real function. The helper is wired into
 * `bootstrapAutoSession` at the two call sites that previously used
 * inline conditionals, so the assertions here fail if someone reverts
 * the helper or narrows its branches.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { decideSurvivorAction } from "../auto-start.ts";
import type { SurvivorAction } from "../auto-start.ts";

describe("decideSurvivorAction (#2358)", () => {
  test("no survivor branch → no action, regardless of phase", () => {
    const phases = [
      "pre-planning",
      "planning",
      "executing",
      "complete",
      "needs-discussion",
      "blocked",
      "",
      null,
      undefined,
    ];
    for (const phase of phases) {
      const got: SurvivorAction = decideSurvivorAction(false, phase);
      assert.equal(got, "none", `phase=${phase ?? "(nullish)"} → expected 'none', got '${got}'`);
    }
  });

  test("survivor + needs-discussion → 'discuss' (#1726)", () => {
    assert.equal(decideSurvivorAction(true, "needs-discussion"), "discuss");
  });

  test("survivor + complete → 'finalize' (#2358 — the bug this regression guards)", () => {
    // This is THE assertion that fails if someone reverts the fix and
    // narrows the recovery to pre-planning only.
    assert.equal(decideSurvivorAction(true, "complete"), "finalize");
  });

  test("survivor + other phase → 'none' (caller continues normal flow)", () => {
    // pre-planning, planning, executing, blocked — survivor alone is
    // not sufficient to trigger recovery. Normal auto-mode picks up
    // from state. This protects against regressions that try to run
    // finalize on every survivor regardless of phase.
    const passThroughPhases = ["pre-planning", "planning", "executing", "blocked", ""];
    for (const phase of passThroughPhases) {
      assert.equal(
        decideSurvivorAction(true, phase),
        "none",
        `survivor + phase=${phase} → expected 'none', got ${decideSurvivorAction(true, phase)}`,
      );
    }
  });

  test("decision table covers the three outcomes the bootstrap code needs", () => {
    // Belt-and-suspenders: enumerate (hasSurvivor, phase) and assert
    // the complete truth table. If someone adds a 4th outcome, this
    // test fails loudly so they must update both the helper and the
    // bootstrap wiring.
    const cases: Array<{ hasSurvivor: boolean; phase: string | null; expected: SurvivorAction }> = [
      { hasSurvivor: true, phase: "needs-discussion", expected: "discuss" },
      { hasSurvivor: true, phase: "complete", expected: "finalize" },
      { hasSurvivor: true, phase: "pre-planning", expected: "none" },
      { hasSurvivor: true, phase: "planning", expected: "none" },
      { hasSurvivor: true, phase: null, expected: "none" },
      { hasSurvivor: false, phase: "complete", expected: "none" },
      { hasSurvivor: false, phase: "needs-discussion", expected: "none" },
      { hasSurvivor: false, phase: null, expected: "none" },
    ];
    const outcomes = new Set<SurvivorAction>();
    for (const { hasSurvivor, phase, expected } of cases) {
      const got = decideSurvivorAction(hasSurvivor, phase);
      outcomes.add(got);
      assert.equal(
        got,
        expected,
        `(hasSurvivor=${hasSurvivor}, phase=${phase}) → expected '${expected}', got '${got}'`,
      );
    }
    assert.deepEqual(
      [...outcomes].sort(),
      ["discuss", "finalize", "none"],
      "decision function should produce exactly three outcomes",
    );
  });
});
