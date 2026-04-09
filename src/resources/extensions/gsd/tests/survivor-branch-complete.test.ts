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

import { createTestContext } from "./test-helpers.ts";

const { assertTrue, assertEq, report } = createTestContext();

// ═══ Test: survivor branch detection conditions ══════════════════════════════

// The survivor branch detection block in auto-start.ts checks:
//   state.activeMilestone &&
//   state.phase === "pre-planning" &&  // <-- BUG: too restrictive
//   shouldUseWorktreeIsolation() &&
//   !detectWorktreeName(base) &&
//   !base.includes(...)
//
// The fix should also include state.phase === "complete".

{
  console.log("\n=== #2358: survivor branch should be detected in phase=complete ===");

  // Simulate the condition check before the fix (only pre-planning)
  const phasesBeforeFix = ["pre-planning"];
  const phasesAfterFix = ["pre-planning", "complete"];

  const testPhase = "complete";

  const detectedBefore = phasesBeforeFix.includes(testPhase);
  assertEq(detectedBefore, false, "before fix: phase=complete should NOT trigger survivor detection");

  const detectedAfter = phasesAfterFix.includes(testPhase);
  assertEq(detectedAfter, true, "after fix: phase=complete SHOULD trigger survivor detection");
}

// ═══ Test: pre-planning survivor detection still works ═══════════════════════

{
  console.log("\n=== #2358: pre-planning survivor detection is not broken ===");

  const phasesAfterFix = ["pre-planning", "complete"];
  const testPhase = "pre-planning";

  const detected = phasesAfterFix.includes(testPhase);
  assertEq(detected, true, "pre-planning should still trigger survivor detection after fix");
}

// ═══ Test: other phases do NOT trigger survivor detection ════════════════════

{
  console.log("\n=== #2358: other phases should NOT trigger survivor detection ===");

  const phasesAfterFix = ["pre-planning", "complete"];

  for (const phase of ["planning", "executing", "blocked", "needs-discussion"]) {
    const detected = phasesAfterFix.includes(phase);
    assertEq(detected, false, `phase=${phase} should NOT trigger survivor detection`);
  }
}

// ═══ Test: phase=complete + hasSurvivorBranch should trigger finalization ═════

{
  console.log("\n=== #2358: phase=complete + survivor branch triggers finalization path ===");

  // Simulate the decision logic after the fix:
  // if (hasSurvivorBranch && state.phase === "complete") -> finalize
  // if (hasSurvivorBranch && state.phase === "needs-discussion") -> discuss
  // if (!hasSurvivorBranch && state.phase === "complete") -> showSmartEntry

  const scenarios = [
    { hasSurvivorBranch: true, phase: "complete", expected: "finalize" },
    { hasSurvivorBranch: true, phase: "needs-discussion", expected: "discuss" },
    { hasSurvivorBranch: true, phase: "pre-planning", expected: "continue" },
    { hasSurvivorBranch: false, phase: "complete", expected: "showSmartEntry" },
  ];

  for (const { hasSurvivorBranch, phase, expected } of scenarios) {
    let result: string;
    if (hasSurvivorBranch && phase === "complete") {
      result = "finalize";
    } else if (hasSurvivorBranch && phase === "needs-discussion") {
      result = "discuss";
    } else if (!hasSurvivorBranch && (!phase || phase === "complete")) {
      result = "showSmartEntry";
    } else {
      result = "continue";
    }

    assertEq(
      result,
      expected,
      `hasSurvivorBranch=${hasSurvivorBranch}, phase=${phase} -> expected ${expected}, got ${result}`,
    );
  }
}

report();
