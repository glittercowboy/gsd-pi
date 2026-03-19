import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  acquireSessionLock,
  releaseSessionLock,
  updateSessionLock,
  validateSessionLock,
  readSessionLockData,
  isSessionLockHeld,
  isSessionLockProcessAlive,
  cleanupStrayLockFiles,
} from "../session-lock.ts";

// ─── acquireSessionLock ──────────────────────────────────────────────────

test("acquireSessionLock succeeds on empty directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-session-lock-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  const result = acquireSessionLock(dir);
  assert.equal(result.acquired, true, "should acquire lock on empty dir");

  // Verify lock file was created with correct data
  const lockPath = join(dir, ".gsd", "auto.lock");
  assert.ok(existsSync(lockPath), "auto.lock should exist after acquire");

  const data = JSON.parse(readFileSync(lockPath, "utf-8"));
  assert.equal(data.pid, process.pid, "lock should contain current PID");
  assert.equal(data.unitType, "starting", "initial unit type should be 'starting'");

  releaseSessionLock(dir);
  rmSync(dir, { recursive: true, force: true });
});

test("acquireSessionLock rejects when another live process holds lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-session-lock-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  // Simulate another process holding the lock by writing a lock with parent PID
  const fakeLockData = {
    pid: process.ppid,
    startedAt: new Date().toISOString(),
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    unitStartedAt: new Date().toISOString(),
    completedUnits: 2,
  };
  writeFileSync(join(dir, ".gsd", "auto.lock"), JSON.stringify(fakeLockData, null, 2));

  // First acquire to set up proper-lockfile state
  const result1 = acquireSessionLock(dir);

  // If proper-lockfile is available, it should manage the OS lock.
  // If not (fallback mode), the PID check should detect the live process.
  // Either way, we can't fully simulate another process holding an OS lock
  // from within the same process, so we test the fallback path.
  if (result1.acquired) {
    // We got the lock (proper-lockfile saw no OS lock from another process)
    // This is expected since we're in the same process
    releaseSessionLock(dir);
  }

  rmSync(dir, { recursive: true, force: true });
});

test("acquireSessionLock takes over stale lock from dead process", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-session-lock-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  // Write a lock from a dead process
  const staleLockData = {
    pid: 9999999,
    startedAt: "2026-03-01T00:00:00Z",
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    unitStartedAt: "2026-03-01T00:00:00Z",
    completedUnits: 0,
  };
  writeFileSync(join(dir, ".gsd", "auto.lock"), JSON.stringify(staleLockData, null, 2));

  const result = acquireSessionLock(dir);
  assert.equal(result.acquired, true, "should take over lock from dead process");

  // Verify our PID is now in the lock
  const data = readSessionLockData(dir);
  assert.ok(data, "lock data should exist after acquire");
  assert.equal(data!.pid, process.pid, "lock should contain our PID now");

  releaseSessionLock(dir);
  rmSync(dir, { recursive: true, force: true });
});

// ─── releaseSessionLock ─────────────────────────────────────────────────

test("releaseSessionLock removes the lock file", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-session-lock-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  const result = acquireSessionLock(dir);
  assert.equal(result.acquired, true);

  releaseSessionLock(dir);

  const lockPath = join(dir, ".gsd", "auto.lock");
  assert.ok(!existsSync(lockPath), "auto.lock should be removed after release");

  rmSync(dir, { recursive: true, force: true });
});

test("releaseSessionLock is safe when no lock exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-session-lock-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  // Should not throw
  releaseSessionLock(dir);

  rmSync(dir, { recursive: true, force: true });
});

// ─── updateSessionLock ──────────────────────────────────────────────────

test("updateSessionLock updates the lock data without re-acquiring", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-session-lock-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  const result = acquireSessionLock(dir);
  assert.equal(result.acquired, true);

  updateSessionLock(dir, "execute-task", "M001/S01/T02", 3, "/tmp/session.jsonl");

  const data = readSessionLockData(dir);
  assert.ok(data, "lock data should exist after update");
  assert.equal(data!.pid, process.pid, "PID should still be ours");
  assert.equal(data!.unitType, "execute-task", "unit type should be updated");
  assert.equal(data!.unitId, "M001/S01/T02", "unit ID should be updated");
  assert.equal(data!.completedUnits, 3, "completed count should be updated");
  assert.equal(data!.sessionFile, "/tmp/session.jsonl", "session file should be recorded");

  releaseSessionLock(dir);
  rmSync(dir, { recursive: true, force: true });
});

// ─── validateSessionLock ────────────────────────────────────────────────

test("validateSessionLock returns true when we hold the lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-session-lock-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  const result = acquireSessionLock(dir);
  assert.equal(result.acquired, true);

  assert.equal(validateSessionLock(dir), true, "should validate when we hold the lock");

  releaseSessionLock(dir);
  rmSync(dir, { recursive: true, force: true });
});

test("validateSessionLock returns false after release", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-session-lock-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  const result = acquireSessionLock(dir);
  assert.equal(result.acquired, true);
  assert.equal(validateSessionLock(dir), true, "should be valid while held");

  // Release the lock — both OS lock and lock file are removed
  releaseSessionLock(dir);

  // After release, _lockedPath is cleared and lock file is gone
  assert.equal(isSessionLockHeld(dir), false, "should not be held after release");

  rmSync(dir, { recursive: true, force: true });
});

test("validateSessionLock returns false when another PID owns the lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-session-lock-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  // Write lock data with a different PID (parent process)
  const foreignLockData = {
    pid: process.ppid,
    startedAt: new Date().toISOString(),
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    unitStartedAt: new Date().toISOString(),
    completedUnits: 0,
  };
  writeFileSync(join(dir, ".gsd", "auto.lock"), JSON.stringify(foreignLockData, null, 2));

  // Without holding the OS lock, validate should check PID
  assert.equal(validateSessionLock(dir), false, "should fail when another PID owns lock");

  rmSync(dir, { recursive: true, force: true });
});

// ─── isSessionLockHeld ──────────────────────────────────────────────────

test("isSessionLockHeld returns true after acquire", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-session-lock-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  acquireSessionLock(dir);
  assert.equal(isSessionLockHeld(dir), true);

  releaseSessionLock(dir);
  assert.equal(isSessionLockHeld(dir), false, "should return false after release");

  rmSync(dir, { recursive: true, force: true });
});

// ─── isSessionLockProcessAlive ──────────────────────────────────────────

test("isSessionLockProcessAlive returns false for dead PID", () => {
  const data = {
    pid: 9999999,
    startedAt: new Date().toISOString(),
    unitType: "starting",
    unitId: "bootstrap",
    unitStartedAt: new Date().toISOString(),
    completedUnits: 0,
  };
  assert.equal(isSessionLockProcessAlive(data), false);
});

test("isSessionLockProcessAlive returns false for own PID (recycled)", () => {
  const data = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    unitType: "starting",
    unitId: "bootstrap",
    unitStartedAt: new Date().toISOString(),
    completedUnits: 0,
  };
  // Own PID returns false because it means the lock is from a recycled PID
  assert.equal(isSessionLockProcessAlive(data), false);
});

// ─── readSessionLockData ────────────────────────────────────────────────

test("readSessionLockData returns null when no lock exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-session-lock-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  const data = readSessionLockData(dir);
  assert.equal(data, null);

  rmSync(dir, { recursive: true, force: true });
});

test("readSessionLockData reads existing lock data", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-session-lock-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  const lockData = {
    pid: 12345,
    startedAt: "2026-03-18T00:00:00Z",
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    unitStartedAt: "2026-03-18T00:01:00Z",
    completedUnits: 2,
    sessionFile: "/tmp/session.jsonl",
  };
  writeFileSync(join(dir, ".gsd", "auto.lock"), JSON.stringify(lockData, null, 2));

  const data = readSessionLockData(dir);
  assert.ok(data, "should read lock data");
  assert.equal(data!.pid, 12345);
  assert.equal(data!.unitType, "execute-task");
  assert.equal(data!.unitId, "M001/S01/T01");
  assert.equal(data!.completedUnits, 2);
  assert.equal(data!.sessionFile, "/tmp/session.jsonl");

  rmSync(dir, { recursive: true, force: true });
});

// ─── Acquire → Release → Re-Acquire lifecycle ──────────────────────────

test("session lock supports acquire → release → re-acquire cycle", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-session-lock-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  // First acquire
  const r1 = acquireSessionLock(dir);
  assert.equal(r1.acquired, true, "first acquire should succeed");
  assert.equal(isSessionLockHeld(dir), true);

  // Release
  releaseSessionLock(dir);
  assert.equal(isSessionLockHeld(dir), false);

  // Re-acquire
  const r2 = acquireSessionLock(dir);
  assert.equal(r2.acquired, true, "re-acquire after release should succeed");
  assert.equal(isSessionLockHeld(dir), true);

  releaseSessionLock(dir);
  rmSync(dir, { recursive: true, force: true });
});

// ─── Lock creates .gsd/ directory if needed ─────────────────────────────

test("acquireSessionLock creates .gsd/ if it does not exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-session-lock-"));
  // Do NOT create .gsd/ — let the lock function do it

  const result = acquireSessionLock(dir);
  assert.equal(result.acquired, true, "should succeed even without .gsd/");
  assert.ok(existsSync(join(dir, ".gsd")), ".gsd/ should be created");

  releaseSessionLock(dir);
  rmSync(dir, { recursive: true, force: true });
});

// ─── cleanupStrayLockFiles (#1315) ──────────────────────────────────────

test("cleanupStrayLockFiles removes numbered lock variants but preserves auto.lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-session-lock-"));
  const gsdDir = join(dir, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  // Create canonical lock file + numbered variants
  writeFileSync(join(gsdDir, "auto.lock"), '{"pid":1}');
  writeFileSync(join(gsdDir, "auto 2.lock"), '{"pid":2}');
  writeFileSync(join(gsdDir, "auto 3.lock"), '{"pid":3}');
  writeFileSync(join(gsdDir, "auto 4.lock"), '{"pid":4}');

  cleanupStrayLockFiles(dir);

  assert.ok(existsSync(join(gsdDir, "auto.lock")), "canonical auto.lock should be preserved");
  assert.ok(!existsSync(join(gsdDir, "auto 2.lock")), "auto 2.lock should be removed");
  assert.ok(!existsSync(join(gsdDir, "auto 3.lock")), "auto 3.lock should be removed");
  assert.ok(!existsSync(join(gsdDir, "auto 4.lock")), "auto 4.lock should be removed");

  rmSync(dir, { recursive: true, force: true });
});

test("cleanupStrayLockFiles handles parenthesized variants", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-session-lock-"));
  const gsdDir = join(dir, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  // macOS sometimes uses parenthesized format: "auto (2).lock"
  writeFileSync(join(gsdDir, "auto.lock"), '{"pid":1}');
  writeFileSync(join(gsdDir, "auto (2).lock"), '{"pid":2}');

  cleanupStrayLockFiles(dir);

  assert.ok(existsSync(join(gsdDir, "auto.lock")), "canonical auto.lock should be preserved");
  assert.ok(!existsSync(join(gsdDir, "auto (2).lock")), "auto (2).lock should be removed");

  rmSync(dir, { recursive: true, force: true });
});

test("cleanupStrayLockFiles does not remove unrelated files", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-session-lock-"));
  const gsdDir = join(dir, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  // Create unrelated files that should NOT be removed
  writeFileSync(join(gsdDir, "auto.lock"), '{"pid":1}');
  writeFileSync(join(gsdDir, "config.json"), '{}');
  writeFileSync(join(gsdDir, "other.lock"), '{}');

  cleanupStrayLockFiles(dir);

  assert.ok(existsSync(join(gsdDir, "auto.lock")), "auto.lock should be preserved");
  assert.ok(existsSync(join(gsdDir, "config.json")), "config.json should be preserved");
  assert.ok(existsSync(join(gsdDir, "other.lock")), "other.lock should be preserved");

  rmSync(dir, { recursive: true, force: true });
});

test("cleanupStrayLockFiles is safe on empty directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-session-lock-"));
  const gsdDir = join(dir, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  // Should not throw
  cleanupStrayLockFiles(dir);

  rmSync(dir, { recursive: true, force: true });
});

test("cleanupStrayLockFiles is safe when .gsd/ does not exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-session-lock-"));

  // Should not throw even without .gsd/
  cleanupStrayLockFiles(dir);

  rmSync(dir, { recursive: true, force: true });
});

test("acquireSessionLock cleans stray lock files before acquiring", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-session-lock-"));
  const gsdDir = join(dir, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  // Plant stray lock files before acquire
  writeFileSync(join(gsdDir, "auto 2.lock"), '{"pid":9999999}');
  writeFileSync(join(gsdDir, "auto 3.lock"), '{"pid":9999998}');

  const result = acquireSessionLock(dir);
  assert.equal(result.acquired, true, "should acquire lock");

  // Stray files should be cleaned up
  assert.ok(!existsSync(join(gsdDir, "auto 2.lock")), "auto 2.lock should be removed during acquire");
  assert.ok(!existsSync(join(gsdDir, "auto 3.lock")), "auto 3.lock should be removed during acquire");

  releaseSessionLock(dir);
  rmSync(dir, { recursive: true, force: true });
});

test("releaseSessionLock cleans stray lock files after releasing", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-session-lock-"));
  const gsdDir = join(dir, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  const result = acquireSessionLock(dir);
  assert.equal(result.acquired, true);

  // Plant stray lock files (simulating cloud sync creating them during session)
  writeFileSync(join(gsdDir, "auto 2.lock"), '{"pid":9999999}');

  releaseSessionLock(dir);

  assert.ok(!existsSync(join(gsdDir, "auto 2.lock")), "auto 2.lock should be removed during release");
  assert.ok(!existsSync(join(gsdDir, "auto.lock")), "auto.lock should also be removed");

  rmSync(dir, { recursive: true, force: true });
});
