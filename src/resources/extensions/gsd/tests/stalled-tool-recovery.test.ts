/**
 * Regression test for #1855: Stalled tool detection crashes with
 * "The path argument must be of type string. Received undefined"
 *
 * When a tool stalls in-flight for 10+ minutes, the idle watchdog fires
 * recoverTimedOutUnit(). In auto/phases.ts, buildRecoveryContext was
 * returning an empty object `{}`, so basePath was undefined. The recovery
 * code passed undefined to readUnitRuntimeRecord → runtimePath → join(),
 * which throws a TypeError. The session is permanently frozen because the
 * error propagates into the idle watchdog catch handler but the unit
 * promise is never resolved.
 *
 * This test calls recoverTimedOutUnit with an empty RecoveryContext (the
 * bug) and verifies it crashes, then calls it with a valid RecoveryContext
 * (the fix) and verifies it does not crash.
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recoverTimedOutUnit, type RecoveryContext } from "../auto-timeout-recovery.ts";
import { test } from 'node:test';
import assert from 'node:assert/strict';


// Minimal mock for ExtensionContext — only the fields recoverTimedOutUnit touches.
function makeMockCtx() {
  return {
    ui: {
      notify: () => {},
    },
  } as any;
}

// Minimal mock for ExtensionAPI — only sendMessage is called during recovery.
function makeMockPi() {
  return {
    sendMessage: () => {},
  } as any;
}

// ═══ #1855: empty RecoveryContext (basePath undefined) crashes ════════════════

{
  console.log("\n=== #1855: recoverTimedOutUnit crashes when basePath is undefined ===");
  const ctx = makeMockCtx();
  const pi = makeMockPi();

  // Simulate the bug: buildRecoveryContext returns {} (empty object).
  // basePath is undefined, which causes join(undefined, ".gsd") to throw.
  const emptyRctx = {} as RecoveryContext;

  let crashed = false;
  try {
    await recoverTimedOutUnit(ctx, pi, "execute-task", "M001/S01/T01", "idle", emptyRctx);
  } catch (err: any) {
    crashed = true;
    assert.ok(
      err.message.includes("path") || err.message.includes("string") || err.code === "ERR_INVALID_ARG_TYPE",
      `should crash with path/type error, got: ${err.message}`,
    );
  }
  assert.ok(crashed, "should crash when basePath is undefined (reproduces #1855)");
}

// ═══ #1855: valid RecoveryContext does not crash ═════════════════════════════

{
  console.log("\n=== #1855: recoverTimedOutUnit succeeds with valid RecoveryContext ===");
  const base = mkdtempSync(join(tmpdir(), "gsd-stalled-tool-test-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  mkdirSync(join(base, ".gsd", "runtime", "units"), { recursive: true });

  try {
    const ctx = makeMockCtx();
    const pi = makeMockPi();

    const validRctx: RecoveryContext = {
      basePath: base,
      verbose: false,
      currentUnitStartedAt: Date.now(),
      unitRecoveryCount: new Map(),
    };

    let crashed = false;
    let result: string | undefined;
    try {
      result = await recoverTimedOutUnit(ctx, pi, "execute-task", "M001/S01/T01", "idle", validRctx);
    } catch (err: any) {
      crashed = true;
      console.error(`  Unexpected crash: ${err.message}`);
    }
    assert.ok(!crashed, "should not crash with valid basePath");
    // With no runtime record on disk and recoveryAttempts=0, the function
    // should attempt steering recovery (sendMessage) and return "recovered".
    assert.ok(result === "recovered", `should return 'recovered', got '${result}'`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
