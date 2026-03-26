import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractCommitShas,
  findCommitsForUnit,
  handleUndo,
  handleUndoTask,
  handleResetSlice,
  uncheckTaskInPlan,
} from "../undo.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  getTask,
  getSlice,
} from "../gsd-db.ts";
import { invalidateAllCaches } from "../cache.ts";
import { existsSync } from "node:fs";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

test("handleUndo without --force only warns and leaves completed units intact", async () => {
  const base = makeTempDir("gsd-undo-confirm");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    mkdirSync(join(base, ".gsd", "activity"), { recursive: true });
    writeFileSync(
      join(base, ".gsd", "completed-units.json"),
      JSON.stringify(["execute-task/M001/S01/T01"]),
      "utf-8",
    );
    writeFileSync(
      join(base, ".gsd", "activity", "001-execute-task-M001-S01-T01.jsonl"),
      "",
      "utf-8",
    );

    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = {
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    };

    await handleUndo("", ctx as any, {} as any, base);

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.level, "warning");
    assert.match(notifications[0]?.message ?? "", /Run \/gsd undo --force to confirm\./);
    assert.deepEqual(
      JSON.parse(readFileSync(join(base, ".gsd", "completed-units.json"), "utf-8")),
      ["execute-task/M001/S01/T01"],
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("uncheckTaskInPlan flips a checked task back to unchecked", () => {
  const base = makeTempDir("gsd-undo-plan");
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    const planFile = join(sliceDir, "S01-PLAN.md");
    writeFileSync(
      planFile,
      [
        "# Slice Plan",
        "",
        "- [x] **T01**: Ship the feature",
        "- [ ] **T02**: Follow-up",
      ].join("\n"),
      "utf-8",
    );

    assert.equal(uncheckTaskInPlan(base, "M001", "S01", "T01"), true);
    assert.match(readFileSync(planFile, "utf-8"), /- \[ \] \*\*T01\*\*: Ship the feature/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("findCommitsForUnit reads the newest matching activity log and dedupes SHAs", () => {
  const base = makeTempDir("gsd-undo-activity");
  try {
    const activityDir = join(base, ".gsd", "activity");
    mkdirSync(activityDir, { recursive: true });

    writeFileSync(
      join(activityDir, "2026-03-14-execute-task-M001-S01-T01.jsonl"),
      `${JSON.stringify({
        message: {
          content: [
            { type: "tool_result", content: "[main abc1234] old commit" },
          ],
        },
      })}\n`,
      "utf-8",
    );

    writeFileSync(
      join(activityDir, "2026-03-15-execute-task-M001-S01-T01.jsonl"),
      [
        JSON.stringify({
          message: {
            content: [
              { type: "tool_result", content: "[main deadbee] new commit\n[main cafe123] another commit" },
              { type: "tool_result", content: "[main deadbee] duplicate commit" },
            ],
          },
        }),
        "{not-json}",
      ].join("\n"),
      "utf-8",
    );

    assert.deepEqual(
      findCommitsForUnit(activityDir, "execute-task", "M001/S01/T01"),
      ["deadbee", "cafe123"],
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("extractCommitShas returns unique commit hashes from git output blocks", () => {
  const content = [
    "[main abc1234] first commit",
    "[feature deadbeef] second commit",
    "[main abc1234] duplicate commit",
  ].join("\n");

  assert.deepEqual(extractCommitShas(content), ["abc1234", "deadbeef"]);
});

test("extractCommitShas ignores malformed commit tokens", () => {
  const content = [
    "[main abc1234; touch /tmp/pwned] not a real sha token",
    "[main not-a-sha] ignored",
    "[main 1234567] valid",
  ].join("\n");

  assert.deepEqual(extractCommitShas(content), ["1234567"]);
});

// ─── handleUndoTask tests ────────────────────────────────────────────────────

function makeCtx(): { notifications: Array<{ message: string; level: string }>; ctx: any } {
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };
  return { notifications, ctx };
}

function setupTaskFixture(base: string): void {
  // Create milestone/slice/task directory structure
  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });

  // Write plan file with checked task
  writeFileSync(
    join(sliceDir, "S01-PLAN.md"),
    [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "- [x] **T01: First task** `est:30m`",
      "- [ ] **T02: Second task** `est:30m`",
    ].join("\n"),
    "utf-8",
  );

  // Write task summary file
  writeFileSync(
    join(tasksDir, "T01-SUMMARY.md"),
    "# T01 Summary\nDone.",
    "utf-8",
  );

  // Set up DB
  openDatabase(":memory:");
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice", status: "active", risk: "low", depends: [] });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First task", status: "complete" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Second task", status: "pending" });
  invalidateAllCaches();
}

test("handleUndoTask without args shows usage", async () => {
  const { notifications, ctx } = makeCtx();
  const base = makeTempDir("gsd-undo-task-usage");
  try {
    await handleUndoTask("", ctx, {} as any, base);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.level, "warning");
    assert.match(notifications[0]?.message ?? "", /Usage:/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleUndoTask without --force shows confirmation", async () => {
  const base = makeTempDir("gsd-undo-task-confirm");
  try {
    setupTaskFixture(base);
    const { notifications, ctx } = makeCtx();
    await handleUndoTask("M001/S01/T01", ctx, {} as any, base);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.level, "warning");
    assert.match(notifications[0]?.message ?? "", /--force to confirm/);
    // Verify state was NOT modified
    const task = getTask("M001", "S01", "T01");
    assert.equal(task?.status, "complete");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleUndoTask with --force resets task and re-renders plan", async () => {
  const base = makeTempDir("gsd-undo-task-force");
  try {
    setupTaskFixture(base);
    const { notifications, ctx } = makeCtx();
    await handleUndoTask("M001/S01/T01 --force", ctx, {} as any, base);

    // DB status reset
    const task = getTask("M001", "S01", "T01");
    assert.equal(task?.status, "pending");

    // Summary file deleted
    const summaryPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md");
    assert.equal(existsSync(summaryPath), false);

    // Plan checkbox unchecked
    const planContent = readFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
      "utf-8",
    );
    assert.match(planContent, /\[ \] \*\*T01:/);

    // Success notification
    assert.equal(notifications[0]?.level, "success");
    assert.match(notifications[0]?.message ?? "", /Reset task M001\/S01\/T01/);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleUndoTask with non-existent task returns error", async () => {
  const base = makeTempDir("gsd-undo-task-notfound");
  try {
    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Test", status: "active", risk: "low", depends: [] });

    const { notifications, ctx } = makeCtx();
    await handleUndoTask("M001/S01/T99 --force", ctx, {} as any, base);
    assert.equal(notifications[0]?.level, "error");
    assert.match(notifications[0]?.message ?? "", /not found/);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleUndoTask accepts partial ID (T01) and resolves from state", async () => {
  const base = makeTempDir("gsd-undo-task-partial");
  try {
    setupTaskFixture(base);

    // Create STATE.md so deriveState can resolve the active milestone/slice
    mkdirSync(join(base, ".gsd"), { recursive: true });
    writeFileSync(
      join(base, ".gsd", "STATE.md"),
      [
        "# GSD State",
        "",
        "- Phase: executing",
        "- Active Milestone: M001",
        "- Active Slice: S01",
        "- Active Task: T01",
      ].join("\n"),
      "utf-8",
    );

    const { notifications, ctx } = makeCtx();
    await handleUndoTask("T01 --force", ctx, {} as any, base);

    const task = getTask("M001", "S01", "T01");
    assert.equal(task?.status, "pending");
    assert.equal(notifications[0]?.level, "success");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

// ─── handleResetSlice tests ──────────────────────────────────────────────────

function setupSliceFixture(base: string): void {
  const mDir = join(base, ".gsd", "milestones", "M001");
  const sliceDir = join(mDir, "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });

  // Write roadmap file
  writeFileSync(
    join(mDir, "M001-ROADMAP.md"),
    [
      "# Roadmap",
      "",
      "## Slices",
      "",
      "- [x] **S01: Test Slice** `risk:low` `depends:[]`",
      "- [ ] **S02: Next Slice** `risk:low` `depends:[S01]`",
    ].join("\n"),
    "utf-8",
  );

  // Write plan file
  writeFileSync(
    join(sliceDir, "S01-PLAN.md"),
    [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "- [x] **T01: First task** `est:30m`",
      "- [x] **T02: Second task** `est:30m`",
    ].join("\n"),
    "utf-8",
  );

  // Write task summaries
  writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "# T01 Summary\nDone.", "utf-8");
  writeFileSync(join(tasksDir, "T02-SUMMARY.md"), "# T02 Summary\nDone.", "utf-8");

  // Write slice summary and UAT
  writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Slice Summary\nDone.", "utf-8");
  writeFileSync(join(sliceDir, "S01-UAT.md"), "# UAT\nPassed.", "utf-8");

  // Set up DB
  openDatabase(":memory:");
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice", status: "complete", risk: "low", depends: [] });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Next Slice", status: "pending", risk: "low", depends: ["S01"] });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First task", status: "complete" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Second task", status: "complete" });
  invalidateAllCaches();
}

test("handleResetSlice without args shows usage", async () => {
  const { notifications, ctx } = makeCtx();
  const base = makeTempDir("gsd-reset-slice-usage");
  try {
    await handleResetSlice("", ctx, {} as any, base);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.level, "warning");
    assert.match(notifications[0]?.message ?? "", /Usage:/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleResetSlice without --force shows confirmation", async () => {
  const base = makeTempDir("gsd-reset-slice-confirm");
  try {
    setupSliceFixture(base);
    const { notifications, ctx } = makeCtx();
    await handleResetSlice("M001/S01", ctx, {} as any, base);
    assert.equal(notifications[0]?.level, "warning");
    assert.match(notifications[0]?.message ?? "", /--force to confirm/);
    // State not modified
    const slice = getSlice("M001", "S01");
    assert.equal(slice?.status, "complete");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleResetSlice with --force resets slice and all tasks", async () => {
  const base = makeTempDir("gsd-reset-slice-force");
  try {
    setupSliceFixture(base);
    const { notifications, ctx } = makeCtx();
    await handleResetSlice("M001/S01 --force", ctx, {} as any, base);

    // DB status reset
    const slice = getSlice("M001", "S01");
    assert.equal(slice?.status, "active");
    const t1 = getTask("M001", "S01", "T01");
    assert.equal(t1?.status, "pending");
    const t2 = getTask("M001", "S01", "T02");
    assert.equal(t2?.status, "pending");

    // Task summaries deleted
    const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    assert.equal(existsSync(join(tasksDir, "T01-SUMMARY.md")), false);
    assert.equal(existsSync(join(tasksDir, "T02-SUMMARY.md")), false);

    // Slice summary and UAT deleted
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    assert.equal(existsSync(join(sliceDir, "S01-SUMMARY.md")), false);
    assert.equal(existsSync(join(sliceDir, "S01-UAT.md")), false);

    // Plan checkboxes unchecked
    const planContent = readFileSync(join(sliceDir, "S01-PLAN.md"), "utf-8");
    assert.match(planContent, /\[ \] \*\*T01:/);
    assert.match(planContent, /\[ \] \*\*T02:/);

    // Roadmap checkbox unchecked
    const roadmapContent = readFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      "utf-8",
    );
    assert.match(roadmapContent, /\[ \] \*\*S01:/);

    // Success notification
    assert.equal(notifications[0]?.level, "success");
    assert.match(notifications[0]?.message ?? "", /Reset slice M001\/S01/);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("handleResetSlice with non-existent slice returns error", async () => {
  const base = makeTempDir("gsd-reset-slice-notfound");
  try {
    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Test", status: "active" });

    const { notifications, ctx } = makeCtx();
    await handleResetSlice("M001/S99 --force", ctx, {} as any, base);
    assert.equal(notifications[0]?.level, "error");
    assert.match(notifications[0]?.message ?? "", /not found/);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
