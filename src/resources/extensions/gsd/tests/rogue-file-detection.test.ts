/**
 * Rogue file detection tests — verifies that detectRogueFileWrites()
 * correctly identifies summary files written directly to disk without
 * a corresponding DB completion record.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { detectRogueFileWrites } from "../auto-post-unit.ts";
import { openDatabase, closeDatabase, isDbAvailable, insertMilestone, insertSlice, insertTask, updateSliceStatus, upsertMilestonePlanning } from "../gsd-db.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTmpBase(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "gsd-rogue-test-")));
}

/**
 * Create a minimal .gsd/ directory structure with a task summary file.
 */
function createTaskSummaryOnDisk(basePath: string, mid: string, sid: string, tid: string): string {
  const tasksDir = join(basePath, ".gsd", "milestones", mid, "slices", sid, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  const summaryFile = join(tasksDir, `${tid}-SUMMARY.md`);
  writeFileSync(summaryFile, `---\nid: ${tid}\nparent: ${sid}\nmilestone: ${mid}\n---\n# ${tid}: Test\n`, "utf-8");
  return summaryFile;
}

/**
 * Create a minimal .gsd/ directory structure with a slice summary file.
 */
function createSliceSummaryOnDisk(basePath: string, mid: string, sid: string): string {
  const sliceDir = join(basePath, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(sliceDir, { recursive: true });
  const summaryFile = join(sliceDir, `${sid}-SUMMARY.md`);
  writeFileSync(summaryFile, `---\nid: ${sid}\nmilestone: ${mid}\n---\n# ${sid}: Test Slice\n`, "utf-8");
  return summaryFile;
}

function createRoadmapOnDisk(basePath: string, mid: string): string {
  const milestoneDir = join(basePath, ".gsd", "milestones", mid);
  mkdirSync(milestoneDir, { recursive: true });
  const roadmapFile = join(milestoneDir, `${mid}-ROADMAP.md`);
  writeFileSync(roadmapFile, `# ${mid}: Test Roadmap\n`, "utf-8");
  return roadmapFile;
}

function createSlicePlanOnDisk(basePath: string, mid: string, sid: string): string {
  const sliceDir = join(basePath, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(sliceDir, { recursive: true });
  const planFile = join(sliceDir, `${sid}-PLAN.md`);
  writeFileSync(planFile, `# ${sid}: Test Plan\n`, "utf-8");
  return planFile;
}


// ── Tests ────────────────────────────────────────────────────────────────────

test("rogue detection: task summary on disk, no DB row → detected as rogue", () => {
  const basePath = createTmpBase();
  const dbPath = join(basePath, ".gsd", "gsd.db");
  mkdirSync(join(basePath, ".gsd"), { recursive: true });

  try {
    openDatabase(dbPath);
    assert.ok(isDbAvailable(), "DB should be available");

    const summaryPath = createTaskSummaryOnDisk(basePath, "M001", "S01", "T01");
    assert.ok(existsSync(summaryPath), "Summary file should exist on disk");

    const rogues = detectRogueFileWrites("execute-task", "M001/S01/T01", basePath);
    assert.equal(rogues.length, 1, "Should detect one rogue file");
    assert.equal(rogues[0].path, summaryPath);
    assert.equal(rogues[0].unitType, "execute-task");
    assert.equal(rogues[0].unitId, "M001/S01/T01");
  } finally {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("rogue detection: task summary on disk, DB row with status 'complete' → NOT rogue", () => {
  const basePath = createTmpBase();
  const dbPath = join(basePath, ".gsd", "gsd.db");
  mkdirSync(join(basePath, ".gsd"), { recursive: true });

  try {
    openDatabase(dbPath);

    createTaskSummaryOnDisk(basePath, "M001", "S01", "T01");

    // Insert parent milestone and slice first (foreign key constraints)
    insertMilestone({ id: "M001" });
    insertSlice({ milestoneId: "M001", id: "S01" });

    // Insert a completed task row into the DB (INSERT OR REPLACE)
    insertTask({
      milestoneId: "M001",
      sliceId: "S01",
      id: "T01",
      title: "Test Task",
      status: "complete",
      oneLiner: "Test",
    });

    const rogues = detectRogueFileWrites("execute-task", "M001/S01/T01", basePath);
    assert.equal(rogues.length, 0, "Should NOT detect rogue when DB row is complete");
  } finally {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("rogue detection: no summary file on disk → NOT rogue regardless of DB state", () => {
  const basePath = createTmpBase();
  const dbPath = join(basePath, ".gsd", "gsd.db");
  mkdirSync(join(basePath, ".gsd"), { recursive: true });

  try {
    openDatabase(dbPath);

    // Don't create any summary file on disk
    const rogues = detectRogueFileWrites("execute-task", "M001/S01/T01", basePath);
    assert.equal(rogues.length, 0, "Should NOT detect rogue when no file on disk");
  } finally {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("rogue detection: DB not available → returns empty array (graceful degradation)", () => {
  const basePath = createTmpBase();

  try {
    closeDatabase();
    assert.ok(!isDbAvailable(), "DB should not be available");

    // Create a file on disk even though DB is closed
    createTaskSummaryOnDisk(basePath, "M001", "S01", "T01");

    const rogues = detectRogueFileWrites("execute-task", "M001/S01/T01", basePath);
    assert.equal(rogues.length, 0, "Should return empty array when DB unavailable");
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("rogue detection: slice summary on disk, no DB row → auto-remediated (not rogue)", () => {
  const basePath = createTmpBase();
  const dbPath = join(basePath, ".gsd", "gsd.db");
  mkdirSync(join(basePath, ".gsd"), { recursive: true });

  try {
    openDatabase(dbPath);

    const summaryPath = createSliceSummaryOnDisk(basePath, "M001", "S01");
    assert.ok(existsSync(summaryPath), "Slice summary file should exist on disk");

    // Fix #3633: stale slice DB status is auto-remediated via updateSliceStatus()
    // instead of being reported as rogue, so rogues array should be empty.
    const rogues = detectRogueFileWrites("complete-slice", "M001/S01", basePath);
    assert.equal(rogues.length, 0, "Should auto-remediate stale slice, not report as rogue");
  } finally {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("rogue detection: slice summary on disk, DB row with status 'complete' → NOT rogue", () => {
  const basePath = createTmpBase();
  const dbPath = join(basePath, ".gsd", "gsd.db");
  mkdirSync(join(basePath, ".gsd"), { recursive: true });

  try {
    openDatabase(dbPath);

    createSliceSummaryOnDisk(basePath, "M001", "S01");

    // Insert parent milestone first (foreign key constraint)
    insertMilestone({ id: "M001" });

    // Insert a slice row, then update to complete
    insertSlice({
      milestoneId: "M001",
      id: "S01",
      title: "Test Slice",
      status: "complete",
    });
    updateSliceStatus("M001", "S01", "complete", new Date().toISOString());

    const rogues = detectRogueFileWrites("complete-slice", "M001/S01", basePath);
    assert.equal(rogues.length, 0, "Should NOT detect rogue when slice DB row is complete");
  } finally {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("rogue detection: plan milestone roadmap on disk, no milestone planning row → detected as rogue", () => {
  const basePath = createTmpBase();
  const dbPath = join(basePath, ".gsd", "gsd.db");
  mkdirSync(join(basePath, ".gsd"), { recursive: true });

  try {
    openDatabase(dbPath);

    const roadmapPath = createRoadmapOnDisk(basePath, "M001");
    assert.ok(existsSync(roadmapPath), "Roadmap file should exist on disk");

    const rogues = detectRogueFileWrites("plan-milestone", "M001", basePath);
    assert.equal(rogues.length, 1, "Should detect one rogue roadmap file");
    assert.equal(rogues[0].path, roadmapPath);
    assert.equal(rogues[0].unitType, "plan-milestone");
    assert.equal(rogues[0].unitId, "M001");
  } finally {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("rogue detection: plan milestone roadmap on disk, DB milestone planning row exists → NOT rogue", () => {
  const basePath = createTmpBase();
  const dbPath = join(basePath, ".gsd", "gsd.db");
  mkdirSync(join(basePath, ".gsd"), { recursive: true });

  try {
    openDatabase(dbPath);

    createRoadmapOnDisk(basePath, "M001");
    insertMilestone({ id: "M001", title: "Planned Milestone" });
    upsertMilestonePlanning("M001", {
      vision: "Real planning state",
      requirementCoverage: "R001 → S01",
      boundaryMapMarkdown: "- planner → db",
    });

    const rogues = detectRogueFileWrites("plan-milestone", "M001", basePath);
    assert.equal(rogues.length, 0, "Should NOT detect rogue when milestone planning state exists");
  } finally {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("rogue detection: slice plan on disk, no slice planning row → detected as rogue", () => {
  const basePath = createTmpBase();
  const dbPath = join(basePath, ".gsd", "gsd.db");
  mkdirSync(join(basePath, ".gsd"), { recursive: true });

  try {
    openDatabase(dbPath);

    const planPath = createSlicePlanOnDisk(basePath, "M001", "S01");
    assert.ok(existsSync(planPath), "Slice plan file should exist on disk");

    const rogues = detectRogueFileWrites("plan-slice", "M001/S01", basePath);
    assert.equal(rogues.length, 1, "Should detect one rogue slice plan file");
    assert.equal(rogues[0].path, planPath);
    assert.equal(rogues[0].unitType, "plan-slice");
    assert.equal(rogues[0].unitId, "M001/S01");
  } finally {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("rogue detection: slice plan on disk, DB slice planning row exists → NOT rogue", () => {
  const basePath = createTmpBase();
  const dbPath = join(basePath, ".gsd", "gsd.db");
  mkdirSync(join(basePath, ".gsd"), { recursive: true });

  try {
    openDatabase(dbPath);

    createSlicePlanOnDisk(basePath, "M001", "S01");
    insertMilestone({ id: "M001" });
    insertSlice({
      milestoneId: "M001",
      id: "S01",
      title: "Planned Slice",
      status: "pending",
      demo: "Observable plan",
    });

    const rogues = detectRogueFileWrites("plan-slice", "M001/S01", basePath);
    assert.equal(rogues.length, 0, "Should NOT detect rogue when slice planning state exists");
  } finally {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  }
});
