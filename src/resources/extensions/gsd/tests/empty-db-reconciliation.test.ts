/**
 * Regression test for #2631: disk→DB reconciliation must run even when the
 * milestones table starts empty.
 *
 * Updated by #2985: reconciliation is now an explicit call
 * (reconcileDiskMilestonesToDb) separated from the read path (deriveState)
 * to enforce CQS.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { deriveState, invalidateStateCache, reconcileDiskMilestonesToDb } from "../state.ts";
import {
  openDatabase,
  closeDatabase,
  getAllMilestones,
} from "../gsd-db.ts";

test("reconcileDiskMilestonesToDb populates empty DB from disk milestones (#2631)", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-empty-db-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });

  try {
    // Create a milestone on disk with a CONTEXT file (not a ghost)
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"),
      "# M001: Test Milestone\n\nSome context about this milestone.",
    );

    // Open DB — milestones table is empty (simulating failed migration)
    openDatabase(":memory:");
    const before = getAllMilestones();
    assert.equal(before.length, 0, "DB should start with 0 milestones");

    // Explicit reconciliation (#2985 — CQS fix)
    reconcileDiskMilestonesToDb(base);

    // After reconciliation, the DB should now have the disk milestone
    const after = getAllMilestones();
    assert.ok(after.length > 0, "DB should have milestones after reconciliation");
    assert.equal(after[0]!.id, "M001", "reconciled milestone should be M001");

    // deriveState should reflect the reconciled milestone
    invalidateStateCache();
    const state = await deriveState(base);
    assert.ok(
      state.activeMilestone !== null,
      "activeMilestone should not be null after reconciliation",
    );

    closeDatabase();
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("reconcileDiskMilestonesToDb does NOT insert ghost milestones into DB (#2631 guard)", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-empty-db-"));
  // Create a ghost milestone directory (empty — no CONTEXT, no ROADMAP)
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });

  try {
    openDatabase(":memory:");
    reconcileDiskMilestonesToDb(base);

    const milestones = getAllMilestones();
    assert.equal(milestones.length, 0, "ghost milestone should NOT be inserted");

    closeDatabase();
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
