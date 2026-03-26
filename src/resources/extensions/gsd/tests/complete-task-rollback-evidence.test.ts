import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { handleCompleteTask } from "../tools/complete-task.js";
import {
  openDatabase,
  closeDatabase,
  _getAdapter,
  insertMilestone,
  insertSlice,
} from "../gsd-db.js";
import { clearPathCache } from "../paths.js";
import { clearParseCache } from "../files.js";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-ct-rollback-${randomUUID()}`);
  // Create the full tasks directory so the success path works
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}

const VALID_PARAMS = {
  milestoneId: "M001",
  sliceId: "S01",
  taskId: "T01",
  oneLiner: "Test task",
  narrative: "Did the thing",
  verification: "Checked it",
  deviations: "None.",
  knownIssues: "None.",
  keyFiles: ["src/foo.ts"],
  keyDecisions: ["Used approach A"],
  blockerDiscovered: false,
  verificationEvidence: [
    { command: "npm test", exitCode: 0, verdict: "✅ pass", durationMs: 1000 },
    { command: "npm run lint", exitCode: 0, verdict: "✅ pass", durationMs: 500 },
  ],
};

describe("complete-task rollback cleans up verification_evidence (#2724)", () => {
  let base: string;

  afterEach(() => {
    clearPathCache();
    clearParseCache();
    try { closeDatabase(); } catch { /* */ }
    if (base) {
      try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("inserts verification_evidence rows on success", async () => {
    base = makeTmpBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });

    // Write a minimal slice plan so renderPlanCheckboxes doesn't error
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
      "# S01 Plan\n\n## Tasks\n\n- [ ] **T01: Test task**\n",
    );

    const result = await handleCompleteTask(VALID_PARAMS, base);
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);

    const adapter = _getAdapter()!;
    const rows = adapter.prepare(
      `SELECT * FROM verification_evidence WHERE task_id = 'T01' AND slice_id = 'S01' AND milestone_id = 'M001'`,
    ).all();
    assert.equal(rows.length, 2, "should have 2 evidence rows after success");
  });

  it("deletes verification_evidence rows on disk-render rollback", async () => {
    base = makeTmpBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });

    // Replace the tasks directory with a file so disk write fails (cross-platform)
    const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    rmSync(tasksDir, { recursive: true, force: true });
    writeFileSync(tasksDir, "not-a-directory");

    const result = await handleCompleteTask(VALID_PARAMS, base);
    assert.ok("error" in result, "should return error when disk write fails");

    // Task should be rolled back to pending
    const adapter = _getAdapter()!;
    const task = adapter.prepare(
      `SELECT status FROM tasks WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'`,
    ).get() as { status: string } | undefined;
    assert.ok(task, "task row should still exist");
    assert.equal(task!.status, "pending", "task status should be rolled back to pending");

    // Verification evidence should be cleaned up — no orphaned rows
    const evidenceRows = adapter.prepare(
      `SELECT * FROM verification_evidence WHERE task_id = 'T01' AND slice_id = 'S01' AND milestone_id = 'M001'`,
    ).all();
    assert.equal(evidenceRows.length, 0, "verification_evidence should be empty after rollback");
  });
});
