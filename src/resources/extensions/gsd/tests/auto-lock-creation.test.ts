import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { writeLock, readCrashLock, clearLock, isLockProcessAlive } from "../crash-recovery.ts";
import { acquireSessionLock, releaseSessionLock } from "../session-lock.ts";

const require = createRequire(import.meta.url);

function hasProperLockfile(): boolean {
  try {
    require("proper-lockfile");
    return true;
  } catch {
    return false;
  }
}

const properLockfileAvailable = hasProperLockfile();

// ─── writeLock creates auto.lock in .gsd/ ────────────────────────────────

test("writeLock creates auto.lock with correct structure", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-lock-test-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  writeLock(dir, "starting", "M001");

  const lockPath = join(dir, ".gsd", "auto.lock");
  assert.ok(existsSync(lockPath), "auto.lock should exist after writeLock");

  const data = JSON.parse(readFileSync(lockPath, "utf-8"));
  assert.equal(data.pid, process.pid, "lock should contain current PID");
  assert.equal(data.unitType, "starting", "lock should contain unit type");
  assert.equal(data.unitId, "M001", "lock should contain unit ID");
  assert.ok(data.startedAt, "lock should have startedAt timestamp");

  rmSync(dir, { recursive: true, force: true });
});

test("writeLock updates existing lock with new unit info", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-lock-test-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  writeLock(dir, "starting", "M001");
  writeLock(dir, "execute-task", "M001/S01/T01", "/tmp/session.jsonl");

  const data = JSON.parse(readFileSync(join(dir, ".gsd", "auto.lock"), "utf-8"));
  assert.equal(data.unitType, "execute-task", "lock should be updated to new unit type");
  assert.equal(data.unitId, "M001/S01/T01", "lock should be updated to new unit ID");
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

  writeLock(dir, "plan-milestone", "M002");
  const lock = readCrashLock(dir);

  assert.ok(lock, "should return lock data");
  assert.equal(lock!.unitType, "plan-milestone");
  assert.equal(lock!.unitId, "M002");

  rmSync(dir, { recursive: true, force: true });
});

// ─── clearLock removes auto.lock ─────────────────────────────────────────

test("clearLock removes the lock file", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-lock-test-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  writeLock(dir, "starting", "M001");
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

test("bootstrap cleanup releases session lock artifacts", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-lock-test-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = acquireSessionLock(dir);
  assert.equal(result.acquired, true, "session lock should be acquired");
  assert.ok(existsSync(join(dir, ".gsd", "auto.lock")), "auto.lock should exist while lock is held");
  if (properLockfileAvailable) {
    assert.ok(existsSync(join(dir, ".gsd.lock")), ".gsd.lock should exist while lock is held");
  }

  releaseSessionLock(dir);
  clearLock(dir);

  assert.ok(!existsSync(join(dir, ".gsd", "auto.lock")), "auto.lock should be removed by bootstrap cleanup");
  assert.ok(!existsSync(join(dir, ".gsd.lock")), ".gsd.lock should be removed by bootstrap cleanup");
});

// ─── isLockProcessAlive detects live vs dead PIDs ────────────────────────

test("isLockProcessAlive returns false for dead PID", () => {
  const lock = {
    pid: 9999999,
    startedAt: new Date().toISOString(),
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    unitStartedAt: new Date().toISOString(),
  };
  assert.equal(isLockProcessAlive(lock), false, "dead PID should return false");
});

test("#2470: isLockProcessAlive returns true for own PID (we hold the lock)", () => {
  const lock = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    unitStartedAt: new Date().toISOString(),
  };
  assert.equal(isLockProcessAlive(lock), true, "own PID means we are alive — not stale (#2470)");
});

test("isLockProcessAlive returns false for invalid PID", () => {
  const lock = {
    pid: -1,
    startedAt: new Date().toISOString(),
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    unitStartedAt: new Date().toISOString(),
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
  };
  writeFileSync(join(dir, ".gsd", "auto.lock"), JSON.stringify(lockData, null, 2));

  const lock = readCrashLock(dir);
  assert.ok(lock, "should read the stale lock");
  assert.equal(isLockProcessAlive(lock!), false, "dead process should not be alive");

  rmSync(dir, { recursive: true, force: true });
});
