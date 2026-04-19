/**
 * Regression test for #4129: tasks.completed_at stays NULL when status is
 * reconciled to 'complete' via the file-existence path in state.ts.
 *
 * Root cause: reconcileSliceTasks called
 *   updateTaskStatus(milestoneId, sliceId, t.id, "complete")
 * without a completedAt timestamp, so the column stays NULL.
 *
 * Fix: pass new Date().toISOString() as the 5th argument.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const stateSource = readFileSync(join(__dirname, "..", "state.ts"), "utf-8");

describe("completed-at reconcile (#4129)", () => {
  test("reconcileSliceTasks passes a completedAt timestamp when setting status to complete", () => {
    // Before the fix, state.ts had:
    //   updateTaskStatus(milestoneId, sliceId, t.id, "complete")
    // which leaves completed_at NULL in the DB.
    // After the fix, a timestamp must be passed as the 5th argument.
    assert.doesNotMatch(
      stateSource,
      /updateTaskStatus\(\s*milestoneId\s*,\s*sliceId\s*,\s*t\.id\s*,\s*["']complete["']\s*\)/,
      "updateTaskStatus must not be called without a completedAt timestamp when reconciling tasks to 'complete' (#4129)",
    );
  });

  test("reconcileSliceTasks passes new Date().toISOString() as the completedAt argument", () => {
    // Positive assertion: the fixed call must include a timestamp.
    assert.match(
      stateSource,
      /updateTaskStatus\(\s*milestoneId\s*,\s*sliceId\s*,\s*t\.id\s*,\s*["']complete["']\s*,\s*new Date\(\)\.toISOString\(\)\s*\)/,
      "reconcileSliceTasks must pass new Date().toISOString() as completedAt when setting task status to 'complete' (#4129)",
    );
  });
});
