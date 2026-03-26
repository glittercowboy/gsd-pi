/**
 * Regression tests for #2527: idle watchdog stalled-tool detection.
 *
 * Bug 1: When a tool is stalled longer than idle_timeout, the watchdog
 * notifies but falls through to detectWorkingTreeActivity(), which
 * resets lastProgressAt if files were modified earlier. Recovery is
 * never called — the session burns tokens indefinitely.
 *
 * Bug 2: After async recoverTimedOutUnit(), pauseAuto/stopAuto may set
 * s.currentUnit = null, but the next line accesses .startedAt — crash.
 *
 * These tests verify the auto-timers.ts source contains the structural
 * fixes: the stalledToolDetected flag, clearInFlightTools() call, the
 * filesystem-check guard, and the null guard after recovery.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const TIMERS_SRC = readFileSync(
  join(import.meta.dirname, "..", "auto-timers.ts"),
  "utf-8",
);

// ═══ Bug 1: stalledToolDetected flag prevents filesystem-activity override ═══

describe("#2527 Bug 1: stalled tool should not be overridden by filesystem activity", () => {
  test("auto-timers.ts imports clearInFlightTools", () => {
    assert.ok(
      TIMERS_SRC.includes("clearInFlightTools"),
      "clearInFlightTools must be imported from auto-tool-tracking",
    );
  });

  test("auto-timers.ts declares stalledToolDetected flag", () => {
    assert.ok(
      TIMERS_SRC.includes("stalledToolDetected"),
      "stalledToolDetected flag must exist in idle watchdog",
    );
  });

  test("stalled tool sets flag to true", () => {
    // The flag must be set before the filesystem check
    const flagSet = TIMERS_SRC.indexOf("stalledToolDetected = true");
    assert.ok(flagSet > -1, "stalledToolDetected must be set to true when tool is stalled");

    const notify = TIMERS_SRC.indexOf("Stalled tool detected:");
    assert.ok(flagSet < notify, "flag must be set before the stall notification");
  });

  test("stalled tool calls clearInFlightTools", () => {
    // clearInFlightTools() must be called when tool is stalled, so subsequent
    // watchdog ticks don't re-detect the same stale entries
    const clearCall = TIMERS_SRC.indexOf("clearInFlightTools()");
    assert.ok(clearCall > -1, "clearInFlightTools() must be called when tool is stalled");

    const flagSet = TIMERS_SRC.indexOf("stalledToolDetected = true");
    assert.ok(
      Math.abs(clearCall - flagSet) < 200,
      "clearInFlightTools() should be near stalledToolDetected = true",
    );
  });

  test("filesystem-activity check is guarded by stalledToolDetected", () => {
    // The detectWorkingTreeActivity check must be skipped when stalledToolDetected is true
    assert.ok(
      TIMERS_SRC.includes("!stalledToolDetected && detectWorkingTreeActivity"),
      "detectWorkingTreeActivity must be guarded by !stalledToolDetected",
    );
  });

  test("control flow: stalled tool → skip filesystem check → reach recovery", () => {
    // Verify the structural ordering: flag declaration → stall block → guarded fs check → recovery
    const flagDecl = TIMERS_SRC.indexOf("let stalledToolDetected = false");
    const stallBlock = TIMERS_SRC.indexOf("stalledToolDetected = true");
    const fsGuard = TIMERS_SRC.indexOf("!stalledToolDetected && detectWorkingTreeActivity");
    const recovery = TIMERS_SRC.indexOf("recoverTimedOutUnit(ctx, pi, unitType, unitId, \"idle\"");

    assert.ok(flagDecl > -1, "flag declaration must exist");
    assert.ok(flagDecl < stallBlock, "flag declared before stall block");
    assert.ok(stallBlock < fsGuard, "stall block before filesystem guard");
    assert.ok(fsGuard < recovery, "filesystem guard before recovery call");
  });
});

// ═══ Bug 2: null guard after async recoverTimedOutUnit ═══════════════════════

describe("#2527 Bug 2: null guard after async recovery prevents crash", () => {
  test("idle watchdog has null guard after recoverTimedOutUnit", () => {
    // Find the idle recovery call
    const idleRecovery = TIMERS_SRC.indexOf(
      'recoverTimedOutUnit(ctx, pi, unitType, unitId, "idle"',
    );
    assert.ok(idleRecovery > -1, "idle recovery call must exist");

    // The null guard must appear between the recovery call and the next
    // writeUnitRuntimeRecord that accesses s.currentUnit.startedAt
    const afterRecovery = TIMERS_SRC.slice(idleRecovery, idleRecovery + 400);
    assert.ok(
      afterRecovery.includes("if (!s.currentUnit) return"),
      "null guard for s.currentUnit must exist after idle recoverTimedOutUnit",
    );
  });

  test("null guard is between recovery and writeUnitRuntimeRecord", () => {
    const idleRecovery = TIMERS_SRC.indexOf(
      'recoverTimedOutUnit(ctx, pi, unitType, unitId, "idle"',
    );
    const afterRecovery = TIMERS_SRC.slice(idleRecovery);

    const recoveredReturn = afterRecovery.indexOf('if (recovery === "recovered") return');
    const nullGuard = afterRecovery.indexOf("if (!s.currentUnit) return");
    const writeRecord = afterRecovery.indexOf("writeUnitRuntimeRecord(s.basePath");

    assert.ok(recoveredReturn > -1, "recovered return must exist");
    assert.ok(nullGuard > -1, "null guard must exist");
    assert.ok(writeRecord > -1, "writeUnitRuntimeRecord must exist after recovery");
    assert.ok(
      recoveredReturn < nullGuard && nullGuard < writeRecord,
      "order must be: recovered-return → null-guard → writeUnitRuntimeRecord",
    );
  });
});
