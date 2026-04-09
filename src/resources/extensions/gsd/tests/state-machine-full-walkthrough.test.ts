// GSD State Machine — Comprehensive Phase-by-Phase Walkthrough Tests
// Verifies all 16 phases, reconciliation, edge cases, and cross-validation.

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  deriveState,
  deriveStateFromDb,
  isValidationTerminal,
  isGhostMilestone,
  invalidateStateCache,
} from "../state.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  updateTaskStatus,
  getAllMilestones,
  insertGateRow,
  getPendingSliceGateCount,
} from "../gsd-db.ts";
import { isClosedStatus } from "../status-guards.ts";
import { clearPathCache } from "../paths.ts";

// ─── Fixture Helpers ─────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-walkthrough-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  tempDirs.push(base);
  return base;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
  try { closeDatabase(); } catch { /* may not be open */ }
});

function writeContext(base: string, mid: string, content: string): void {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-CONTEXT.md`), content);
}

function writeContextDraft(base: string, mid: string, content: string): void {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-CONTEXT-DRAFT.md`), content);
}

function writeRoadmap(base: string, mid: string, content: string): void {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-ROADMAP.md`), content);
}

function writePlan(base: string, mid: string, sid: string, content: string): void {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid);
  const tasksDir = join(dir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(dir, `${sid}-PLAN.md`), content);
  // Create stub task plan files so deriveState doesn't fall back to planning
  const taskMatches = content.matchAll(/\*\*(T\d+):/g);
  for (const m of taskMatches) {
    const tid = m[1];
    writeFileSync(join(tasksDir, `${tid}-PLAN.md`), `# ${tid} Plan\n\nStub.\n`);
  }
}

function writeTaskSummary(base: string, mid: string, sid: string, tid: string): void {
  const tasksDir = join(base, ".gsd", "milestones", mid, "slices", sid, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, `${tid}-SUMMARY.md`), [
    `# ${tid} Summary`,
    "",
    "Task completed successfully.",
  ].join("\n"));
}

function writeTaskSummaryWithBlocker(base: string, mid: string, sid: string, tid: string): void {
  const tasksDir = join(base, ".gsd", "milestones", mid, "slices", sid, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, `${tid}-SUMMARY.md`), [
    "---",
    "blocker_discovered: true",
    "---",
    "",
    `# ${tid} Summary`,
    "",
    "Blocker found during execution.",
  ].join("\n"));
}

function writeSliceSummary(base: string, mid: string, sid: string): void {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-SUMMARY.md`), `# ${sid} Summary\n\nSlice done.\n`);
}

function writeMilestoneSummary(base: string, mid: string): void {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-SUMMARY.md`), `# ${mid} Summary\n\nMilestone complete.\n`);
}

function writeMilestoneValidation(base: string, mid: string, verdict: string = "pass"): void {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-VALIDATION.md`), [
    "---",
    `verdict: ${verdict}`,
    "remediation_round: 0",
    "---",
    "",
    "# Validation",
    "Validated.",
  ].join("\n"));
}

function writeReplanTrigger(base: string, mid: string, sid: string): void {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-REPLAN-TRIGGER.md`), "Triage replan triggered.\n");
}

function writeReplan(base: string, mid: string, sid: string): void {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-REPLAN.md`), "# Replan\n\nReplan completed.\n");
}

function writeContinue(base: string, mid: string, sid: string): void {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-CONTINUE.md`), [
    "---",
    "milestone: " + mid,
    "slice: " + sid,
    "task: T01",
    "status: interrupted",
    "---",
    "",
    "# Continue",
    "Resume from step 2.",
  ].join("\n"));
}

/** Standard roadmap with one incomplete slice */
function standardRoadmap(): string {
  return [
    "# M001: Test Milestone",
    "",
    "**Vision:** Test state machine.",
    "",
    "## Slices",
    "",
    "- [ ] **S01: First Slice** `risk:low` `depends:[]`",
    "  > After this: slice done.",
  ].join("\n");
}

/** Roadmap with one done slice */
function doneSliceRoadmap(): string {
  return [
    "# M001: Test Milestone",
    "",
    "**Vision:** Test state machine.",
    "",
    "## Slices",
    "",
    "- [x] **S01: Done Slice** `risk:low` `depends:[]`",
    "  > After this: slice done.",
  ].join("\n");
}

/** Standard plan with two incomplete tasks */
function standardPlan(): string {
  return [
    "# S01: First Slice",
    "",
    "**Goal:** Test.",
    "**Demo:** Tests pass.",
    "",
    "## Tasks",
    "",
    "- [ ] **T01: First Task** `est:10m`",
    "  First task description.",
    "",
    "- [ ] **T02: Second Task** `est:10m`",
    "  Second task description.",
  ].join("\n");
}

/** Plan with all tasks done */
function allDonePlan(): string {
  return [
    "# S01: First Slice",
    "",
    "**Goal:** Test.",
    "**Demo:** Tests pass.",
    "",
    "## Tasks",
    "",
    "- [x] **T01: First Task** `est:10m`",
    "  First task done.",
    "",
    "- [x] **T02: Second Task** `est:10m`",
    "  Second task done.",
  ].join("\n");
}

/** Plan with one done, one incomplete task */
function partialDonePlan(): string {
  return [
    "# S01: First Slice",
    "",
    "**Goal:** Test.",
    "**Demo:** Tests pass.",
    "",
    "## Tasks",
    "",
    "- [x] **T01: First Task** `est:10m`",
    "  First task done.",
    "",
    "- [ ] **T02: Second Task** `est:10m`",
    "  Second task pending.",
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1: pre-planning
// ═══════════════════════════════════════════════════════════════════════════════

describe("state-machine-full-walkthrough", () => {

  describe("Phase 1: pre-planning", () => {
    test("empty milestones dir → pre-planning", async () => {
      const base = createFixtureBase();
      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "pre-planning");
      assert.equal(state.activeMilestone, null);
      assert.equal(state.activeSlice, null);
      assert.equal(state.activeTask, null);
      assert.deepStrictEqual(state.registry, []);
    });

    test("milestone with CONTEXT but no ROADMAP → pre-planning", async () => {
      const base = createFixtureBase();
      writeContext(base, "M001", "# M001: Test\n\nSome context.");
      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "pre-planning");
      assert.ok(state.activeMilestone !== null, "activeMilestone should be set");
      assert.equal(state.activeMilestone?.id, "M001");
    });

    test("roadmap with zero slices → pre-planning (not validating-milestone)", async () => {
      const base = createFixtureBase();
      writeContext(base, "M001", "# M001: Test\n\nContext.");
      // Roadmap exists but has no slice entries
      writeRoadmap(base, "M001", [
        "# M001: Test Milestone",
        "",
        "**Vision:** Test.",
        "",
        "## Slices",
        "",
        "No slices defined yet.",
      ].join("\n"));
      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "pre-planning", "zero slices must NOT trigger validating-milestone (#2667)");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 2: needs-discussion
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 2: needs-discussion", () => {
    test("CONTEXT-DRAFT exists, no CONTEXT → needs-discussion", async () => {
      const base = createFixtureBase();
      writeContextDraft(base, "M001", "# M001: Draft\n\nDraft context.");
      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "needs-discussion");
      assert.ok(state.activeMilestone !== null);
      assert.equal(state.activeMilestone?.id, "M001");
    });

    test("both CONTEXT-DRAFT and CONTEXT exist → NOT needs-discussion", async () => {
      const base = createFixtureBase();
      writeContext(base, "M001", "# M001: Real\n\nReal context.");
      writeContextDraft(base, "M001", "# M001: Draft\n\nDraft context.");
      invalidateStateCache();
      const state = await deriveState(base);

      assert.notEqual(state.phase, "needs-discussion", "CONTEXT should win over CONTEXT-DRAFT");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 3: discussing (auto-mode only)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 3: discussing (auto-mode only)", () => {
    test("discussing is NOT reachable from deriveState", async () => {
      // discussing is set only by auto-mode, never by state derivation.
      // Verify that CONTEXT-DRAFT → needs-discussion (not discussing).
      const base = createFixtureBase();
      writeContextDraft(base, "M001", "# M001: Draft\n\nDraft.");
      invalidateStateCache();
      const state = await deriveState(base);
      assert.notEqual(state.phase, "discussing");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 4: researching (auto-mode only)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 4: researching (auto-mode only)", () => {
    test("researching is NOT reachable from deriveState", async () => {
      const base = createFixtureBase();
      writeContext(base, "M001", "# M001: Test\n\nContext.");
      writeRoadmap(base, "M001", standardRoadmap());
      invalidateStateCache();
      const state = await deriveState(base);
      assert.notEqual(state.phase, "researching");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 5: planning
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 5: planning", () => {
    test("roadmap with slice, no PLAN file → planning", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "planning");
      assert.ok(state.activeSlice !== null);
      assert.equal(state.activeSlice?.id, "S01");
    });

    test("PLAN exists but zero tasks → planning", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      // Plan file with no task entries
      const dir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "S01-PLAN.md"), [
        "# S01: First Slice",
        "",
        "**Goal:** Test.",
        "**Demo:** Tests pass.",
        "",
        "## Tasks",
        "",
        "No tasks defined yet.",
      ].join("\n"));
      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "planning", "plan with zero tasks should remain in planning");
    });

    test("PLAN with tasks but missing T##-PLAN.md files → planning", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      // Write plan file WITH tasks but WITHOUT stub T##-PLAN.md files
      const dir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
      mkdirSync(join(dir, "tasks"), { recursive: true });
      writeFileSync(join(dir, "S01-PLAN.md"), standardPlan());
      // Intentionally do NOT create T01-PLAN.md or T02-PLAN.md
      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "planning", "missing task plan files should stay in planning");
    });

    test("PLAN with all task plan files → NOT planning", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      invalidateStateCache();
      const state = await deriveState(base);

      assert.notEqual(state.phase, "planning", "complete plan should advance past planning");
      // Should be executing since there are incomplete tasks
      assert.equal(state.phase, "executing");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 6: evaluating-gates (DB path only)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 6: evaluating-gates", () => {
    test("DB path: pending quality gates → evaluating-gates", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);

      // Set up milestone + slice + task in DB
      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Slice", status: "active", depends: [] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "T01: Task", status: "pending" });

      // Write plan on disk (needed for state derivation)
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());

      // Insert a pending quality gate
      insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice", status: "pending" });

      const pending = getPendingSliceGateCount("M001", "S01");
      assert.ok(pending > 0, "should have pending gates");

      invalidateStateCache();
      const state = await deriveStateFromDb(base);

      assert.equal(state.phase, "evaluating-gates");
    });

    test("DB path: no pending gates → NOT evaluating-gates", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);

      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Slice", status: "active", depends: [] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "T01: Task", status: "pending" });

      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());

      // No gate rows → getPendingSliceGateCount returns 0
      const pending = getPendingSliceGateCount("M001", "S01");
      assert.equal(pending, 0, "should have no pending gates");

      invalidateStateCache();
      const state = await deriveStateFromDb(base);

      assert.notEqual(state.phase, "evaluating-gates");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 7: executing
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 7: executing", () => {
    test("active task, no blockers → executing", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "executing");
      assert.ok(state.activeTask !== null);
      assert.equal(state.activeTask?.id, "T01");
    });

    test("active task with CONTINUE.md → executing with resume message", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      writeContinue(base, "M001", "S01");
      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "executing");
      assert.ok(
        state.nextAction.toLowerCase().includes("resume") || state.nextAction.toLowerCase().includes("continue"),
        "nextAction should mention resume/continue",
      );
    });

    test("one task remaining among completed → executing (not summarizing)", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", partialDonePlan());
      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "executing", "should be executing while tasks remain");
      assert.equal(state.activeTask?.id, "T02", "active task should be T02");
      assert.equal(state.progress?.tasks?.done, 1);
      assert.equal(state.progress?.tasks?.total, 2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 8: verifying (auto-mode only)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 8: verifying (auto-mode only)", () => {
    test("verifying is NOT reachable from deriveState", async () => {
      // verifying is set only by auto-mode verification gates.
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", allDonePlan());
      invalidateStateCache();
      const state = await deriveState(base);
      assert.notEqual(state.phase, "verifying");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 9: summarizing
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 9: summarizing", () => {
    test("all tasks done, slice not complete → summarizing", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", allDonePlan());
      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "summarizing");
      assert.ok(state.activeSlice !== null);
      assert.equal(state.activeSlice?.id, "S01");
      assert.equal(state.activeTask, null, "no active task when all done");
      assert.equal(state.progress?.tasks?.done, 2);
      assert.equal(state.progress?.tasks?.total, 2);
    });

    test("tasks reconciled via SUMMARY on disk → summarizing", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      // Plan says tasks incomplete (headings, no checkboxes) ...
      const planContent = [
        "# S01: First Slice",
        "",
        "**Goal:** Test.",
        "**Demo:** Tests pass.",
        "",
        "## Tasks",
        "",
        "### T01: First Task",
        "First task.",
        "",
        "### T02: Second Task",
        "Second task.",
      ].join("\n");
      const dir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
      const tasksDir = join(dir, "tasks");
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(join(dir, "S01-PLAN.md"), planContent);
      writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan\nStub.\n");
      writeFileSync(join(tasksDir, "T02-PLAN.md"), "# T02 Plan\nStub.\n");

      // ... but SUMMARY files exist on disk (reconciliation trigger)
      writeTaskSummary(base, "M001", "S01", "T01");
      writeTaskSummary(base, "M001", "S01", "T02");

      invalidateStateCache();
      const state = await deriveState(base);

      // Reconciliation should mark both tasks done → summarizing
      assert.equal(state.phase, "summarizing", "SUMMARY reconciliation should advance to summarizing");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 10: advancing (auto-mode only)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 10: advancing (auto-mode only)", () => {
    test("advancing is NOT reachable from deriveState", async () => {
      // advancing is an internal auto-mode transition marker
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      invalidateStateCache();
      const state = await deriveState(base);
      assert.notEqual(state.phase, "advancing");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 11: validating-milestone
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 11: validating-milestone", () => {
    test("all slices done, no VALIDATION file → validating-milestone", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "validating-milestone");
      assert.ok(state.activeMilestone !== null);
    });

    test("all slices done, VALIDATION with unparseable verdict → validating-milestone", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      // Write a validation file with no parseable verdict
      const dir = join(base, ".gsd", "milestones", "M001");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "M001-VALIDATION.md"), "Just some text with no frontmatter verdict.");
      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "validating-milestone", "unparseable verdict should stay in validating");
    });

    test("all slices done, terminal verdict → NOT validating-milestone", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      writeMilestoneValidation(base, "M001", "pass");
      invalidateStateCache();
      const state = await deriveState(base);

      assert.notEqual(state.phase, "validating-milestone");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 12: completing-milestone
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 12: completing-milestone", () => {
    test("all slices done, validation terminal, no SUMMARY → completing-milestone", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      writeMilestoneValidation(base, "M001", "pass");
      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "completing-milestone");
      assert.ok(state.activeMilestone !== null);
    });

    test("all slices done, validation terminal, SUMMARY exists → NOT completing-milestone", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      writeMilestoneValidation(base, "M001", "pass");
      writeMilestoneSummary(base, "M001");
      invalidateStateCache();
      const state = await deriveState(base);

      assert.notEqual(state.phase, "completing-milestone", "should be complete, not completing");
      assert.equal(state.phase, "complete");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 13: replanning-slice
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 13: replanning-slice", () => {
    test("filesystem: task with blocker_discovered, no REPLAN.md → replanning-slice", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      // T01 is done with blocker, T02 is pending
      writePlan(base, "M001", "S01", partialDonePlan());
      writeTaskSummaryWithBlocker(base, "M001", "S01", "T01");
      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "replanning-slice");
      assert.ok(state.blockers.length > 0, "should have blocker details");
    });

    test("filesystem: REPLAN-TRIGGER.md exists, no REPLAN.md → replanning-slice", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      writeReplanTrigger(base, "M001", "S01");
      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "replanning-slice");
    });

    test("filesystem: REPLAN-TRIGGER + REPLAN.md exists → NOT replanning-slice (loop guard)", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      writeReplanTrigger(base, "M001", "S01");
      writeReplan(base, "M001", "S01");
      invalidateStateCache();
      const state = await deriveState(base);

      assert.notEqual(state.phase, "replanning-slice", "REPLAN.md loop guard should prevent re-entering replanning");
      // Should fall through to executing
      assert.equal(state.phase, "executing");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 14: complete
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 14: complete", () => {
    test("single milestone with SUMMARY + VALIDATION → complete", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      writeMilestoneValidation(base, "M001", "pass");
      writeMilestoneSummary(base, "M001");
      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "complete");
      assert.equal(state.registry.length, 1);
      assert.equal(state.registry[0]?.status, "complete");
    });

    test("all milestones complete → complete", async () => {
      const base = createFixtureBase();
      // M001: complete
      writeRoadmap(base, "M001", doneSliceRoadmap());
      writeMilestoneValidation(base, "M001", "pass");
      writeMilestoneSummary(base, "M001");

      // M002: also complete
      writeRoadmap(base, "M002", [
        "# M002: Second Milestone",
        "",
        "**Vision:** Test.",
        "",
        "## Slices",
        "",
        "- [x] **S01: Done** `risk:low` `depends:[]`",
        "  > After this: done.",
      ].join("\n"));
      writeMilestoneValidation(base, "M002", "pass");
      writeMilestoneSummary(base, "M002");

      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "complete");
      assert.equal(state.registry.length, 2);
      assert.ok(state.registry.every(e => e.status === "complete"), "all registry entries should be complete");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 15: paused (auto-mode only)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 15: paused (auto-mode only)", () => {
    test("paused is NOT reachable from deriveState", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      invalidateStateCache();
      const state = await deriveState(base);
      assert.notEqual(state.phase, "paused");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 16: blocked
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 16: blocked", () => {
    test("milestone with unmet dependency → blocked", async () => {
      const base = createFixtureBase();
      // M001 depends on M000 which doesn't exist — uses YAML frontmatter
      writeContext(base, "M001", [
        "---",
        "depends_on:",
        "  - M000",
        "---",
        "",
        "# M001: Test",
        "",
        "Context.",
      ].join("\n"));
      writeRoadmap(base, "M001", [
        "# M001: Test Milestone",
        "",
        "**Vision:** Test blocked.",
        "",
        "## Slices",
        "",
        "- [ ] **S01: Slice** `risk:low` `depends:[]`",
        "  > After this: done.",
      ].join("\n"));
      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "blocked");
      assert.ok(state.blockers.length > 0, "should have blockers");
    });

    test("no eligible slice (all deps unmet) → blocked at slice level", async () => {
      const base = createFixtureBase();
      // S01 depends on S00 which doesn't exist
      writeRoadmap(base, "M001", [
        "# M001: Test Milestone",
        "",
        "**Vision:** Test blocked slices.",
        "",
        "## Slices",
        "",
        "- [ ] **S01: First** `risk:low` `depends:[S00]`",
        "  > After this: done.",
      ].join("\n"));
      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "blocked");
      assert.ok(
        state.blockers.some(b => b.includes("dependency") || b.includes("eligible")),
        "blockers should mention dependency or eligibility",
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // RECONCILIATION
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Reconciliation", () => {
    test("DB: task with SUMMARY on disk but DB says pending → reconciliation fixes status (#2514)", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);

      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Slice", status: "active", depends: [] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "T01: Task", status: "pending" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "T02: Task", status: "pending" });

      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());

      // Write SUMMARY files on disk for both tasks (simulating session disconnect)
      writeTaskSummary(base, "M001", "S01", "T01");
      writeTaskSummary(base, "M001", "S01", "T02");

      invalidateStateCache();
      const state = await deriveStateFromDb(base);

      // Reconciliation should detect SUMMARY→DB mismatch and update
      // All tasks done → summarizing (not executing)
      assert.equal(state.phase, "summarizing", "reconciliation should advance past pending tasks");
    });

    test("empty DB with disk milestones → disk-to-DB sync (#2631)", async () => {
      const base = createFixtureBase();
      writeContext(base, "M001", "# M001: Test\n\nContext.");

      // Open DB — milestones table starts empty
      openDatabase(":memory:");
      const before = getAllMilestones();
      assert.equal(before.length, 0, "DB should start empty");

      invalidateStateCache();
      const state = await deriveState(base);

      // After deriveState, DB should have the disk milestone
      const after = getAllMilestones();
      assert.ok(after.length > 0, "DB should have milestones after reconciliation");
      assert.equal(after[0]!.id, "M001");
      assert.ok(state.activeMilestone !== null);
    });

    test("ghost milestone (empty dir) → NOT in registry", async () => {
      const base = createFixtureBase();
      // Create empty milestone dir (ghost — no CONTEXT, ROADMAP, SUMMARY)
      mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
      // Create a real milestone too
      writeContext(base, "M002", "# M002: Real\n\nContext.");
      invalidateStateCache();
      const state = await deriveState(base);

      // M001 (ghost) should not appear in registry
      const m001 = state.registry.find(e => e.id === "M001");
      assert.equal(m001, undefined, "ghost milestone should not appear in registry");
      // M002 should be there
      const m002 = state.registry.find(e => e.id === "M002");
      assert.ok(m002 !== undefined, "real milestone should appear in registry");
    });

    test("ghost milestone detection helper", () => {
      const base = createFixtureBase();
      // Ghost: empty dir
      mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
      clearPathCache();
      assert.equal(isGhostMilestone(base, "M001"), true, "empty dir is ghost");

      // Not ghost: has CONTEXT
      writeContext(base, "M002", "# M002\n\nContext.");
      clearPathCache();
      assert.equal(isGhostMilestone(base, "M002"), false, "dir with CONTEXT is not ghost");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CROSS-VALIDATION
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Cross-validation: DB vs filesystem", () => {
    test("executing scenario produces same phase on both paths", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);

      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Slice", status: "active", depends: [] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "T01: First", status: "pending" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "T02: Second", status: "pending" });

      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());

      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      closeDatabase();

      invalidateStateCache();
      const fsState = await deriveState(base);

      assert.equal(dbState.phase, "executing", "DB path should produce executing");
      assert.equal(fsState.phase, "executing", "filesystem path should produce executing");
      assert.equal(dbState.activeTask?.id, fsState.activeTask?.id, "active task should match");
    });

    test("summarizing scenario produces same phase on both paths", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);

      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Slice", status: "active", depends: [] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "T01: First", status: "complete" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "T02: Second", status: "complete" });

      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", allDonePlan());

      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      closeDatabase();

      invalidateStateCache();
      const fsState = await deriveState(base);

      assert.equal(dbState.phase, "summarizing", "DB path should produce summarizing");
      assert.equal(fsState.phase, "summarizing", "filesystem path should produce summarizing");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // EDGE CASES
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Edge cases", () => {
    test("isValidationTerminal: terminal verdicts", () => {
      assert.equal(isValidationTerminal("---\nverdict: pass\n---\n"), true, "pass is terminal");
      assert.equal(isValidationTerminal("---\nverdict: fail\n---\n"), true, "fail is terminal");
      assert.equal(isValidationTerminal("---\nverdict: needs-remediation\n---\n"), true, "needs-remediation is terminal");
      assert.equal(isValidationTerminal("---\nverdict: needs-attention\n---\n"), true, "needs-attention is terminal");
    });

    test("isValidationTerminal: non-terminal content", () => {
      assert.equal(isValidationTerminal("No frontmatter at all"), false, "no frontmatter is not terminal");
      assert.equal(isValidationTerminal(""), false, "empty string is not terminal");
      assert.equal(isValidationTerminal("---\n---\n"), false, "empty frontmatter is not terminal");
    });

    test("isClosedStatus boundary", () => {
      assert.equal(isClosedStatus("complete"), true);
      assert.equal(isClosedStatus("done"), true);
      assert.equal(isClosedStatus("pending"), false);
      assert.equal(isClosedStatus("in-progress"), false);
      assert.equal(isClosedStatus("blocked"), false);
      assert.equal(isClosedStatus("active"), false);
      assert.equal(isClosedStatus(""), false);
    });

    test("multiple milestones: M001 complete, M002 active → M002 is activeMilestone", async () => {
      const base = createFixtureBase();
      // M001: complete
      writeRoadmap(base, "M001", doneSliceRoadmap());
      writeMilestoneValidation(base, "M001", "pass");
      writeMilestoneSummary(base, "M001");

      // M002: active, in planning phase
      writeContext(base, "M002", "# M002: Next Milestone\n\nContext for M002.");
      writeRoadmap(base, "M002", [
        "# M002: Next Milestone",
        "",
        "**Vision:** Next phase.",
        "",
        "## Slices",
        "",
        "- [ ] **S01: New Slice** `risk:low` `depends:[]`",
        "  > After this: done.",
      ].join("\n"));

      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.activeMilestone?.id, "M002", "active milestone should be M002");
      assert.notEqual(state.phase, "complete", "should not be complete while M002 is active");
      // M001 in registry as complete
      const m001 = state.registry.find(e => e.id === "M001");
      assert.ok(m001 !== undefined, "M001 should be in registry");
      assert.equal(m001?.status, "complete", "M001 should be complete");
      // M002 in registry as active
      const m002 = state.registry.find(e => e.id === "M002");
      assert.ok(m002 !== undefined, "M002 should be in registry");
      assert.equal(m002?.status, "active", "M002 should be active");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // FAILURE MODES: What happens when things go wrong
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Recovery: DB has slice but no task rows (partial migration)", () => {
    test("DB tasks empty but PLAN on disk has tasks → reconciles to executing", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);

      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Slice", status: "active", depends: [] });
      // NO insertTask() — simulates partial migration / failed write

      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());

      invalidateStateCache();
      const state = await deriveStateFromDb(base);

      // FIX (#3600): plan-file tasks are now reconciled into the DB,
      // so the phase correctly advances to executing instead of planning.
      assert.equal(state.phase, "executing",
        "reconciled plan-file tasks → executing (not stuck in planning)");
    });
  });

  describe("Failure: partial SUMMARY reconciliation", () => {
    test("only one task has SUMMARY, other still pending → executing next task", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);

      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Slice", status: "active", depends: [] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "T01: Task", status: "pending" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "T02: Task", status: "pending" });

      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      // Only T01 has SUMMARY, T02 does not
      writeTaskSummary(base, "M001", "S01", "T01");

      invalidateStateCache();
      const state = await deriveStateFromDb(base);

      // T01 reconciled to complete, T02 still pending → executing T02
      assert.equal(state.phase, "executing");
      assert.equal(state.activeTask?.id, "T02", "should advance to next pending task");
    });
  });

  describe("Failure: 0-byte files", () => {
    test("0-byte SUMMARY file triggers reconciliation (existsSync-only check)", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      // Write 0-byte SUMMARY — existsSync returns true for empty files
      const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "");

      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);

      // The reconciler checks existsSync(summaryPath) at line 1328
      // — it does NOT read content. So 0-byte file counts as "done".
      // This is a known gap: empty SUMMARY treated as completion.
      assert.equal(state.phase, "executing",
        "0-byte SUMMARY marks T01 done via reconciliation, T02 becomes active");
      assert.equal(state.activeTask?.id, "T02");
    });

    test("0-byte VALIDATION file → stays in validating-milestone", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      const dir = join(base, ".gsd", "milestones", "M001");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "M001-VALIDATION.md"), "");

      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "validating-milestone",
        "0-byte VALIDATION should not be treated as terminal");
    });

    test("0-byte PLAN file → planning phase", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      const dir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "S01-PLAN.md"), "");

      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "planning", "0-byte PLAN should stay in planning");
    });
  });

  describe("Failure: DB/filesystem divergence", () => {
    test("DB says slice complete, no milestone VALIDATION → validating-milestone", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);

      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Slice", status: "complete", depends: [] });

      writeRoadmap(base, "M001", doneSliceRoadmap());

      invalidateStateCache();
      const state = await deriveStateFromDb(base);

      assert.equal(state.phase, "validating-milestone",
        "DB-complete slice should trigger milestone validation");
    });

    test("DB says task complete but SUMMARY missing → no crash, advances to next", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);

      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Slice", status: "active", depends: [] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "T01: Task", status: "complete" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "T02: Task", status: "pending" });

      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());

      invalidateStateCache();
      const state = await deriveStateFromDb(base);

      assert.equal(state.phase, "executing");
      assert.equal(state.activeTask?.id, "T02");
    });

    test("milestone in DB but directory missing from disk → no crash", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);

      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });

      invalidateStateCache();
      const state = await deriveStateFromDb(base);

      assert.ok(state.phase !== undefined, "should produce a valid phase");
    });
  });

  describe("Failure: corrupt frontmatter", () => {
    test("VALIDATION with broken frontmatter → stays in validating", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      const dir = join(base, ".gsd", "milestones", "M001");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "M001-VALIDATION.md"), [
        "---",
        "this is not: valid: yaml: {{{}}}",
        "---",
        "",
        "Some content.",
      ].join("\n"));

      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "validating-milestone",
        "corrupt frontmatter should keep milestone in validating phase");
    });

    test("CONTEXT with broken depends_on → no crash, deps empty", async () => {
      const base = createFixtureBase();
      writeContext(base, "M001", [
        "---",
        "depends_on: {{{invalid}}}",
        "---",
        "",
        "# M001: Test",
      ].join("\n"));
      writeRoadmap(base, "M001", standardRoadmap());

      invalidateStateCache();
      const state = await deriveState(base);

      assert.ok(state.phase !== undefined, "should not crash on corrupt depends_on");
      // With corrupt deps, parseContextDependsOn returns [] → no blocking
      assert.notEqual(state.phase, "blocked",
        "corrupt deps should not falsely block milestone");
    });
  });

  describe("Failure: missing task plan files in DB path", () => {
    test("DB has tasks but no T##-PLAN.md files → planning phase", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);

      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Slice", status: "active", depends: [] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "T01: Task", status: "pending" });

      writeRoadmap(base, "M001", standardRoadmap());
      const dir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
      mkdirSync(join(dir, "tasks"), { recursive: true });
      writeFileSync(join(dir, "S01-PLAN.md"), standardPlan());
      // NO T01-PLAN.md

      invalidateStateCache();
      const state = await deriveStateFromDb(base);

      assert.equal(state.phase, "planning",
        "missing T##-PLAN.md files should keep state in planning");
    });
  });

  describe("Failure: stale path cache", () => {
    test("file created after cache populated → must clear path cache", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());

      invalidateStateCache();
      clearPathCache();
      const state1 = await deriveState(base);
      assert.equal(state1.phase, "planning");

      // Write PLAN AFTER first derivation cached paths
      writePlan(base, "M001", "S01", standardPlan());

      // Without clearPathCache, stale cache may miss the new file
      invalidateStateCache();
      clearPathCache();
      const state2 = await deriveState(base);

      assert.equal(state2.phase, "executing",
        "after cache clear, should see the new PLAN file");
    });
  });

  describe("Failure: blocker detection edge cases", () => {
    test("filesystem: blocker in SUMMARY but task not marked [x] → still detected", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      // T01 marked done in plan, T02 pending
      writePlan(base, "M001", "S01", partialDonePlan());
      // T01 SUMMARY has blocker_discovered in frontmatter
      writeTaskSummaryWithBlocker(base, "M001", "S01", "T01");

      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "replanning-slice",
        "blocker_discovered in SUMMARY frontmatter should trigger replanning");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // FAILURE AT EVERY PHASE: What breaks mid-transition
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Failure at pre-planning: CONTEXT file half-written", () => {
    test("CONTEXT exists but is garbage → still enters pre-planning (no roadmap)", async () => {
      const base = createFixtureBase();
      writeContext(base, "M001", "\x00\x00\x00binary garbage\xff\xfe");
      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);

      // File exists so milestone is not ghost, but no roadmap → pre-planning
      assert.equal(state.phase, "pre-planning");
      assert.ok(state.activeMilestone !== null);
    });
  });

  describe("Failure at needs-discussion: CONTEXT-DRAFT is empty", () => {
    test("0-byte CONTEXT-DRAFT → should still trigger needs-discussion", async () => {
      const base = createFixtureBase();
      const dir = join(base, ".gsd", "milestones", "M001");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "M001-CONTEXT-DRAFT.md"), "");
      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);

      // File exists (even empty) → not a ghost, has draft → needs-discussion
      assert.equal(state.phase, "needs-discussion",
        "0-byte draft should still trigger discussion phase");
    });
  });

  describe("Failure at planning: ROADMAP exists but is unparseable", () => {
    test("ROADMAP with no slices section → pre-planning (zero slices)", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", "# M001: Test\n\nJust some text, no ## Slices section.");
      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);

      // parseRoadmap finds no slices → empty array → pre-planning
      assert.equal(state.phase, "pre-planning",
        "unparseable roadmap with no slices should fall to pre-planning");
    });

    test("ROADMAP with broken slice syntax → treats as zero slices", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", [
        "# M001: Test",
        "",
        "**Vision:** Test.",
        "",
        "## Slices",
        "",
        "This is not a valid slice entry at all.",
        "Neither is this.",
      ].join("\n"));
      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);

      // No parseable slice entries → zero slices → pre-planning
      assert.equal(state.phase, "pre-planning",
        "broken slice syntax should result in zero slices");
    });
  });

  describe("Failure at planning: PLAN file is corrupt", () => {
    test("PLAN exists but tasks section is garbage → zero tasks → planning", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      const dir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "S01-PLAN.md"), [
        "# S01: Slice",
        "",
        "## Tasks",
        "",
        "random garbage with no task markers",
        "more garbage",
      ].join("\n"));
      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "planning",
        "PLAN with unparseable tasks should stay in planning");
    });
  });

  describe("Failure at executing: task plan file is empty", () => {
    test("T01-PLAN.md exists but is 0-byte → still enters executing", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      const dir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
      const tasksDir = join(dir, "tasks");
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(join(dir, "S01-PLAN.md"), standardPlan());
      // Create task plan files but make them 0-byte
      writeFileSync(join(tasksDir, "T01-PLAN.md"), "");
      writeFileSync(join(tasksDir, "T02-PLAN.md"), "");
      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);

      // Task plan file existence check at line 718-730 uses readdirSync
      // to count .md files. 0-byte files still count.
      assert.equal(state.phase, "executing",
        "0-byte task plan files still pass the existence check");
    });
  });

  describe("Failure at executing: DB has task but wrong status string", () => {
    test("task with unexpected status string → not treated as closed", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);

      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Slice", status: "active", depends: [] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "T01: Task", status: "pending" });

      // Set a garbage status that isn't "complete" or "done"
      updateTaskStatus("M001", "S01", "T01", "finished");

      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());

      invalidateStateCache();
      const state = await deriveStateFromDb(base);

      // isClosedStatus("finished") → false → task treated as active
      assert.equal(state.phase, "executing");
      assert.equal(state.activeTask?.id, "T01",
        "non-standard status 'finished' is NOT treated as closed");
    });
  });

  describe("Failure at summarizing: slice SUMMARY write fails (file missing)", () => {
    test("all tasks [x] but no slice SUMMARY → stays in summarizing", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", allDonePlan());
      // All tasks done but no S01-SUMMARY.md written
      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "summarizing");
      // Next derivation still returns summarizing — no infinite loop
      invalidateStateCache();
      const state2 = await deriveState(base);
      assert.equal(state2.phase, "summarizing", "stays in summarizing until SUMMARY written");
    });
  });

  describe("Failure at validating-milestone: VALIDATION write crashes", () => {
    test("all slices done, validation never written → stuck in validating", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      // No VALIDATION file at all
      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "validating-milestone");

      // Call again — still validating (idempotent, not looping)
      invalidateStateCache();
      const state2 = await deriveState(base);
      assert.equal(state2.phase, "validating-milestone",
        "stays in validating until VALIDATION file appears");
    });
  });

  describe("Failure at completing-milestone: SUMMARY write fails", () => {
    test("validation terminal but SUMMARY never written → stuck in completing", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      writeMilestoneValidation(base, "M001", "pass");
      // No milestone SUMMARY
      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "completing-milestone");

      // Repeated calls stay in completing
      invalidateStateCache();
      const state2 = await deriveState(base);
      assert.equal(state2.phase, "completing-milestone",
        "stays in completing until SUMMARY written");
    });
  });

  describe("Failure at replanning: REPLAN.md never written (loop risk)", () => {
    test("blocker detected, replan dispatched but REPLAN.md not created → re-enters replanning", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", partialDonePlan());
      writeTaskSummaryWithBlocker(base, "M001", "S01", "T01");
      // No REPLAN.md — simulates failed replan execution

      invalidateStateCache();
      clearPathCache();
      const state1 = await deriveState(base);
      assert.equal(state1.phase, "replanning-slice");

      // Call again — same result, stuck in replanning until REPLAN.md appears
      invalidateStateCache();
      const state2 = await deriveState(base);
      assert.equal(state2.phase, "replanning-slice",
        "without REPLAN.md, state stays in replanning (dispatch will retry)");
    });
  });

  describe("Failure at complete: SUMMARY exists but VALIDATION missing", () => {
    test("milestone SUMMARY without VALIDATION → still complete (SUMMARY is terminal artifact)", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      // SUMMARY exists but NO VALIDATION
      writeMilestoneSummary(base, "M001");
      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);

      // Per #864: SUMMARY is the terminal artifact, validation optional
      assert.equal(state.phase, "complete",
        "SUMMARY alone should mark milestone complete per #864");
    });
  });

  describe("Failure at blocked: dependency milestone partially complete", () => {
    test("M001 has slices done but no SUMMARY → M002 (depends on M001) is blocked", async () => {
      const base = createFixtureBase();
      // M001: all slices done but no SUMMARY/VALIDATION
      writeRoadmap(base, "M001", doneSliceRoadmap());
      // M001 has no SUMMARY → it's in validating/completing, NOT complete

      // M002: depends on M001
      writeContext(base, "M002", [
        "---",
        "depends_on:",
        "  - M001",
        "---",
        "",
        "# M002: Dependent",
      ].join("\n"));
      writeRoadmap(base, "M002", [
        "# M002: Dependent",
        "",
        "**Vision:** Test.",
        "",
        "## Slices",
        "",
        "- [ ] **S01: Slice** `risk:low` `depends:[]`",
        "  > After this: done.",
      ].join("\n"));

      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);

      // M001 is active (not yet complete), M002 should wait
      assert.equal(state.activeMilestone?.id, "M001",
        "M001 should be active (not complete without SUMMARY)");
      assert.notEqual(state.activeMilestone?.id, "M002",
        "M002 should not be active while M001 is incomplete");
    });
  });

  describe("Failure: multiple reconciliation in single derivation", () => {
    test("DB has 3 stale tasks, all with SUMMARY on disk → all reconciled in one pass", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);

      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Slice", status: "active", depends: [] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "T01", status: "pending" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "T02", status: "in-progress" });
      insertTask({ id: "T03", sliceId: "S01", milestoneId: "M001", title: "T03", status: "pending" });

      const threeTaskRoadmap = [
        "# M001: Test",
        "",
        "**Vision:** Test.",
        "",
        "## Slices",
        "",
        "- [ ] **S01: Slice** `risk:low` `depends:[]`",
        "  > After this: done.",
      ].join("\n");
      writeRoadmap(base, "M001", threeTaskRoadmap);

      const threeTaskPlan = [
        "# S01: Slice",
        "",
        "**Goal:** Test.",
        "**Demo:** Tests pass.",
        "",
        "## Tasks",
        "",
        "- [ ] **T01: First** `est:10m`",
        "  First.",
        "",
        "- [ ] **T02: Second** `est:10m`",
        "  Second.",
        "",
        "- [ ] **T03: Third** `est:10m`",
        "  Third.",
      ].join("\n");
      writePlan(base, "M001", "S01", threeTaskPlan);

      // All 3 tasks have SUMMARY on disk
      writeTaskSummary(base, "M001", "S01", "T01");
      writeTaskSummary(base, "M001", "S01", "T02");
      writeTaskSummary(base, "M001", "S01", "T03");

      invalidateStateCache();
      const state = await deriveStateFromDb(base);

      // All 3 should be reconciled in one pass → summarizing
      assert.equal(state.phase, "summarizing",
        "all 3 stale tasks should be reconciled to complete in one derivation");
    });
  });
});
