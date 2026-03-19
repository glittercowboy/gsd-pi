import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { writeLock, readCrashLock, clearLock, isLockProcessAlive } from "../crash-recovery.ts";

// ─── writeLock creates auto.lock in .gsd/ ────────────────────────────────

test("writeLock creates auto.lock with correct structure", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-lock-test-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  writeLock(dir, "starting", "M001", 0);

  const lockPath = join(dir, ".gsd", "auto.lock");
  assert.ok(existsSync(lockPath), "auto.lock should exist after writeLock");

  const data = JSON.parse(readFileSync(lockPath, "utf-8"));
  assert.equal(data.pid, process.pid, "lock should contain current PID");
  assert.equal(data.unitType, "starting", "lock should contain unit type");
  assert.equal(data.unitId, "M001", "lock should contain unit ID");
  assert.equal(data.completedUnits, 0, "lock should show 0 completed units");
  assert.ok(data.startedAt, "lock should have startedAt timestamp");

  rmSync(dir, { recursive: true, force: true });
});

test("writeLock updates existing lock with new unit info", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-lock-test-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  writeLock(dir, "starting", "M001", 0);
  writeLock(dir, "execute-task", "M001/S01/T01", 2, "/tmp/session.jsonl");

  const data = JSON.parse(readFileSync(join(dir, ".gsd", "auto.lock"), "utf-8"));
  assert.equal(data.unitType, "execute-task", "lock should be updated to new unit type");
  assert.equal(data.unitId, "M001/S01/T01", "lock should be updated to new unit ID");
  assert.equal(data.completedUnits, 2, "completed count should be updated");
  assert.equal(data.sessionFile, "/tmp/session.jsonl", "session file should be recorded");

  rmSync(dir, { recursive: true, force: true });
});

// ─── readCrashLock reads auto.lock data ──────────────────────────────────

test("readCrashLock returns null when no lock file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-lock-test-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  const lock = readCrashLock(dir);
  assert.equal(lock, null, "should return null when no lock file");

  rmSync(dir, { recursive: true, force: true });
});

test("readCrashLock returns lock data when file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-lock-test-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  writeLock(dir, "plan-milestone", "M002", 5);
  const lock = readCrashLock(dir);

  assert.ok(lock, "should return lock data");
  assert.equal(lock!.unitType, "plan-milestone");
  assert.equal(lock!.unitId, "M002");
  assert.equal(lock!.completedUnits, 5);

  rmSync(dir, { recursive: true, force: true });
});

// ─── clearLock removes auto.lock ─────────────────────────────────────────

test("clearLock removes the lock file", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-lock-test-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  writeLock(dir, "starting", "M001", 0);
  assert.ok(existsSync(join(dir, ".gsd", "auto.lock")), "lock should exist before clear");

  clearLock(dir);
  assert.ok(!existsSync(join(dir, ".gsd", "auto.lock")), "lock should be removed after clear");

  rmSync(dir, { recursive: true, force: true });
});

test("clearLock is safe when no lock file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-lock-test-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  // Should not throw
  clearLock(dir);

  rmSync(dir, { recursive: true, force: true });
});

// ─── isLockProcessAlive detects live vs dead PIDs ────────────────────────

test("isLockProcessAlive returns false for dead PID", () => {
  const lock = {
    pid: 9999999,
    startedAt: new Date().toISOString(),
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    unitStartedAt: new Date().toISOString(),
    completedUnits: 0,
  };
  assert.equal(isLockProcessAlive(lock), false, "dead PID should return false");
});

test("isLockProcessAlive returns false for own PID (recycled)", () => {
  const lock = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    unitStartedAt: new Date().toISOString(),
    completedUnits: 0,
  };
  assert.equal(isLockProcessAlive(lock), false, "own PID should return false (recycled)");
});

test("isLockProcessAlive returns false for invalid PID", () => {
  const lock = {
    pid: -1,
    startedAt: new Date().toISOString(),
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    unitStartedAt: new Date().toISOString(),
    completedUnits: 0,
  };
  assert.equal(isLockProcessAlive(lock), false, "negative PID should return false");
});

// ─── Cross-process detection via lock file ───────────────────────────────

test("lock file enables cross-process auto-mode detection", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-lock-test-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  // Use the parent process PID — guaranteed alive on all platforms (Unix and Windows).
  // PID 1 (init) only works on Unix; on Windows it doesn't exist.
  const alivePid = process.ppid;
  const lockData = {
    pid: alivePid,
    startedAt: new Date().toISOString(),
    unitType: "execute-task",
    unitId: "M001/S01/T02",
    unitStartedAt: new Date().toISOString(),
    completedUnits: 3,
  };
  writeFileSync(join(dir, ".gsd", "auto.lock"), JSON.stringify(lockData, null, 2));

  const lock = readCrashLock(dir);
  assert.ok(lock, "should read the lock");
  assert.equal(lock!.pid, alivePid);

  // Parent PID is always alive — isLockProcessAlive should detect it
  const alive = isLockProcessAlive(lock!);
  assert.equal(alive, true, "parent PID should be detected as alive");

  rmSync(dir, { recursive: true, force: true });
});

test("stale lock from dead process is detected as not alive", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-lock-test-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  // Simulate a stale lock from a process that no longer exists
  const lockData = {
    pid: 9999999,
    startedAt: "2026-03-01T00:00:00Z",
    unitType: "plan-slice",
    unitId: "M001/S02",
    unitStartedAt: "2026-03-01T00:05:00Z",
    completedUnits: 1,
  };
  writeFileSync(join(dir, ".gsd", "auto.lock"), JSON.stringify(lockData, null, 2));

  const lock = readCrashLock(dir);
  assert.ok(lock, "should read the stale lock");
  assert.equal(isLockProcessAlive(lock!), false, "dead process should not be alive");

  rmSync(dir, { recursive: true, force: true });
});
