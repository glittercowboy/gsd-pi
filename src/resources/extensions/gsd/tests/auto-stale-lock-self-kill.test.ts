import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { writeLock, readCrashLock, clearLock } from "../crash-recovery.ts";
import { checkRemoteAutoSession, stopAutoRemote } from "../auto.ts";

function makeTmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-stale-lock-test-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  return dir;
}

// ─── checkRemoteAutoSession: own-PID filtering (#2730) ───────────────────

test("#2730: checkRemoteAutoSession returns { running: false } when lock PID matches current process", (t) => {
  const dir = makeTmpProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Write a lock with the current process PID — simulates a stale lock
  // left behind after step-mode exit without full cleanup.
  writeLock(dir, "execute-task", "M001/S01/T01");

  const lock = readCrashLock(dir);
  assert.ok(lock, "lock file should exist");
  assert.equal(lock!.pid, process.pid, "lock should have our PID");

  const result = checkRemoteAutoSession(dir);
  assert.equal(result.running, false, "own PID must not be treated as a remote session");
});

test("#2730: checkRemoteAutoSession still detects a genuine remote session (different PID)", (t) => {
  const dir = makeTmpProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Use parent PID — guaranteed alive, guaranteed not our PID.
  const remotePid = process.ppid;
  const lockData = {
    pid: remotePid,
    startedAt: new Date().toISOString(),
    unitType: "execute-task",
    unitId: "M001/S01/T02",
    unitStartedAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, ".gsd", "auto.lock"), JSON.stringify(lockData, null, 2));

  const result = checkRemoteAutoSession(dir);
  assert.equal(result.running, true, "different live PID should be detected as running");
  assert.equal(result.pid, remotePid);
});

// ─── stopAutoRemote: self-kill prevention (#2730) ────────────────────────

test("#2730: stopAutoRemote does not send SIGTERM when lock PID matches current process", (t) => {
  const dir = makeTmpProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Write a lock with our own PID
  writeLock(dir, "execute-task", "M001/S01/T01");

  const result = stopAutoRemote(dir);
  assert.equal(result.found, false, "own PID must not be signalled");

  // The lock should be cleared as part of the self-detection cleanup
  assert.ok(!existsSync(join(dir, ".gsd", "auto.lock")), "stale self-lock should be cleared");
});

test("#2730: stopAutoRemote clears stale lock from dead remote process without error", (t) => {
  const dir = makeTmpProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Simulate a stale lock from a process that no longer exists
  const lockData = {
    pid: 9999999,
    startedAt: "2026-03-01T00:00:00Z",
    unitType: "plan-slice",
    unitId: "M001/S02",
    unitStartedAt: "2026-03-01T00:05:00Z",
  };
  writeFileSync(join(dir, ".gsd", "auto.lock"), JSON.stringify(lockData, null, 2));

  const result = stopAutoRemote(dir);
  assert.equal(result.found, false, "dead remote PID should not be reported as found");
  assert.ok(!existsSync(join(dir, ".gsd", "auto.lock")), "stale lock should be cleaned up");
});
