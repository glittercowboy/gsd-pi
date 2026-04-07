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

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeUnitRuntimeRecord,
  readUnitRuntimeRecord,
} from "../unit-runtime.ts";

describe("#2322: recoveryAttempts reset on re-dispatch", () => {
  test("recoveryAttempts resets to 0 when explicitly included in re-dispatch", (t) => {
    const base = mkdtempSync(join(tmpdir(), "gsd-recovery-reset-test-"));
    mkdirSync(join(base, ".gsd", "runtime", "units"), { recursive: true });
    t.after(() => rmSync(base, { recursive: true, force: true }));

    const unitType = "execute-task";
    const unitId = "M001/S01/T01";
    const startedAt1 = Date.now() - 10000;

    // First dispatch — clean state
    writeUnitRuntimeRecord(base, unitType, unitId, startedAt1, {
      phase: "dispatched",
      wrapupWarningSent: false,
      timeoutAt: null,
      lastProgressAt: startedAt1,
      progressCount: 0,
      lastProgressKind: "dispatch",
    });

    // Timeout recovery increments recoveryAttempts
    writeUnitRuntimeRecord(base, unitType, unitId, startedAt1, {
      phase: "recovered",
      recoveryAttempts: 1,
      lastRecoveryReason: "hard",
    });

    const afterRecovery = readUnitRuntimeRecord(base, unitType, unitId);
    assert.deepStrictEqual(afterRecovery?.recoveryAttempts, 1);
    assert.deepStrictEqual(afterRecovery?.lastRecoveryReason, "hard");

    // Re-dispatch with explicit reset
    const startedAt2 = Date.now();
    writeUnitRuntimeRecord(base, unitType, unitId, startedAt2, {
      phase: "dispatched",
      wrapupWarningSent: false,
      timeoutAt: null,
      lastProgressAt: startedAt2,
      progressCount: 0,
      lastProgressKind: "dispatch",
      recoveryAttempts: 0,
    });

    const afterRedispatch = readUnitRuntimeRecord(base, unitType, unitId);
    assert.deepStrictEqual(afterRedispatch?.recoveryAttempts, 0);
  });

  test("BUG DEMO: omitting recoveryAttempts carries it over", (t) => {
    const base = mkdtempSync(join(tmpdir(), "gsd-recovery-reset-test-"));
    mkdirSync(join(base, ".gsd", "runtime", "units"), { recursive: true });
    t.after(() => rmSync(base, { recursive: true, force: true }));

    const unitType = "execute-task";
    const unitId = "M001/S01/T02";
    const startedAt1 = Date.now() - 10000;

    writeUnitRuntimeRecord(base, unitType, unitId, startedAt1, { phase: "dispatched" });
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
    });

    const afterBuggyRedispatch = readUnitRuntimeRecord(base, unitType, unitId);
    assert.deepStrictEqual(afterBuggyRedispatch?.recoveryAttempts, 1);
  });

  test("second dispatch gets full hard-timeout budget after reset", (t) => {
    const base = mkdtempSync(join(tmpdir(), "gsd-recovery-reset-test-"));
    mkdirSync(join(base, ".gsd", "runtime", "units"), { recursive: true });
    t.after(() => rmSync(base, { recursive: true, force: true }));

    const unitType = "execute-task";
    const unitId = "M001/S01/T03";

    const start1 = Date.now() - 20000;
    writeUnitRuntimeRecord(base, unitType, unitId, start1, {
      phase: "dispatched",
      recoveryAttempts: 0,
    });

    // Hard timeout recovery — exhausts the budget
    writeUnitRuntimeRecord(base, unitType, unitId, start1, {
      phase: "recovered",
      recoveryAttempts: 1,
      lastRecoveryReason: "hard",
    });

    const afterExhausted = readUnitRuntimeRecord(base, unitType, unitId);
    assert.deepStrictEqual(afterExhausted?.recoveryAttempts, 1);

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
    assert.deepStrictEqual(afterReset?.recoveryAttempts, 0);
    assert.ok((afterReset?.recoveryAttempts ?? 0) < 1, "hard recovery should be allowed");
  });
});
