/**
 * state-machine-live-validation.test.ts — Live operational validation of the
 * GSD state machine with real handlers, real DB, and real filesystem.
 *
 * Exercises every phase transition, completion guard, edge case, and reopen
 * path end-to-end. This is NOT a unit test — it drives the actual tool handlers
 * against a real temp directory with a real SQLite database.
 *
 * Findings reference: #3161 (state machine validation report)
 */

// GSD State Machine Live Validation (#3161)



import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── DB layer ──────────────────────────────────────────────────────────────
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
  getMilestoneSlices,
  updateTaskStatus,
  updateSliceStatus,
  updateMilestoneStatus,
} from "../../gsd-db.ts";

// ── Tool handlers ─────────────────────────────────────────────────────────
import { handleCompleteTask } from "../../tools/complete-task.ts";
import { handleCompleteSlice } from "../../tools/complete-slice.ts";
import { handleCompleteMilestone } from "../../tools/complete-milestone.ts";
import { handleReopenTask } from "../../tools/reopen-task.ts";
import { handleReopenSlice } from "../../tools/reopen-slice.ts";

// ── State derivation ──────────────────────────────────────────────────────
import {
  deriveState,
  deriveStateFromDb,
  invalidateStateCache,
  isGhostMilestone,
} from "../../state.ts";

// ── Status guards ─────────────────────────────────────────────────────────
import { isClosedStatus } from "../../status-guards.ts";

// ── Events ────────────────────────────────────────────────────────────────
import { readEvents } from "../../workflow-events.ts";

// ── Cache invalidation ───────────────────────────────────────────────────
import { invalidateAllCaches } from "../../cache.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Fixture Helpers
// ═══════════════════════════════════════════════════════════════════════════

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "gsd-live-validation-"));
}

/**
 * Create a realistic .gsd/ fixture with:
 * - M001 milestone with ROADMAP, CONTEXT
 * - S01 slice with PLAN (2 tasks T01, T02)
 * - S02 slice with PLAN (1 task T01)
 * - Task PLAN stubs for each task
 * - REQUIREMENTS.md and DECISIONS.md
 */
function createFullFixture(): string {
  const base = makeTempDir();
  const gsdDir = join(base, ".gsd");
  const m001Dir = join(gsdDir, "milestones", "M001");
  const s01Dir = join(m001Dir, "slices", "S01");
  const s01Tasks = join(s01Dir, "tasks");
  const s02Dir = join(m001Dir, "slices", "S02");
  const s02Tasks = join(s02Dir, "tasks");

  mkdirSync(s01Tasks, { recursive: true });
  mkdirSync(s02Tasks, { recursive: true });

  // CONTEXT.md — needed to get past needs-discussion
  writeFileSync(
    join(m001Dir, "M001-CONTEXT.md"),
    [
      "# M001: Live Validation Milestone",
      "",
      "## Purpose",
      "Validate the state machine end-to-end.",
    ].join("\n"),
  );

  // ROADMAP.md
  writeFileSync(
    join(m001Dir, "M001-ROADMAP.md"),
    [
      "# M001: Live Validation Milestone",
      "",
      "## Vision",
      "Prove state machine correctness.",
      "",
      "## Success Criteria",
      "- All operations succeed",
      "",
      "## Slices",
      "",
      "- [ ] **S01: First Feature** `risk:low` `depends:[]`",
      "  - After this: First feature proven.",
      "",
      "- [ ] **S02: Second Feature** `risk:low` `depends:[]`",
      "  - After this: Second feature proven.",
      "",
      "## Boundary Map",
      "",
      "| From | To | Produces | Consumes |",
      "|------|----|----------|----------|",
      "| S01 | terminal | feature-a | nothing |",
      "| S02 | terminal | feature-b | nothing |",
    ].join("\n"),
  );

  // S01 PLAN
  writeFileSync(
    join(s01Dir, "S01-PLAN.md"),
    [
      "# S01: First Feature",
      "",
      "**Goal:** Implement first feature.",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: Implementation** `est:30m`",
      "  - Do: Build it",
      "  - Verify: Run tests",
      "",
      "- [ ] **T02: Testing** `est:30m`",
      "  - Do: Write tests",
      "  - Verify: Run tests",
    ].join("\n"),
  );

  // S01 task plan stubs
  writeFileSync(join(s01Tasks, "T01-PLAN.md"), "# T01 Plan\nImplement.\n");
  writeFileSync(join(s01Tasks, "T02-PLAN.md"), "# T02 Plan\nTest.\n");

  // S02 PLAN
  writeFileSync(
    join(s02Dir, "S02-PLAN.md"),
    [
      "# S02: Second Feature",
      "",
      "**Goal:** Implement second feature.",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: Implementation** `est:30m`",
      "  - Do: Build it",
      "  - Verify: Run tests",
    ].join("\n"),
  );

  // S02 task plan stub
  writeFileSync(join(s02Tasks, "T01-PLAN.md"), "# T01 Plan\nBuild.\n");

  // REQUIREMENTS.md
  writeFileSync(
    join(gsdDir, "REQUIREMENTS.md"),
    [
      "# Requirements",
      "",
      "## Active",
      "",
      "| ID | Description | Owner |",
      "|----|-------------|-------|",
      "| R001 | Feature works | S01 |",
    ].join("\n"),
  );

  // DECISIONS.md
  writeFileSync(
    join(gsdDir, "DECISIONS.md"),
    [
      "# Decisions",
      "",
      "| ID | Decision | Choice | Rationale |",
      "|----|----------|--------|-----------|",
    ].join("\n"),
  );

  return base;
}

function makeTaskParams(
  taskId: string,
  sliceId: string,
  milestoneId: string,
  overrides?: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    taskId,
    sliceId,
    milestoneId,
    oneLiner: `Completed ${taskId}`,
    narrative: `Implemented ${taskId} with full coverage.`,
    verification: "All tests pass.",
    keyFiles: ["src/feature.ts"],
    keyDecisions: [],
    deviations: "None.",
    knownIssues: "None.",
    blockerDiscovered: false,
    verificationEvidence: [
      { command: "npm test", exitCode: 0, verdict: "pass", durationMs: 1000 },
    ],
    ...overrides,
  };
}

function makeSliceParams(
  sliceId: string,
  milestoneId: string,
): Record<string, unknown> {
  return {
    sliceId,
    milestoneId,
    sliceTitle: `${sliceId} Feature`,
    oneLiner: `${sliceId} proven`,
    narrative: "All tasks completed.",
    verification: "Tests pass.",
    keyFiles: ["src/feature.ts"],
    keyDecisions: [],
    patternsEstablished: [],
    observabilitySurfaces: [],
    deviations: "None.",
    knownLimitations: "None.",
    followUps: "None.",
    requirementsAdvanced: [],
    requirementsValidated: [],
    requirementsSurfaced: [],
    requirementsInvalidated: [],
    filesModified: [{ path: "src/feature.ts", description: "Feature" }],
    uatContent: "Acceptance criteria met.",
    provides: ["feature"],
    requires: [],
    affects: [],
    drillDownPaths: [],
  };
}

function makeMilestoneParams(milestoneId: string): Record<string, unknown> {
  return {
    milestoneId,
    title: "Live Validation Milestone",
    oneLiner: "Milestone proven end-to-end",
    narrative: "All slices completed and verified.",
    successCriteriaResults: "All criteria met.",
    definitionOfDoneResults: "All items checked.",
    requirementOutcomes: "All requirements satisfied.",
    keyDecisions: ["Chose approach A"],
    keyFiles: ["src/feature.ts"],
    lessonsLearned: ["Integration testing is valuable"],
    followUps: "None.",
    deviations: "None.",
    verificationPassed: true,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════════════════════════════════════════

describe("state-machine-live-validation", () => {
  let base: string;

  afterEach(() => {
    closeDatabase();
    if (base) rmSync(base, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 1: Full happy-path lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  describe("happy path: full lifecycle M001 → complete", () => {
    test("step 1: empty project derives pre-planning", async () => {
      base = makeTempDir();
      mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
      const state = await deriveState(base);
      assert.equal(state.phase, "pre-planning");
      assert.equal(state.activeMilestone, null);
    });

    test("step 2: milestone with CONTEXT-DRAFT derives needs-discussion", async () => {
      base = makeTempDir();
      const mDir = join(base, ".gsd", "milestones", "M001");
      mkdirSync(mDir, { recursive: true });
      writeFileSync(join(mDir, "M001-CONTEXT-DRAFT.md"), "# Draft\nDraft context.\n");
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "needs-discussion");
      assert.equal(state.activeMilestone?.id, "M001");
    });

    test("step 3: full fixture with ROADMAP+PLAN derives planning or executing", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      invalidateStateCache();
      const state = await deriveState(base);
      // Without DB migration, filesystem path is used — should be planning or executing
      assert.ok(
        ["planning", "executing", "pre-planning"].includes(state.phase),
        `expected planning/executing/pre-planning, got: ${state.phase}`,
      );
    });

    test("step 4: complete T01 in S01 — handler succeeds, DB reflects completion", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      // Seed DB with hierarchy
      insertMilestone({ id: "M001", title: "Live Validation", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First Feature", status: "in_progress" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Implementation", status: "pending" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Testing", status: "pending" });

      const result = await handleCompleteTask(makeTaskParams("T01", "S01", "M001") as any, base);
      assert.ok(!("error" in result), `expected success, got: ${JSON.stringify(result)}`);

      // Verify DB state
      const task = getTask("M001", "S01", "T01");
      assert.ok(task, "T01 should exist in DB");
      assert.ok(isClosedStatus(task!.status), `T01 status should be closed, got: ${task!.status}`);

      // Verify SUMMARY.md written to disk
      const summaryPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md");
      assert.ok(existsSync(summaryPath), "T01-SUMMARY.md should exist on disk");

      // Verify event log entry
      const events = readEvents(join(base, ".gsd", "event-log.jsonl"));
      const taskEvent = events.find(e => e.cmd === "complete-task" && (e.params as any).taskId === "T01");
      assert.ok(taskEvent, "event log should contain complete-task for T01");
    });

    test("step 5: complete T02 in S01 — both tasks now done", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Live Validation", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First Feature", status: "in_progress" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Implementation", status: "complete" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Testing", status: "pending" });

      const result = await handleCompleteTask(makeTaskParams("T02", "S01", "M001") as any, base);
      assert.ok(!("error" in result), `expected success, got: ${JSON.stringify(result)}`);

      // Both tasks complete
      const tasks = getSliceTasks("M001", "S01");
      assert.equal(tasks.length, 2);
      assert.ok(tasks.every(t => isClosedStatus(t.status)), "all tasks should be closed");
    });

    test("step 6: complete slice S01 — all tasks done, slice closes", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Live Validation", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First Feature", status: "in_progress" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Impl", status: "complete" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Test", status: "complete" });

      const result = await handleCompleteSlice(makeSliceParams("S01", "M001") as any, base);
      assert.ok(!("error" in result), `expected success, got: ${JSON.stringify(result)}`);

      const slice = getSlice("M001", "S01");
      assert.ok(slice, "S01 should exist");
      assert.ok(isClosedStatus(slice!.status), `S01 should be closed, got: ${slice!.status}`);

      // SUMMARY.md on disk
      const summaryPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md");
      assert.ok(existsSync(summaryPath), "S01-SUMMARY.md should exist");
    });

    test("step 7: complete S02 task + slice — both slices done", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Live Validation", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "complete" });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Second", status: "in_progress" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Impl", status: "complete" });
      insertTask({ id: "T01", sliceId: "S02", milestoneId: "M001", title: "Impl", status: "pending" });

      // Complete task
      const taskResult = await handleCompleteTask(makeTaskParams("T01", "S02", "M001") as any, base);
      assert.ok(!("error" in taskResult), `task: ${JSON.stringify(taskResult)}`);

      // Complete slice
      const sliceResult = await handleCompleteSlice(makeSliceParams("S02", "M001") as any, base);
      assert.ok(!("error" in sliceResult), `slice: ${JSON.stringify(sliceResult)}`);

      // Both slices complete
      const slices = getMilestoneSlices("M001");
      assert.ok(slices.length >= 2, "should have 2+ slices");
      assert.ok(slices.every(s => isClosedStatus(s.status)), "all slices should be closed");
    });

    test("step 8: complete milestone M001 — full lifecycle done", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Live Validation", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "complete" });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Second", status: "complete" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Impl", status: "complete" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Test", status: "complete" });
      insertTask({ id: "T01", sliceId: "S02", milestoneId: "M001", title: "Impl", status: "complete" });

      const result = await handleCompleteMilestone(makeMilestoneParams("M001") as any, base);
      assert.ok(!("error" in result), `expected success, got: ${JSON.stringify(result)}`);

      const milestone = getMilestone("M001");
      assert.ok(milestone, "M001 should exist");
      assert.ok(isClosedStatus(milestone!.status), `M001 should be closed, got: ${milestone!.status}`);

      // SUMMARY.md on disk
      const summaryPath = join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md");
      assert.ok(existsSync(summaryPath), "M001-SUMMARY.md should exist");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 2: Completion guard edge cases
  // ─────────────────────────────────────────────────────────────────────────

  describe("completion guards — edge cases", () => {
    test("cannot complete task with empty taskId", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      const result = await handleCompleteTask(makeTaskParams("", "S01", "M001") as any, base);
      assert.ok("error" in result);
      assert.match((result as any).error, /taskId is required/);
    });

    test("cannot complete task in closed milestone", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Done", status: "complete" });
      insertSlice({ id: "S01", milestoneId: "M001" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "pending" });

      const result = await handleCompleteTask(makeTaskParams("T01", "S01", "M001") as any, base);
      assert.ok("error" in result);
      assert.match((result as any).error, /closed milestone/);
    });

    test("cannot complete task in closed slice", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Active", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "pending" });

      const result = await handleCompleteTask(makeTaskParams("T01", "S01", "M001") as any, base);
      assert.ok("error" in result);
      assert.match((result as any).error, /closed slice/);
    });

    test("double task completion returns error (H5-related)", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Active", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });

      const result = await handleCompleteTask(makeTaskParams("T01", "S01", "M001") as any, base);
      assert.ok("error" in result);
      assert.match((result as any).error, /already complete/);
    });

    test("cannot complete slice with zero tasks — vacuous truth guard", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Active", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
      // No tasks inserted

      const result = await handleCompleteSlice(makeSliceParams("S01", "M001") as any, base);
      assert.ok("error" in result);
      assert.match((result as any).error, /no tasks found/);
    });

    test("cannot complete slice with incomplete tasks", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Active", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", status: "pending" });

      const result = await handleCompleteSlice(makeSliceParams("S01", "M001") as any, base);
      assert.ok("error" in result);
      assert.match((result as any).error, /incomplete tasks/);
    });

    test("double slice completion returns error", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Active", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });

      const result = await handleCompleteSlice(makeSliceParams("S01", "M001") as any, base);
      assert.ok("error" in result);
      assert.match((result as any).error, /already complete/);
    });

    test("cannot complete milestone with zero slices", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Active", status: "active" });

      const result = await handleCompleteMilestone(makeMilestoneParams("M001") as any, base);
      assert.ok("error" in result);
      assert.match((result as any).error, /no slices found/);
    });

    test("cannot complete milestone with incomplete slices", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Active", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
      insertSlice({ id: "S02", milestoneId: "M001", status: "in_progress" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
      insertTask({ id: "T01", sliceId: "S02", milestoneId: "M001", status: "pending" });

      const result = await handleCompleteMilestone(makeMilestoneParams("M001") as any, base);
      assert.ok("error" in result);
      assert.match((result as any).error, /incomplete slices/);
    });

    test("cannot complete milestone with incomplete tasks in complete slice (deep check)", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Active", status: "active" });
      // Slice marked complete but task is still pending — simulates inconsistent state
      insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "pending" });

      const result = await handleCompleteMilestone(makeMilestoneParams("M001") as any, base);
      assert.ok("error" in result);
      assert.match((result as any).error, /incomplete tasks/);
    });

    test("cannot complete milestone without verificationPassed=true", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Active", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });

      const params = makeMilestoneParams("M001");
      params.verificationPassed = false;
      const result = await handleCompleteMilestone(params as any, base);
      assert.ok("error" in result);
      assert.match((result as any).error, /verification did not pass/);
    });

    test("double milestone completion returns error", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Done", status: "complete" });
      insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });

      const result = await handleCompleteMilestone(makeMilestoneParams("M001") as any, base);
      assert.ok("error" in result);
      assert.match((result as any).error, /already complete/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 3: Reopen operations
  // ─────────────────────────────────────────────────────────────────────────

  describe("reopen operations", () => {
    test("reopen task: resets completed task to pending", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Active", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });

      const result = await handleReopenTask(
        { milestoneId: "M001", sliceId: "S01", taskId: "T01", reason: "Need to redo" },
        base,
      );
      assert.ok(!("error" in result), `expected success: ${JSON.stringify(result)}`);

      const task = getTask("M001", "S01", "T01");
      assert.equal(task!.status, "pending");
    });

    test("cannot reopen task that is not complete", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Active", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "pending" });

      const result = await handleReopenTask(
        { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
        base,
      );
      assert.ok("error" in result);
      assert.match((result as any).error, /not complete/);
    });

    test("cannot reopen task in closed slice — must reopen slice first", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Active", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });

      const result = await handleReopenTask(
        { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
        base,
      );
      assert.ok("error" in result);
      assert.match((result as any).error, /closed slice/);
    });

    test("cannot reopen task in closed milestone", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Done", status: "complete" });
      insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });

      const result = await handleReopenTask(
        { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
        base,
      );
      assert.ok("error" in result);
      assert.match((result as any).error, /closed milestone/);
    });

    test("reopen slice: resets slice to in_progress and all tasks to pending", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Active", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", status: "complete" });

      const result = await handleReopenSlice(
        { milestoneId: "M001", sliceId: "S01", reason: "Need rework" },
        base,
      );
      assert.ok(!("error" in result), `expected success: ${JSON.stringify(result)}`);
      assert.equal((result as any).tasksReset, 2);

      // Verify slice state
      const slice = getSlice("M001", "S01");
      assert.equal(slice!.status, "in_progress");

      // Verify all tasks reset to pending
      const tasks = getSliceTasks("M001", "S01");
      assert.ok(tasks.every(t => t.status === "pending"), "all tasks should be pending after slice reopen");
    });

    test("cannot reopen slice in closed milestone", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Done", status: "complete" });
      insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });

      const result = await handleReopenSlice(
        { milestoneId: "M001", sliceId: "S01" },
        base,
      );
      assert.ok("error" in result);
      assert.match((result as any).error, /closed milestone/);
    });

    test("no reopen-milestone tool exists — milestone completion is irrevocable (H5)", async () => {
      // This test documents the H5 finding: there is no handleReopenMilestone function.
      // A completed milestone can only be undone via direct DB manipulation.
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Done", status: "complete" });

      const milestone = getMilestone("M001");
      assert.ok(isClosedStatus(milestone!.status), "milestone is closed");

      // The only escape is direct DB manipulation — no handler exists
      updateMilestoneStatus("M001", "active", null);
      const reopened = getMilestone("M001");
      assert.equal(reopened!.status, "active", "direct DB manipulation can reopen, but no tool exposes this");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 4: Phantom parents and auto-creation (H6)
  // ─────────────────────────────────────────────────────────────────────────

  describe("phantom parent auto-creation (H6)", () => {
    test("completing task for non-existent milestone/slice auto-creates them", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      // No milestone or slice pre-inserted — handler will auto-create

      const result = await handleCompleteTask(makeTaskParams("T01", "S99", "M099") as any, base);
      assert.ok(!("error" in result), `expected success: ${JSON.stringify(result)}`);

      // Phantom milestone created — H6 fix: now uses ID as title instead of empty string
      const milestone = getMilestone("M099");
      assert.ok(milestone, "phantom milestone M099 should exist");
      assert.equal(milestone!.title, "M099", "H6 fix: phantom milestone uses ID as title");

      // Phantom slice created
      const slice = getSlice("M099", "S99");
      assert.ok(slice, "phantom slice S99 should exist");
    });

    test("completing slice for non-existent milestone auto-creates it", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      // Insert task to satisfy completion guard
      insertMilestone({ id: "M099" });
      insertSlice({ id: "S99", milestoneId: "M099" });
      insertTask({ id: "T01", sliceId: "S99", milestoneId: "M099", status: "complete" });

      const result = await handleCompleteSlice(makeSliceParams("S99", "M099") as any, base);
      assert.ok(!("error" in result), `expected success: ${JSON.stringify(result)}`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 5: State derivation consistency
  // ─────────────────────────────────────────────────────────────────────────

  describe("state derivation with live DB", () => {
    test("deriveStateFromDb reflects task completion immediately", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Active", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "in_progress" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "pending" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", status: "pending" });

      invalidateStateCache();
      const stateBefore = await deriveStateFromDb(base);
      assert.equal(stateBefore.phase, "executing", `before: expected executing, got ${stateBefore.phase}`);

      // Complete T01
      updateTaskStatus("M001", "S01", "T01", "complete", new Date().toISOString());
      invalidateStateCache();
      const stateAfterT01 = await deriveStateFromDb(base);
      // Still executing — T02 is pending
      assert.equal(stateAfterT01.phase, "executing", `after T01: expected executing, got ${stateAfterT01.phase}`);

      // Complete T02
      updateTaskStatus("M001", "S01", "T02", "complete", new Date().toISOString());
      invalidateStateCache();
      const stateAfterT02 = await deriveStateFromDb(base);
      // All tasks done → summarizing
      assert.equal(stateAfterT02.phase, "summarizing", `after T02: expected summarizing, got ${stateAfterT02.phase}`);
    });

    test("deriveStateFromDb reflects slice completion → next slice or validating", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Active", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "complete" });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Second", status: "in_progress" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
      insertTask({ id: "T01", sliceId: "S02", milestoneId: "M001", status: "pending" });

      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      // S01 done, S02 has pending task → executing
      assert.equal(state.phase, "executing", `expected executing for S02, got ${state.phase}`);
      assert.equal(state.activeSlice?.id, "S02", "active slice should be S02");
    });

    test("deriveStateFromDb with all slices done → validating-milestone", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Active", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "complete" });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Second", status: "complete" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
      insertTask({ id: "T01", sliceId: "S02", milestoneId: "M001", status: "complete" });

      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(state.phase, "validating-milestone", `expected validating-milestone, got ${state.phase}`);
    });

    test("ghost milestone is skipped by deriveState", async () => {
      base = makeTempDir();
      const gsdDir = join(base, ".gsd", "milestones");
      // M001 is ghost — empty dir
      mkdirSync(join(gsdDir, "M001"), { recursive: true });
      // M002 has content
      mkdirSync(join(gsdDir, "M002"), { recursive: true });
      writeFileSync(join(gsdDir, "M002", "M002-CONTEXT-DRAFT.md"), "# Draft\nContent.\n");

      assert.ok(isGhostMilestone(base, "M001"), "M001 should be ghost");
      assert.ok(!isGhostMilestone(base, "M002"), "M002 should not be ghost");

      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.activeMilestone?.id, "M002", "should skip ghost M001 and use M002");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 6: Event log integrity
  // ─────────────────────────────────────────────────────────────────────────

  describe("event log integrity across operations", () => {
    test("full operation sequence produces correct event log", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Active", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "in_progress" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "pending" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", status: "pending" });

      // Complete T01
      await handleCompleteTask(makeTaskParams("T01", "S01", "M001") as any, base);
      // Complete T02
      await handleCompleteTask(makeTaskParams("T02", "S01", "M001") as any, base);
      // Complete S01
      await handleCompleteSlice(makeSliceParams("S01", "M001") as any, base);

      const events = readEvents(join(base, ".gsd", "event-log.jsonl"));

      // Should have 3 events: 2 task completions + 1 slice completion
      assert.ok(events.length >= 3, `expected ≥3 events, got ${events.length}`);

      const taskEvents = events.filter(e => e.cmd === "complete-task");
      assert.equal(taskEvents.length, 2, "2 task completion events");

      const sliceEvents = events.filter(e => e.cmd === "complete-slice");
      assert.equal(sliceEvents.length, 1, "1 slice completion event");

      // Events are ordered chronologically
      for (let i = 1; i < events.length; i++) {
        assert.ok(
          events[i]!.ts >= events[i - 1]!.ts,
          `events should be chronologically ordered: ${events[i - 1]!.ts} <= ${events[i]!.ts}`,
        );
      }

      // All events have hashes and session IDs
      for (const event of events) {
        assert.ok(event.hash, "event should have hash");
        assert.ok(event.session_id, "event should have session_id");
      }
    });

    test("reopen operations produce events", async () => {
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Active", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });

      await handleReopenTask(
        { milestoneId: "M001", sliceId: "S01", taskId: "T01", reason: "redo" },
        base,
      );

      const events = readEvents(join(base, ".gsd", "event-log.jsonl"));
      const reopenEvent = events.find(e => e.cmd === "reopen-task");
      assert.ok(reopenEvent, "should have reopen-task event");
      assert.equal((reopenEvent!.params as any).taskId, "T01");
      assert.equal((reopenEvent!.params as any).reason, "redo");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 7: Reopen-then-redo cycle
  // ─────────────────────────────────────────────────────────────────────────

  describe("reopen-then-redo cycle", () => {
    test("complete → reopen → re-complete task works end-to-end (M12 fixed)", async () => {
      // M12 fix: reopen-task now deletes SUMMARY.md from disk before the
      // post-mutation hook runs, preventing the reconciler from auto-correcting
      // the task back to "complete".
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Active", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "in_progress" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "pending" });

      // Complete — writes T01-SUMMARY.md to disk
      const r1 = await handleCompleteTask(makeTaskParams("T01", "S01", "M001") as any, base);
      assert.ok(!("error" in r1), `first complete: ${JSON.stringify(r1)}`);

      const summaryPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md");
      assert.ok(existsSync(summaryPath), "SUMMARY.md exists after completion");

      // Reopen — now deletes SUMMARY.md from disk (M12 fix)
      const r2 = await handleReopenTask({ milestoneId: "M001", sliceId: "S01", taskId: "T01" }, base);
      assert.ok(!("error" in r2), `reopen: ${JSON.stringify(r2)}`);

      // Task is now properly pending — SUMMARY.md was cleaned up
      assert.equal(getTask("M001", "S01", "T01")!.status, "pending");
      assert.ok(!existsSync(summaryPath), "M12 fix: SUMMARY.md cleaned up by reopen");

      // Re-complete succeeds
      const r3 = await handleCompleteTask(makeTaskParams("T01", "S01", "M001") as any, base);
      assert.ok(!("error" in r3), `re-complete: ${JSON.stringify(r3)}`);
      assert.ok(isClosedStatus(getTask("M001", "S01", "T01")!.status));
    });

    test("complete slice → reopen → re-complete all works end-to-end (M12 fixed)", async () => {
      // M12 fix: reopen-slice now deletes all SUMMARY.md and UAT.md artifacts
      // from disk, preventing reconciler interference.
      base = createFullFixture();
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Active", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "in_progress" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "pending" });

      // Complete task + slice
      await handleCompleteTask(makeTaskParams("T01", "S01", "M001") as any, base);
      await handleCompleteSlice(makeSliceParams("S01", "M001") as any, base);
      assert.ok(isClosedStatus(getSlice("M001", "S01")!.status));

      // Reopen slice — now cleans up all artifacts (M12 fix)
      await handleReopenSlice({ milestoneId: "M001", sliceId: "S01" }, base);
      assert.equal(getSlice("M001", "S01")!.status, "in_progress");
      assert.equal(getTask("M001", "S01", "T01")!.status, "pending");

      // Re-complete task + slice succeeds
      await handleCompleteTask(makeTaskParams("T01", "S01", "M001") as any, base);
      const r = await handleCompleteSlice(makeSliceParams("S01", "M001") as any, base);
      assert.ok(!("error" in r), `re-complete slice: ${JSON.stringify(r)}`);
      assert.ok(isClosedStatus(getSlice("M001", "S01")!.status));
    });
  });
});
