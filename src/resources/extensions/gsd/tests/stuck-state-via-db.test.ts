// gsd-2 + Stuck-state DB-migration regression (Phase C)
//
// stuck-state.json file IO has been deleted. The auto-loop now reconstructs
// recentUnits from unit_dispatches (Phase B ledger) and persists
// stuckRecoveryAttempts in runtime_kv (worker scope, soft state).
//
// This test verifies the round-trip via the db modules directly: write
// dispatch rows + a runtime_kv counter, then confirm the same data shape
// the loop expects is returned.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
} from "../gsd-db.ts";
import { registerAutoWorker } from "../db/auto-workers.ts";
import { claimMilestoneLease } from "../db/milestone-leases.ts";
import {
  recordDispatchClaim,
  getRecentUnitKeysForWorker,
} from "../db/unit-dispatches.ts";
import { setRuntimeKv, getRuntimeKv } from "../db/runtime-kv.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-stuck-state-db-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

test("getRecentUnitKeysForWorker reconstructs the recentUnits sliding window", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "T", status: "active" });
  const worker = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(worker, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) return;

  // Record three dispatches in chronological order. Each must transition
  // out of 'claimed' before the next one with the same unit_id can claim
  // (partial unique index). We use distinct unit IDs so all three coexist.
  const claims: number[] = [];
  for (const id of ["U1", "U2", "U3"]) {
    const c = recordDispatchClaim({
      traceId: id, workerId: worker, milestoneLeaseToken: lease.token,
      milestoneId: "M001", unitType: "plan-slice", unitId: id,
    });
    assert.equal(c.ok, true);
    if (c.ok) claims.push(c.dispatchId);
  }

  // The loader should return them oldest-first to match the in-memory
  // window semantics that detect-stuck.ts expects.
  const window = getRecentUnitKeysForWorker(worker, 20);
  assert.deepEqual(window.map(w => w.key), ["U1", "U2", "U3"]);
});

test("getRecentUnitKeysForWorker honors the limit parameter", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "T", status: "active" });
  const worker = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(worker, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) return;

  for (let i = 0; i < 25; i++) {
    const c = recordDispatchClaim({
      traceId: `t${i}`, workerId: worker, milestoneLeaseToken: lease.token,
      milestoneId: "M001", unitType: "plan-slice", unitId: `U${i}`,
    });
    assert.equal(c.ok, true);
  }

  const win20 = getRecentUnitKeysForWorker(worker, 20);
  assert.equal(win20.length, 20);
  // Most recent 20 are U5..U24 (chronological), oldest-first → U5..U24.
  assert.equal(win20[0].key, "U5");
  assert.equal(win20[19].key, "U24");
});

test("stuckRecoveryAttempts round-trips via runtime_kv (stable project scope)", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  registerAutoWorker({ projectRootRealpath: base });

  setRuntimeKv("global", base, "stuck_recovery_attempts", 3);
  assert.equal(getRuntimeKv<number>("global", base, "stuck_recovery_attempts"), 3);
  setRuntimeKv("global", base, "stuck_recovery_attempts", 7);
  assert.equal(getRuntimeKv<number>("global", base, "stuck_recovery_attempts"), 7);
});

test("getRecentUnitKeysForWorker filters by worker_id (no cross-worker bleed)", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "T", status: "active" });
  insertMilestone({ id: "M002", title: "U", status: "active" });
  const w1 = registerAutoWorker({ projectRootRealpath: base });
  const w2 = registerAutoWorker({ projectRootRealpath: base });
  const lease1 = claimMilestoneLease(w1, "M001");
  const lease2 = claimMilestoneLease(w2, "M002");
  assert.equal(lease1.ok, true);
  assert.equal(lease2.ok, true);
  if (!lease1.ok || !lease2.ok) return;

  recordDispatchClaim({
    traceId: "ta", workerId: w1, milestoneLeaseToken: lease1.token,
    milestoneId: "M001", unitType: "plan-slice", unitId: "for-w1",
  });
  recordDispatchClaim({
    traceId: "tb", workerId: w2, milestoneLeaseToken: lease2.token,
    milestoneId: "M002", unitType: "plan-slice", unitId: "for-w2",
  });

  const w1Window = getRecentUnitKeysForWorker(w1, 20);
  const w2Window = getRecentUnitKeysForWorker(w2, 20);
  assert.deepEqual(w1Window.map(w => w.key), ["for-w1"]);
  assert.deepEqual(w2Window.map(w => w.key), ["for-w2"]);
});
