/**
 * Regression test for #2879: gsd_plan_milestone silently drops milestone title
 * when the DB row pre-exists from state reconciliation.
 *
 * Scenario: state reconciliation inserts a milestone row with an empty title
 * (INSERT OR IGNORE). When gsd_plan_milestone is called later with a title,
 * the title must be persisted — not silently dropped.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  getMilestone,
  upsertMilestonePlanning,
} from "../gsd-db.ts";

test("upsertMilestonePlanning updates title when DB row pre-exists with empty title (#2879)", () => {
  try {
    openDatabase(":memory:");

    // Step 1: Simulate state reconciliation — inserts milestone with empty title
    insertMilestone({ id: "M099", status: "active" });
    const before = getMilestone("M099");
    assert.ok(before, "milestone row should exist after insertMilestone");
    assert.equal(before.title, "", "title should be empty after reconciliation insert");

    // Step 2: Simulate gsd_plan_milestone — insertMilestone is called again
    // with a title, but INSERT OR IGNORE skips it since the row exists.
    insertMilestone({ id: "M099", title: "My Important Milestone", status: "active" });
    const afterInsert = getMilestone("M099");
    assert.ok(afterInsert);
    // The INSERT OR IGNORE means title is still empty — this is the known limitation
    assert.equal(afterInsert.title, "", "INSERT OR IGNORE does not update existing row");

    // Step 3: upsertMilestonePlanning should update the title
    upsertMilestonePlanning("M099", {
      title: "My Important Milestone",
      vision: "Test vision",
    });
    const afterUpsert = getMilestone("M099");
    assert.ok(afterUpsert);
    assert.equal(
      afterUpsert.title,
      "My Important Milestone",
      "title must be updated by upsertMilestonePlanning when row pre-exists",
    );
  } finally {
    closeDatabase();
  }
});

test("upsertMilestonePlanning preserves existing title when no title argument provided", () => {
  try {
    openDatabase(":memory:");

    // Insert milestone with a title
    insertMilestone({ id: "M100", title: "Original Title", status: "active" });

    // Call upsertMilestonePlanning without a title — should preserve existing
    upsertMilestonePlanning("M100", { vision: "Updated vision" });
    const after = getMilestone("M100");
    assert.ok(after);
    assert.equal(after.title, "Original Title", "existing title must be preserved when no title argument given");
  } finally {
    closeDatabase();
  }
});
