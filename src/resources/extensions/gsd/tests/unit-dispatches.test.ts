// gsd-2 + Unit dispatch ledger tests (Phase B coordination — partial unique index, retry metadata)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
} from "../gsd-db.ts";
import { registerAutoWorker } from "../db/auto-workers.ts";
import {
  recordDispatchClaim,
  markRunning,
  markCompleted,
  markFailed,
  markStuck,
  markCanceled,
  getRecentForUnit,
  getLatestForUnit,
} from "../db/unit-dispatches.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-dispatches-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function setup(base: string): { workerId: string } {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice" });
  const workerId = registerAutoWorker({ projectRootRealpath: base });
  return { workerId };
}

test("recordDispatchClaim creates a claimed row", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const { workerId } = setup(base);

  const claim = recordDispatchClaim({
    traceId: "trace-1",
    turnId: "turn-1",
    workerId,
    milestoneLeaseToken: 1,
    milestoneId: "M001",
    sliceId: "S01",
    unitType: "plan-slice",
    unitId: "M001/S01",
  });
  assert.equal(claim.ok, true);
  if (claim.ok) {
    const row = getLatestForUnit("M001/S01");
    assert.ok(row);
    assert.equal(row!.id, claim.dispatchId);
    assert.equal(row!.status, "claimed");
    assert.equal(row!.worker_id, workerId);
    assert.equal(row!.attempt_n, 1);
  }
});

test("partial unique index rejects double-claim of the same active unit", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const { workerId } = setup(base);
  const w2 = registerAutoWorker({ projectRootRealpath: base });

  const first = recordDispatchClaim({
    traceId: "t-a",
    workerId,
    milestoneLeaseToken: 1,
    milestoneId: "M001",
    unitType: "plan-slice",
    unitId: "M001/S01",
  });
  assert.equal(first.ok, true);

  // Second worker tries to claim the same unit while first is still claimed
  const second = recordDispatchClaim({
    traceId: "t-b",
    workerId: w2,
    milestoneLeaseToken: 1,
    milestoneId: "M001",
    unitType: "plan-slice",
    unitId: "M001/S01",
  });
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.error, "already_active");
    assert.equal(second.existingWorker, workerId);
  }
});

test("after markCompleted, a fresh claim for the same unit succeeds", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const { workerId } = setup(base);

  const first = recordDispatchClaim({
    traceId: "t-1",
    workerId,
    milestoneLeaseToken: 1,
    milestoneId: "M001",
    unitType: "plan-slice",
    unitId: "M001/S01",
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  markRunning(first.dispatchId);
  markCompleted(first.dispatchId);

  // Re-dispatch
  const second = recordDispatchClaim({
    traceId: "t-2",
    workerId,
    milestoneLeaseToken: 1,
    milestoneId: "M001",
    unitType: "plan-slice",
    unitId: "M001/S01",
    attemptN: 2,
  });
  assert.equal(second.ok, true);
  if (second.ok) {
    const recent = getRecentForUnit("M001/S01", 5);
    assert.equal(recent.length, 2);
    assert.equal(recent[0].status, "claimed");
    assert.equal(recent[0].attempt_n, 2);
    assert.equal(recent[1].status, "completed");
  }
});

test("markFailed records error_summary and retry metadata", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const { workerId } = setup(base);

  const claim = recordDispatchClaim({
    traceId: "t-1",
    workerId,
    milestoneLeaseToken: 1,
    milestoneId: "M001",
    unitType: "plan-slice",
    unitId: "M001/S01",
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;
  markRunning(claim.dispatchId);
  markFailed(claim.dispatchId, {
    errorSummary: "boom",
    errorCode: "test-fail",
    retryAfterMs: 5000,
  });

  const row = getLatestForUnit("M001/S01")!;
  assert.equal(row.status, "failed");
  assert.equal(row.error_summary, "boom");
  assert.equal(row.last_error_code, "test-fail");
  assert.equal(row.retry_after_ms, 5000);
  assert.ok(row.next_run_at, "next_run_at scheduled");
});

test("markStuck and markCanceled set their respective statuses", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const { workerId } = setup(base);

  const a = recordDispatchClaim({
    traceId: "ta", workerId, milestoneLeaseToken: 1,
    milestoneId: "M001", unitType: "plan-slice", unitId: "M001/S01",
  });
  assert.equal(a.ok, true);
  if (!a.ok) return;
  markStuck(a.dispatchId, "test-stuck");
  assert.equal(getLatestForUnit("M001/S01")!.status, "stuck");

  const b = recordDispatchClaim({
    traceId: "tb", workerId, milestoneLeaseToken: 1,
    milestoneId: "M001", unitType: "run-task", unitId: "M001/S01/T01",
  });
  assert.equal(b.ok, true);
  if (!b.ok) return;
  markCanceled(b.dispatchId, "user-cancel");
  assert.equal(getLatestForUnit("M001/S01/T01")!.status, "canceled");
});

test("recordDispatchClaim rethrows foreign-key failures instead of mapping them to already_active", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  setup(base);

  assert.throws(
    () => recordDispatchClaim({
      traceId: "t-fk",
      workerId: "missing-worker",
      milestoneLeaseToken: 1,
      milestoneId: "M001",
      unitType: "plan-slice",
      unitId: "M001/S01",
    }),
    /FOREIGN KEY constraint failed/,
  );
});
