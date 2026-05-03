// gsd-2 + Milestone leases tests (Phase B coordination — fencing semantics)

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
import {
  claimMilestoneLease,
  releaseMilestoneLease,
  refreshMilestoneLease,
  getMilestoneLease,
} from "../db/milestone-leases.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-leases-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

test("first claim returns ok=true with token=1", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });

  const w1 = registerAutoWorker({ projectRootRealpath: base });
  const claim = claimMilestoneLease(w1, "M001");
  assert.equal(claim.ok, true);
  if (claim.ok) {
    assert.equal(claim.token, 1, "fresh claim starts fencing token at 1");
  }

  const row = getMilestoneLease("M001");
  assert.ok(row);
  assert.equal(row!.worker_id, w1);
  assert.equal(row!.fencing_token, 1);
  assert.equal(row!.status, "held");
});

test("second claim by different worker is rejected while lease is held", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });

  const w1 = registerAutoWorker({ projectRootRealpath: base });
  const w2 = registerAutoWorker({ projectRootRealpath: base });
  const first = claimMilestoneLease(w1, "M001");
  assert.equal(first.ok, true);

  const second = claimMilestoneLease(w2, "M001");
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.error, "held_by");
    assert.equal(second.byWorker, w1);
  }
});

test("releaseMilestoneLease frees the lease for takeover", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });

  const w1 = registerAutoWorker({ projectRootRealpath: base });
  const w2 = registerAutoWorker({ projectRootRealpath: base });
  const first = claimMilestoneLease(w1, "M001");
  assert.equal(first.ok, true);

  if (first.ok) {
    const released = releaseMilestoneLease(w1, "M001", first.token);
    assert.equal(released, true);
  }

  // After release, w2 may take over with monotonically larger token
  const second = claimMilestoneLease(w2, "M001");
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.equal(second.token, 2, "takeover increments fencing token monotonically");
  }
});

test("expired lease (TTL passed) allows takeover with token+1", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });

  const w1 = registerAutoWorker({ projectRootRealpath: base });
  const w2 = registerAutoWorker({ projectRootRealpath: base });
  const first = claimMilestoneLease(w1, "M001");
  assert.equal(first.ok, true);

  // Force expiration by patching the row's expires_at into the past.
  const db = _getAdapter()!;
  db.prepare(
    `UPDATE milestone_leases SET expires_at = '1970-01-01T00:00:00.000Z' WHERE milestone_id = 'M001'`,
  ).run();

  const takeover = claimMilestoneLease(w2, "M001");
  assert.equal(takeover.ok, true);
  if (takeover.ok) {
    assert.equal(takeover.token, 2);
  }
  const row = getMilestoneLease("M001");
  assert.equal(row!.worker_id, w2);
  assert.equal(row!.fencing_token, 2);
});

test("refreshMilestoneLease only succeeds with the matching fencing token", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });

  const w1 = registerAutoWorker({ projectRootRealpath: base });
  const claim = claimMilestoneLease(w1, "M001");
  assert.equal(claim.ok, true);
  if (!claim.ok) return;

  // Correct token refreshes
  assert.equal(refreshMilestoneLease(w1, "M001", claim.token), true);

  // Stale token (e.g. claim.token - 1) refuses
  assert.equal(refreshMilestoneLease(w1, "M001", claim.token - 1), false);
});

test("claimMilestoneLease rethrows foreign-key failures instead of treating them as lease contention", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });

  assert.throws(
    () => claimMilestoneLease("missing-worker", "M001"),
    /FOREIGN KEY constraint failed/,
  );
});
