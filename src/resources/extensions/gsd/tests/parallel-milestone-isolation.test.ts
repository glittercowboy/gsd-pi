// gsd-2 + Parallel-worker isolation regression (Phase B coordination)
//
// Two simulated workers attempt to claim leases on the same project. The
// lease infrastructure must guarantee:
//   - On the same milestone: only one wins; the loser sees held_by error
//   - On different milestones: both succeed independently
//
// This is the integration check that ties registerAutoWorker +
// claimMilestoneLease + recordDispatchClaim together end-to-end.

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
import { recordDispatchClaim } from "../db/unit-dispatches.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-parallel-iso-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

test("two workers contesting the same milestone: only one wins the lease", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Contested", status: "active" });

  const w1 = registerAutoWorker({ projectRootRealpath: base });
  const w2 = registerAutoWorker({ projectRootRealpath: base });

  const r1 = claimMilestoneLease(w1, "M001");
  const r2 = claimMilestoneLease(w2, "M001");

  assert.equal(r1.ok, true, "first claim wins");
  assert.equal(r2.ok, false, "second claim is rejected");
  if (!r2.ok) {
    assert.equal(r2.error, "held_by");
    assert.equal(r2.byWorker, w1);
  }
});

test("two workers on different milestones can both proceed independently", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "First", status: "active" });
  insertMilestone({ id: "M002", title: "Second", status: "active" });

  const w1 = registerAutoWorker({ projectRootRealpath: base });
  const w2 = registerAutoWorker({ projectRootRealpath: base });

  const r1 = claimMilestoneLease(w1, "M001");
  const r2 = claimMilestoneLease(w2, "M002");

  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  if (r1.ok && r2.ok) {
    assert.equal(r1.token, 1);
    assert.equal(r2.token, 1);
  }
});

test("dispatch ledger ties unit_id uniqueness to active status", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "T", status: "active" });

  const w1 = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(w1, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) return;

  // The same lease holder attempts to claim the same unit twice.
  // The partial unique index on unit_dispatches.unit_id WHERE status IN
  // ('claimed','running') must serialize the writes even before the unit transitions.
  const claim1 = recordDispatchClaim({
    traceId: "t1", workerId: w1, milestoneLeaseToken: lease.token,
    milestoneId: "M001", unitType: "plan-slice", unitId: "M001/S01",
  });
  const claim2 = recordDispatchClaim({
    traceId: "t2", workerId: w1, milestoneLeaseToken: lease.token,
    milestoneId: "M001", unitType: "plan-slice", unitId: "M001/S01",
  });

  assert.equal(claim1.ok, true);
  assert.equal(claim2.ok, false);
  if (!claim2.ok) {
    assert.equal(claim2.error, "already_active");
  }
});
