import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  writeLock,
  clearLock,
  readCrashLock,
  isLockProcessAlive,
  formatCrashInfo,
  type LockData,
} from "../crash-recovery.ts";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
}

// ─── writeLock / readCrashLock ────────────────────────────────────────────

test("writeLock creates lock file and readCrashLock reads it", () => {
  const base = makeTmpBase();
  try {
    writeLock(base, "execute-task", "M001/S01/T01", 3, "/tmp/session.jsonl");
    const lock = readCrashLock(base);
    assert.ok(lock, "lock should exist");
    assert.equal(lock!.unitType, "execute-task");
    assert.equal(lock!.unitId, "M001/S01/T01");
    assert.equal(lock!.completedUnits, 3);
    assert.equal(lock!.sessionFile, "/tmp/session.jsonl");
    assert.equal(lock!.pid, process.pid);
  } finally {
    cleanup(base);
  }
});

test("readCrashLock returns null when no lock exists", () => {
  const base = makeTmpBase();
  try {
    const lock = readCrashLock(base);
    assert.equal(lock, null);
  } finally {
    cleanup(base);
  }
});

// ─── clearLock ────────────────────────────────────────────────────────────

test("clearLock removes existing lock file", () => {
  const base = makeTmpBase();
  try {
    writeLock(base, "plan-slice", "M001/S01", 0);
    assert.ok(readCrashLock(base), "lock should exist before clear");
    clearLock(base);
    assert.equal(readCrashLock(base), null, "lock should be gone after clear");
  } finally {
    cleanup(base);
  }
});

test("clearLock is safe when no lock exists", () => {
  const base = makeTmpBase();
  try {
    assert.doesNotThrow(() => clearLock(base));
  } finally {
    cleanup(base);
  }
});

// ─── isLockProcessAlive ──────────────────────────────────────────────────

test("isLockProcessAlive returns true for current process (different pid)", () => {
  // Our own PID is explicitly excluded (recycled PID guard)
  const lock: LockData = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    unitStartedAt: new Date().toISOString(),
    completedUnits: 0,
  };
  assert.equal(isLockProcessAlive(lock), false, "own PID should return false");
});

test("isLockProcessAlive returns false for dead PID", () => {
  const lock: LockData = {
    pid: 999999999, // almost certainly not running
    startedAt: new Date().toISOString(),
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    unitStartedAt: new Date().toISOString(),
    completedUnits: 0,
  };
  assert.equal(isLockProcessAlive(lock), false);
});

test("isLockProcessAlive returns false for invalid PIDs", () => {
  const base: Omit<LockData, "pid"> = {
    startedAt: new Date().toISOString(),
    unitType: "x",
    unitId: "x",
    unitStartedAt: new Date().toISOString(),
    completedUnits: 0,
  };
  assert.equal(isLockProcessAlive({ ...base, pid: 0 } as LockData), false);
  assert.equal(isLockProcessAlive({ ...base, pid: -1 } as LockData), false);
  assert.equal(isLockProcessAlive({ ...base, pid: 1.5 } as LockData), false);
});

// ─── formatCrashInfo ─────────────────────────────────────────────────────

test("formatCrashInfo includes unit type, id, and PID", () => {
  const lock: LockData = {
    pid: 12345,
    startedAt: "2025-01-01T00:00:00.000Z",
    unitType: "complete-slice",
    unitId: "M002/S03",
    unitStartedAt: "2025-01-01T00:01:00.000Z",
    completedUnits: 7,
  };
  const info = formatCrashInfo(lock);
  assert.ok(info.includes("complete-slice"));
  assert.ok(info.includes("M002/S03"));
  assert.ok(info.includes("12345"));
  assert.ok(info.includes("7"));
});
