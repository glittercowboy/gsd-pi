// gsd-2 + Crash recovery via DB (Phase C pt 2 — auto.lock migration)
//
// auto.lock file IO is gone. readCrashLock now synthesizes a LockData
// from the workers + unit_dispatches + runtime_kv tables. These tests
// verify the synthesis end-to-end: register a worker, simulate it going
// stale (heartbeat lapsed), and confirm readCrashLock returns the
// correct LockData with PID, started_at, unit details, and session
// file derived from the DB.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  _getAdapter,
} from "../gsd-db.ts";
import { registerAutoWorker } from "../db/auto-workers.ts";
import { claimMilestoneLease } from "../db/milestone-leases.ts";
import { recordDispatchClaim } from "../db/unit-dispatches.ts";
import { setRuntimeKv, getRuntimeKv } from "../db/runtime-kv.ts";
import {
  writeLock,
  readCrashLock,
  clearLock,
  isLockProcessAlive,
} from "../crash-recovery.ts";
import { normalizeRealPath } from "../paths.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-crash-recovery-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

/** Force a worker's last_heartbeat_at into the past so the stale-detector picks it up. */
function expireWorker(workerId: string): void {
  const db = _getAdapter()!;
  db.prepare(
    `UPDATE workers SET last_heartbeat_at = '1970-01-01T00:00:00.000Z' WHERE worker_id = :w`,
  ).run({ ":w": workerId });
}

test("readCrashLock returns null when no workers exist", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  assert.equal(readCrashLock(base), null);
});

test("readCrashLock returns null when only fresh (un-expired) workers exist", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  registerAutoWorker({ projectRootRealpath: normalizeRealPath(base) });
  // Heartbeat is fresh — not stale yet.
  assert.equal(readCrashLock(base), null);
});

test("readCrashLock synthesizes LockData from a stale worker (no dispatches yet)", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  const projectRoot = normalizeRealPath(base);
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });
  expireWorker(workerId);

  const lock = readCrashLock(base);
  assert.ok(lock, "stale worker surfaced as a crash lock");
  assert.equal(lock!.pid, process.pid);
  // Bootstrap default — no dispatches recorded
  assert.equal(lock!.unitType, "starting");
  assert.equal(lock!.unitId, "bootstrap");
  assert.ok(lock!.startedAt, "startedAt populated from workers.started_at");
});

test("readCrashLock includes the most recent dispatch as unitType/unitId", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "T", status: "active" });
  const projectRoot = normalizeRealPath(base);
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });
  const lease = claimMilestoneLease(workerId, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) return;
  recordDispatchClaim({
    traceId: "t1", workerId, milestoneLeaseToken: lease.token,
    milestoneId: "M001", unitType: "plan-slice", unitId: "M001/S01",
  });
  expireWorker(workerId);

  const lock = readCrashLock(base);
  assert.ok(lock);
  assert.equal(lock!.unitType, "plan-slice");
  assert.equal(lock!.unitId, "M001/S01");
});

test("readCrashLock surfaces sessionFile from runtime_kv", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  const projectRoot = normalizeRealPath(base);
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });
  setRuntimeKv("worker", workerId, "session_file", "/tmp/pi-session-abc.jsonl");
  expireWorker(workerId);

  const lock = readCrashLock(base);
  assert.ok(lock);
  assert.equal(lock!.sessionFile, "/tmp/pi-session-abc.jsonl");
});

test("isLockProcessAlive returns true for the current process", () => {
  const lock = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    unitType: "starting",
    unitId: "bootstrap",
    unitStartedAt: new Date().toISOString(),
  };
  assert.equal(isLockProcessAlive(lock), true);
});

test("isLockProcessAlive returns false for a dead PID", () => {
  // PID 99999 is essentially guaranteed dead on a fresh test box.
  const lock = {
    pid: 99999,
    startedAt: new Date().toISOString(),
    unitType: "starting",
    unitId: "bootstrap",
    unitStartedAt: new Date().toISOString(),
  };
  assert.equal(isLockProcessAlive(lock), false);
});

test("writeLock stores the session_file in runtime_kv (worker scope)", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  const projectRoot = normalizeRealPath(base);
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });

  writeLock(base, "plan-slice", "M001/S01", "/tmp/session-xyz.jsonl");

  // Verify the value was written for the live worker.
  const stored = getRuntimeKv<string>("worker", workerId, "session_file");
  assert.equal(stored, "/tmp/session-xyz.jsonl");

  // Confirm a stale read picks it up via readCrashLock.
  expireWorker(workerId);
  const lock = readCrashLock(base);
  assert.ok(lock);
  assert.equal(lock!.sessionFile, "/tmp/session-xyz.jsonl");
});

test("clearLock removes the session_file row for the active worker", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  const projectRoot = normalizeRealPath(base);
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });

  writeLock(base, "plan-slice", "M001/S01", "/tmp/session-xyz.jsonl");
  assert.equal(getRuntimeKv("worker", workerId, "session_file"), "/tmp/session-xyz.jsonl");

  // clearLock operates on the active worker (this process) — must run
  // BEFORE expiring the heartbeat, mirroring stopAuto's order: clearLock
  // → markWorkerStopping → done.
  clearLock(base);
  assert.equal(getRuntimeKv("worker", workerId, "session_file"), null,
    "session_file row deleted by clearLock");
});
