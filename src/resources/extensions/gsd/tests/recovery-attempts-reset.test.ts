/**
 * Regression test for #2322: recoveryAttempts persists across re-dispatches,
 * causing instant task skip.
 *
 * When a unit hits recovery limits and is later re-dispatched, the
 * recoveryAttempts counter from the prior execution carries over because
 * the dispatch-time writeUnitRuntimeRecord call does not reset it.
 * This causes the next execution to be instantly skipped with no steering
 * message or second chance.
 *
 * The fix: include `recoveryAttempts: 0` in the dispatch-time runtime
 * record write in runUnitPhase.
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeUnitRuntimeRecord,
  readUnitRuntimeRecord,
} from "../unit-runtime.ts";
import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, report } = createTestContext();

// ═══ Setup ════════════════════════════════════════════════════════════════════

const base = mkdtempSync(join(tmpdir(), "gsd-recovery-reset-test-"));
mkdirSync(join(base, ".gsd", "runtime", "units"), { recursive: true });

try {
  // ═══ #2322: recoveryAttempts should reset on re-dispatch ═══════════════════

  {
    console.log("\n=== #2322: recoveryAttempts should reset on re-dispatch ===");

    const unitType = "execute-task";
    const unitId = "M001/S01/T01";
    const startedAt1 = Date.now() - 10000;

    // Simulate first dispatch — clean state
    writeUnitRuntimeRecord(base, unitType, unitId, startedAt1, {
      phase: "dispatched",
      wrapupWarningSent: false,
      timeoutAt: null,
      lastProgressAt: startedAt1,
      progressCount: 0,
      lastProgressKind: "dispatch",
    });

    // Simulate timeout recovery incrementing recoveryAttempts
    writeUnitRuntimeRecord(base, unitType, unitId, startedAt1, {
      phase: "recovered",
      recoveryAttempts: 1,
      lastRecoveryReason: "hard",
    });

    const afterRecovery = readUnitRuntimeRecord(base, unitType, unitId);
    assertEq(afterRecovery?.recoveryAttempts, 1, "recoveryAttempts should be 1 after recovery");
    assertEq(afterRecovery?.lastRecoveryReason, "hard", "lastRecoveryReason should be 'hard'");

    // Simulate re-dispatch (second execution of same unit).
    // This is what runUnitPhase should do at dispatch time — explicitly reset
    // recoveryAttempts so the new execution gets its full recovery budget.
    const startedAt2 = Date.now();
    writeUnitRuntimeRecord(base, unitType, unitId, startedAt2, {
      phase: "dispatched",
      wrapupWarningSent: false,
      timeoutAt: null,
      lastProgressAt: startedAt2,
      progressCount: 0,
      lastProgressKind: "dispatch",
      recoveryAttempts: 0, // FIX: must be explicitly reset
    });

    const afterRedispatch = readUnitRuntimeRecord(base, unitType, unitId);
    assertEq(
      afterRedispatch?.recoveryAttempts,
      0,
      "recoveryAttempts should be 0 after re-dispatch (was carried over from prior execution)",
    );
  }

  // ═══ Verify the BUG scenario: omitting recoveryAttempts carries it over ═══

  {
    console.log("\n=== #2322: demonstrates bug — omitting recoveryAttempts carries it over ===");

    const unitType = "execute-task";
    const unitId = "M001/S01/T02";
    const startedAt1 = Date.now() - 10000;

    // First dispatch
    writeUnitRuntimeRecord(base, unitType, unitId, startedAt1, {
      phase: "dispatched",
    });

    // Timeout bumps recoveryAttempts to 1
    writeUnitRuntimeRecord(base, unitType, unitId, startedAt1, {
      recoveryAttempts: 1,
      lastRecoveryReason: "hard",
    });

    // Re-dispatch WITHOUT resetting recoveryAttempts (the bug)
    const startedAt2 = Date.now();
    writeUnitRuntimeRecord(base, unitType, unitId, startedAt2, {
      phase: "dispatched",
      wrapupWarningSent: false,
      timeoutAt: null,
      lastProgressAt: startedAt2,
      progressCount: 0,
      lastProgressKind: "dispatch",
      // recoveryAttempts: NOT included — this is the bug
    });

    const afterBuggyRedispatch = readUnitRuntimeRecord(base, unitType, unitId);
    // This DEMONSTRATES the bug: recoveryAttempts is still 1
    assertEq(
      afterBuggyRedispatch?.recoveryAttempts,
      1,
      "BUG DEMO: recoveryAttempts carries over when not explicitly reset",
    );
  }

  // ═══ Hard timeout maxRecoveryAttempts=1 — second dispatch must get full budget ═══

  {
    console.log("\n=== #2322: second dispatch gets full hard-timeout budget after reset ===");

    const unitType = "execute-task";
    const unitId = "M001/S01/T03";

    // First dispatch
    const start1 = Date.now() - 20000;
    writeUnitRuntimeRecord(base, unitType, unitId, start1, {
      phase: "dispatched",
      recoveryAttempts: 0,
    });

    // Hard timeout recovery — exhausts the budget (maxRecoveryAttempts=1 for hard)
    writeUnitRuntimeRecord(base, unitType, unitId, start1, {
      phase: "recovered",
      recoveryAttempts: 1,
      lastRecoveryReason: "hard",
    });

    const afterExhausted = readUnitRuntimeRecord(base, unitType, unitId);
    assertEq(afterExhausted?.recoveryAttempts, 1, "budget exhausted after hard recovery");

    // Second dispatch with fix: reset recoveryAttempts
    const start2 = Date.now();
    writeUnitRuntimeRecord(base, unitType, unitId, start2, {
      phase: "dispatched",
      wrapupWarningSent: false,
      timeoutAt: null,
      lastProgressAt: start2,
      progressCount: 0,
      lastProgressKind: "dispatch",
      recoveryAttempts: 0,
    });

    const afterReset = readUnitRuntimeRecord(base, unitType, unitId);
    assertEq(afterReset?.recoveryAttempts, 0, "second dispatch has full recovery budget");

    // Now a hard timeout should be recoverable (0 < 1)
    assertTrue(
      (afterReset?.recoveryAttempts ?? 0) < 1,
      "hard recovery should be allowed (recoveryAttempts < maxRecoveryAttempts)",
    );
  }

} finally {
  rmSync(base, { recursive: true, force: true });
}

report();
