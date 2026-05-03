// gsd-2 + Stuck-detector retry coupling regression (Phase B / codex MEDIUM B3)
//
// Rule 2b previously tripped on 3 same-unit appearances regardless of
// retry budget. With unit_dispatches.attempt_n + next_run_at driving in-DB
// backoff, a unit that fails 3× under retry would trip the stuck-detector
// before its retry budget exhausted. This test verifies suppression while
// the retry window is open and re-engagement once the window passes or
// budget exhausts.

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
import {
  recordDispatchClaim,
  markFailed,
  getLatestForUnit,
} from "../db/unit-dispatches.ts";
import { detectStuck } from "../auto/detect-stuck.ts";
import type { WindowEntry } from "../auto/types.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-detect-stuck-retry-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function windowOf(...keys: string[]): WindowEntry[] {
  return keys.map((key) => ({ key }));
}

test("rule 2b trips with no DB context (legacy behavior preserved)", () => {
  // No DB open — getLatestForUnit returns null, suppression cannot fire,
  // pre-Phase-B behavior is intact.
  const result = detectStuck(
    windowOf(
      "plan-slice:M001/S01",
      "other-unit",
      "plan-slice:M001/S01",
      "third-unit",
      "plan-slice:M001/S01",
    ),
  );
  assert.ok(result, "stuck signal returned");
  assert.equal(result!.stuck, true);
});

test("rule 2b SUPPRESSED while retry budget remains and next_run_at is in the future", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "T", status: "active" });
  const w = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(w, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) return;

  // Record a failed dispatch with attempt_n=1, max_attempts=3, retry_after
  // pushing next_run_at into the future.
  const claim = recordDispatchClaim({
    traceId: "t1", workerId: w, milestoneLeaseToken: lease.token,
    milestoneId: "M001", unitType: "plan-slice", unitId: "plan-slice:M001/S01",
    attemptN: 1, maxAttempts: 3,
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;
  markFailed(claim.dispatchId, { errorSummary: "transient", retryAfterMs: 60_000 });

  const latest = getLatestForUnit("plan-slice:M001/S01")!;
  assert.equal(latest.attempt_n, 1);
  assert.ok(latest.next_run_at);

  const result = detectStuck(
    windowOf(
      "plan-slice:M001/S01",
      "other-unit",
      "plan-slice:M001/S01",
      "third-unit",
      "plan-slice:M001/S01",
    ),
  );
  assert.equal(result, null, "rule 2b suppressed while retry window is active");
});

test("rule 2b RE-ENGAGES once attempt_n reaches max_attempts", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "T", status: "active" });
  const w = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(w, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) return;

  // Burn through attempts up to the cap — last attempt = max_attempts.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const claim = recordDispatchClaim({
      traceId: `t${attempt}`, workerId: w, milestoneLeaseToken: lease.token,
      milestoneId: "M001", unitType: "plan-slice", unitId: "plan-slice:M001/S01",
      attemptN: attempt, maxAttempts: 3,
    });
    assert.equal(claim.ok, true);
    if (!claim.ok) return;
    markFailed(claim.dispatchId, { errorSummary: "transient", retryAfterMs: 60_000 });
  }

  const latest = getLatestForUnit("plan-slice:M001/S01")!;
  assert.equal(latest.attempt_n, 3);
  assert.equal(latest.max_attempts, 3);

  const result = detectStuck(
    windowOf(
      "plan-slice:M001/S01",
      "other-unit",
      "plan-slice:M001/S01",
      "third-unit",
      "plan-slice:M001/S01",
    ),
  );
  assert.ok(result, "stuck signal returned once retry budget is exhausted");
});

test("rule 2b RE-ENGAGES once next_run_at is in the past", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "T", status: "active" });
  const w = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(w, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) return;

  const claim = recordDispatchClaim({
    traceId: "t", workerId: w, milestoneLeaseToken: lease.token,
    milestoneId: "M001", unitType: "plan-slice", unitId: "plan-slice:M001/S01",
    attemptN: 1, maxAttempts: 3,
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;
  markFailed(claim.dispatchId, { errorSummary: "transient", retryAfterMs: 60_000 });

  // Force next_run_at into the past — retry window has already lapsed.
  const db = _getAdapter()!;
  db.prepare(
    `UPDATE unit_dispatches SET next_run_at = '1970-01-01T00:00:00.000Z' WHERE id = :id`,
  ).run({ ":id": claim.dispatchId });

  const result = detectStuck(
    windowOf(
      "plan-slice:M001/S01",
      "other-unit",
      "plan-slice:M001/S01",
      "third-unit",
      "plan-slice:M001/S01",
    ),
  );
  assert.ok(result, "stuck re-engages once retry window has passed");
});
