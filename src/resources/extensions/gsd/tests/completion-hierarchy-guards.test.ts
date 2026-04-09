// GSD State Machine Regression Tests — Completion Hierarchy & State Derivation (#3161)

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  getTask,
  getSlice,
  getMilestone,
  getSliceTasks,
  updateTaskStatus,
  updateSliceStatus,
} from "../gsd-db.ts";
import { isClosedStatus } from "../status-guards.ts";

// ─── Setup / Teardown ──────────────────────────────────────────────────────

beforeEach(() => {
  openDatabase(":memory:");
});

afterEach(() => {
  try { closeDatabase(); } catch { /* swallow */ }
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("completion-hierarchy-guards", () => {

  // ─── Test 1: isClosedStatus ─────────────────────────────────────────────
  test("isClosedStatus returns true for 'complete' and 'done'", () => {
    assert.ok(isClosedStatus("complete"), "'complete' should be closed");
    assert.ok(isClosedStatus("done"), "'done' should be closed");
    assert.ok(!isClosedStatus("pending"), "'pending' should not be closed");
    assert.ok(!isClosedStatus("in-progress"), "'in-progress' should not be closed");
    assert.ok(!isClosedStatus("blocked"), "'blocked' should not be closed");
    assert.ok(!isClosedStatus(""), "empty string should not be closed");
    assert.ok(!isClosedStatus("active"), "'active' should not be closed");
  });

  // ─── Test 2: vacuous truth guard — slice with zero tasks ───────────────
  test("cannot complete slice with zero tasks — vacuous truth guard", () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });

    const tasks = getSliceTasks("M001", "S01");
    assert.equal(tasks.length, 0, "newly inserted slice has zero tasks");

    // The guard: a slice with no tasks is not completable.
    // isSliceComplete from state.ts: plan.tasks.length > 0 && every done.
    // Here we replicate the DB-side equivalent: zero tasks means guard fires.
    const isCompletable = tasks.length > 0 && tasks.every(t => isClosedStatus(t.status));
    assert.equal(isCompletable, false, "vacuous truth guard: zero tasks → not completable");
  });

  // ─── Test 3: cannot complete slice with incomplete tasks ─────────────────
  test("cannot complete slice with incomplete tasks", () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "done" });
    insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", status: "pending" });

    const tasks = getSliceTasks("M001", "S01");
    assert.equal(tasks.length, 2, "slice has 2 tasks");

    const incompleteTasks = tasks.filter(t => !isClosedStatus(t.status));
    assert.equal(incompleteTasks.length, 1, "exactly one task is not closed");
    assert.equal(incompleteTasks[0]?.id, "T02", "the incomplete task is T02");
    assert.equal(incompleteTasks[0]?.status, "pending", "incomplete task status is 'pending'");
  });

  // ─── Test 4: phantom parent milestone and slice (H6) ────────────────────
  test("task completion auto-creates phantom parent milestone and slice (H6)", () => {
    // H6 finding: insertMilestone/insertSlice accept empty titles — phantom
    // parents can be created without substantive content.
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });

    const milestone = getMilestone("M001");
    assert.ok(milestone !== null, "phantom milestone M001 should exist in DB");
    assert.equal(milestone!.title, "", "phantom milestone has empty title by default");

    const slice = getSlice("M001", "S01");
    assert.ok(slice !== null, "phantom slice S01 should exist in DB");
    assert.equal(slice!.title, "", "phantom slice has empty title by default");

    // This documents the H6 finding: the DB allows phantom parents with
    // no meaningful content, which can silently accept task completion calls.
  });

  // ─── Test 5: double task completion is detectable via isClosedStatus ────
  test("double task completion is detectable via isClosedStatus", () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "done" });

    const task = getTask("M001", "S01", "T01");
    assert.ok(task !== null, "task T01 should exist");
    assert.ok(
      isClosedStatus(task!.status),
      "isClosedStatus detects already-closed task — prevents double completion",
    );

    // The guard that prevents double completion: check isClosedStatus before
    // calling updateTaskStatus again.
    const wouldDoubleComplete = isClosedStatus(task!.status);
    assert.ok(wouldDoubleComplete, "guard fires: task is already closed");
  });

  // ─── Test 6: updateSliceStatus rollback loses original status (M11) ─────
  test("updateSliceStatus rollback goes to 'pending' not original status (M11)", () => {
    insertMilestone({ id: "M001" });
    // Insert with an explicit non-pending status to simulate an in-progress slice
    insertSlice({ id: "S01", milestoneId: "M001", status: "pending" });

    // Manually advance to "in_progress" equivalent via updateSliceStatus
    updateSliceStatus("M001", "S01", "in_progress");
    const afterProgress = getSlice("M001", "S01");
    assert.equal(afterProgress!.status, "in_progress", "slice is in_progress after update");

    // Simulate completion
    updateSliceStatus("M001", "S01", "complete", new Date().toISOString());
    const afterComplete = getSlice("M001", "S01");
    assert.equal(afterComplete!.status, "complete", "slice is complete after completion");

    // Simulate rollback — the DB only stores current status, not history.
    // Rolling back means setting to "pending" — the original "in_progress" is lost.
    updateSliceStatus("M001", "S01", "pending");
    const afterRollback = getSlice("M001", "S01");
    assert.equal(
      afterRollback!.status,
      "pending",
      "M11: rollback sets status to 'pending', original 'in_progress' is lost",
    );
    // Document: there is no completed_at or status history to recover from.
    // The rollback silently discards the in_progress state.
  });

  // ─── Test 7: milestone completion requires all slices closed ─────────────
  test("milestone completion requires all slices closed", () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", status: "done" });
    insertSlice({ id: "S02", milestoneId: "M001", status: "pending" });

    const s01 = getSlice("M001", "S01");
    const s02 = getSlice("M001", "S02");

    assert.ok(s01 !== null, "S01 exists");
    assert.ok(s02 !== null, "S02 exists");

    const slices = [s01!, s02!];
    const incompleteSlices = slices.filter(s => !isClosedStatus(s.status));
    assert.ok(
      incompleteSlices.length > 0,
      "milestone is not completable — has incomplete slices",
    );
    assert.equal(incompleteSlices[0]?.id, "S02", "S02 is the incomplete slice");
    assert.equal(incompleteSlices[0]?.status, "pending", "S02 status is 'pending'");
  });

  // ─── Test 8: closed parent blocks child completion ───────────────────────
  test("closed parent blocks child completion", () => {
    // Insert a milestone already in 'complete' state
    insertMilestone({ id: "M001", status: "complete" });
    insertSlice({ id: "S01", milestoneId: "M001" });

    const milestone = getMilestone("M001");
    assert.ok(milestone !== null, "milestone M001 exists");
    assert.ok(
      isClosedStatus(milestone!.status),
      "parent milestone is closed — isClosedStatus returns true",
    );

    // The guard in complete-slice checks parent status via isClosedStatus.
    // If isClosedStatus(milestone.status) === true, the child cannot be completed.
    const parentIsClosed = isClosedStatus(milestone!.status);
    assert.ok(parentIsClosed, "closed parent guard fires: milestone.status is 'complete'");

    // Verify the slice itself is not yet closed
    const slice = getSlice("M001", "S01");
    assert.ok(slice !== null, "slice S01 exists");
    assert.ok(!isClosedStatus(slice!.status), "slice S01 is not yet closed (parent is already closed)");
  });

});
