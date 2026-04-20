/**
 * Regression test for #4375: gsd_skip_slice must cascade "skipped" status to
 * all non-closed tasks in the slice.
 *
 * Without the cascade, executeCompleteMilestone's deep-task check finds
 * pending tasks inside a skipped slice and refuses to complete the milestone,
 * causing auto-mode to loop on complete-milestone until stuck-recovery aborts.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  getSlice,
  getSliceTasks,
  updateSliceStatus,
  updateTaskStatus,
} from "../gsd-db.ts";
import { handleSkipSlice } from "../tools/skip-slice.ts";

describe("handleSkipSlice cascades skip to tasks (#4375)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gsd-skip-cascade-"));
    dbPath = join(dir, "test.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({ milestoneId: "M001", id: "S03", title: "Deferred", status: "pending", sequence: 3 });
    insertTask({ milestoneId: "M001", sliceId: "S03", id: "T01", title: "task 1", status: "pending", sequence: 1 });
    insertTask({ milestoneId: "M001", sliceId: "S03", id: "T02", title: "task 2", status: "active", sequence: 2 });
    insertTask({ milestoneId: "M001", sliceId: "S03", id: "T03", title: "task 3", status: "pending", sequence: 3 });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  test("sets slice to skipped and cascades pending/active tasks to skipped", () => {
    const result = handleSkipSlice({ milestoneId: "M001", sliceId: "S03", reason: "deferred" });

    assert.equal(result.error, undefined, `expected success, got error: ${result.error ?? ""}`);
    assert.equal(result.sliceId, "S03");
    assert.equal(result.milestoneId, "M001");
    assert.equal(result.tasksSkipped, 3, "all three non-closed tasks should be cascaded");

    const slice = getSlice("M001", "S03");
    assert.equal(slice?.status, "skipped", "slice status must be skipped");

    const tasks = getSliceTasks("M001", "S03");
    for (const t of tasks) {
      assert.equal(t.status, "skipped", `task ${t.id} must be skipped after cascade`);
    }
  });

  test("does not downgrade already-closed tasks", () => {
    updateTaskStatus("M001", "S03", "T01", "complete", new Date().toISOString());

    const result = handleSkipSlice({ milestoneId: "M001", sliceId: "S03" });

    assert.equal(result.error, undefined);
    assert.equal(result.tasksSkipped, 2, "only the two non-closed tasks should be cascaded");

    const tasks = getSliceTasks("M001", "S03");
    const byId = new Map(tasks.map((t) => [t.id, t.status]));
    assert.equal(byId.get("T01"), "complete", "completed task must not be downgraded");
    assert.equal(byId.get("T02"), "skipped");
    assert.equal(byId.get("T03"), "skipped");
  });

  test("re-running skip on an already-skipped slice heals leftover pending tasks (#4375 recovery)", () => {
    const first = handleSkipSlice({ milestoneId: "M001", sliceId: "S03" });
    assert.equal(first.error, undefined);
    assert.equal(first.tasksSkipped, 3);

    // Simulate historical inconsistent state: slice skipped but a task was
    // later recreated or reset to pending by some migration/bug path.
    updateTaskStatus("M001", "S03", "T01", "pending");

    const second = handleSkipSlice({ milestoneId: "M001", sliceId: "S03" });
    assert.equal(second.error, undefined, "re-running must succeed (no 'already skipped' hard error)");
    assert.equal(second.tasksSkipped, 1, "only the leftover pending task should be cascaded");
    assert.equal(second.wasAlreadySkipped, true);

    const tasks = getSliceTasks("M001", "S03");
    for (const t of tasks) {
      assert.equal(t.status, "skipped", `task ${t.id} must be skipped after recovery`);
    }
  });

  test("refuses to skip an already-complete slice", () => {
    updateSliceStatus("M001", "S03", "complete");

    const result = handleSkipSlice({ milestoneId: "M001", sliceId: "S03" });
    assert.ok(result.error, "expected error when slice is already complete");
    assert.match(result.error!, /already complete/i);
    assert.equal(result.errorCode, "already_complete");
  });

  test("refuses to skip a slice in the legacy 'done' status", () => {
    updateSliceStatus("M001", "S03", "done");

    const result = handleSkipSlice({ milestoneId: "M001", sliceId: "S03" });
    assert.ok(result.error, "expected error when slice is already done");
    assert.match(result.error!, /already complete/i);
    assert.equal(result.errorCode, "already_complete");
  });

  test("returns error for unknown slice", () => {
    const result = handleSkipSlice({ milestoneId: "M001", sliceId: "S99" });
    assert.ok(result.error);
    assert.match(result.error!, /not found/i);
    assert.equal(result.errorCode, "slice_not_found");
  });
});
