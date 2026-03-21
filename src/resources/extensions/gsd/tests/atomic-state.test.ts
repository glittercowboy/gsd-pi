/**
 * Atomic STATE.md commit + crash-resume tests.
 *
 * Validates:
 * - autoCommit() with includeOverrides re-stages paths excluded by smartStage()
 * - deriveState() returns the next incomplete task after simulated crash-resume
 * - deriveState() works even without STATE.md (plan checkboxes are source of truth)
 * - 30-second throttle preserved for non-execute-task unit types
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { deriveState } from "../state.ts";
import { GitServiceImpl } from "../git-service.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Fixture Helpers ──────────────────────────────────────────────────────────

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-atomic-state-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
}

/**
 * Write a minimal roadmap with one slice.
 */
function writeRoadmap(base: string, mid: string, slices: { id: string; title: string; done: boolean }[]): void {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  const lines = [
    `# ${mid}: Test Milestone`,
    "",
    "## Slices",
    "",
  ];
  for (const s of slices) {
    lines.push(`- [${s.done ? "x" : " "}] **${s.id}: ${s.title}**`);
  }
  writeFileSync(join(dir, `${mid}-ROADMAP.md`), lines.join("\n") + "\n");
}

/**
 * Write a slice plan with the given tasks and their completion states.
 */
function writeSlicePlan(
  base: string, mid: string, sid: string,
  tasks: { id: string; title: string; done: boolean }[],
): void {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid);
  const tasksDir = join(dir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  const lines = [
    `# ${sid}: Test Slice`,
    "",
    `**Goal:** Test goal`,
    "",
    "## Tasks",
    "",
  ];
  for (const t of tasks) {
    lines.push(`- [${t.done ? "x" : " "}] **${t.id}: ${t.title}** \`est:30m\``);
  }
  writeFileSync(join(dir, `${sid}-PLAN.md`), lines.join("\n") + "\n");

  // Create stub task plan files so deriveState doesn't fall back to planning phase
  for (const t of tasks) {
    writeFileSync(join(tasksDir, `${t.id}-PLAN.md`), `# ${t.id}: ${t.title}\n\nTask plan stub.\n`);
  }
}

/**
 * Write a task summary file (simulates a completed task).
 */
function writeTaskSummary(base: string, mid: string, sid: string, tid: string, title: string): void {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid, "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${tid}-SUMMARY.md`), [
    "---",
    `id: ${tid}`,
    `parent: ${sid}`,
    `milestone: ${mid}`,
    "---",
    "",
    `# ${tid}: ${title}`,
    "",
    `**Completed ${tid}**`,
    "",
  ].join("\n"));
}

/**
 * Write a minimal STATE.md reflecting which tasks are complete.
 */
function writeStateMd(base: string, mid: string, sid: string, activeTask: string | null): void {
  const content = [
    "# GSD State",
    "",
    `**Active Milestone:** ${mid}`,
    `**Active Slice:** ${sid}`,
    activeTask ? `**Active Task:** ${activeTask}` : "**Active Task:** none",
    "",
    "## Progress",
    "",
    "State rebuilt automatically.",
  ].join("\n");
  writeFileSync(join(base, ".gsd", "STATE.md"), content);
}

/**
 * Initialize a real git repo in the temp directory for git-level integration tests.
 */
function initGitRepo(base: string): void {
  execSync("git init", { cwd: base, stdio: "ignore" });
  execSync('git config user.email "test@test.com"', { cwd: base, stdio: "ignore" });
  execSync('git config user.name "Test"', { cwd: base, stdio: "ignore" });
  // Initial commit so HEAD exists
  writeFileSync(join(base, ".gitignore"), "");
  execSync("git add -A && git commit -m 'init'", { cwd: base, stdio: "ignore" });
}

// ─── Crash-Resume Tests ───────────────────────────────────────────────────────

describe("atomic-state: crash-resume after atomic commit", () => {
  let base: string;

  beforeEach(() => {
    base = makeTmpBase();
  });

  afterEach(() => {
    cleanup(base);
  });

  it("deriveState returns T02 as active after T01 marked done in plan", async () => {
    // Setup: 3-task slice, T01 marked [x] in plan, T02/T03 still [ ]
    writeRoadmap(base, "M001", [{ id: "S01", title: "Test Slice", done: false }]);
    writeSlicePlan(base, "M001", "S01", [
      { id: "T01", title: "First task", done: true },
      { id: "T02", title: "Second task", done: false },
      { id: "T03", title: "Third task", done: false },
    ]);
    writeTaskSummary(base, "M001", "S01", "T01", "First task");
    writeStateMd(base, "M001", "S01", "T02");

    const state = await deriveState(base);

    assert.equal(state.activeTask?.id, "T02", "active task should be T02");
    assert.equal(state.activeSlice?.id, "S01", "active slice should be S01");
    assert.equal(state.activeMilestone?.id, "M001", "active milestone should be M001");
    assert.equal(state.phase, "executing", "phase should be executing");
  });

  it("deriveState returns T03 as active after T01 and T02 marked done", async () => {
    writeRoadmap(base, "M001", [{ id: "S01", title: "Test Slice", done: false }]);
    writeSlicePlan(base, "M001", "S01", [
      { id: "T01", title: "First task", done: true },
      { id: "T02", title: "Second task", done: true },
      { id: "T03", title: "Third task", done: false },
    ]);
    writeTaskSummary(base, "M001", "S01", "T01", "First task");
    writeTaskSummary(base, "M001", "S01", "T02", "Second task");
    writeStateMd(base, "M001", "S01", "T03");

    const state = await deriveState(base);

    assert.equal(state.activeTask?.id, "T03", "active task should be T03");
    assert.equal(state.phase, "executing", "phase should be executing");
  });

  it("deriveState returns summarizing when all tasks done", async () => {
    writeRoadmap(base, "M001", [{ id: "S01", title: "Test Slice", done: false }]);
    writeSlicePlan(base, "M001", "S01", [
      { id: "T01", title: "First task", done: true },
      { id: "T02", title: "Second task", done: true },
      { id: "T03", title: "Third task", done: true },
    ]);
    writeTaskSummary(base, "M001", "S01", "T01", "First task");
    writeTaskSummary(base, "M001", "S01", "T02", "Second task");
    writeTaskSummary(base, "M001", "S01", "T03", "Third task");

    const state = await deriveState(base);

    assert.equal(state.activeTask, null, "no active task when all done");
    assert.equal(state.phase, "summarizing", "phase should be summarizing");
  });
});

describe("atomic-state: crash-resume without STATE.md", () => {
  let base: string;

  beforeEach(() => {
    base = makeTmpBase();
  });

  afterEach(() => {
    cleanup(base);
  });

  it("deriveState still finds T02 as active from plan checkboxes alone", async () => {
    // Same setup as above but NO STATE.md — deriveState reads plan checkboxes directly
    writeRoadmap(base, "M001", [{ id: "S01", title: "Test Slice", done: false }]);
    writeSlicePlan(base, "M001", "S01", [
      { id: "T01", title: "First task", done: true },
      { id: "T02", title: "Second task", done: false },
      { id: "T03", title: "Third task", done: false },
    ]);
    writeTaskSummary(base, "M001", "S01", "T01", "First task");
    // Intentionally NOT writing STATE.md

    assert.equal(
      existsSync(join(base, ".gsd", "STATE.md")),
      false,
      "STATE.md should not exist for this test",
    );

    const state = await deriveState(base);

    assert.equal(state.activeTask?.id, "T02", "active task should be T02 even without STATE.md");
    assert.equal(state.phase, "executing", "phase should be executing");
  });

  it("deriveState handles fresh slice with no completed tasks and no STATE.md", async () => {
    writeRoadmap(base, "M001", [{ id: "S01", title: "Test Slice", done: false }]);
    writeSlicePlan(base, "M001", "S01", [
      { id: "T01", title: "First task", done: false },
      { id: "T02", title: "Second task", done: false },
    ]);

    const state = await deriveState(base);

    assert.equal(state.activeTask?.id, "T01", "active task should be T01");
    assert.equal(state.phase, "executing", "phase should be executing");
  });
});

// ─── autoCommit includeOverrides Integration Test ─────────────────────────────

describe("atomic-state: autoCommit with includeOverrides", () => {
  let base: string;

  beforeEach(() => {
    base = makeTmpBase();
    initGitRepo(base);
  });

  afterEach(() => {
    cleanup(base);
  });

  it("re-stages STATE.md that smartStage would normally exclude", () => {
    const service = new GitServiceImpl(base, {});

    // Create a task summary file AND STATE.md (both should be dirty)
    const taskDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "T01-SUMMARY.md"), "# T01: Test\n\nDone.\n");
    writeFileSync(join(base, ".gsd", "STATE.md"), "# State\n\nRebuild.\n");

    // Commit with includeOverrides for STATE.md
    const msg = service.autoCommit(
      "execute-task", "M001/S01/T01",
      [],   // no extra exclusions
      undefined,
      [".gsd/STATE.md"],
    );

    assert.ok(msg, "commit should have been created");

    // Verify STATE.md is in the commit (not left unstaged)
    const showOutput = execSync("git show --name-only HEAD", { cwd: base, encoding: "utf8" });
    assert.ok(
      showOutput.includes(".gsd/STATE.md"),
      `STATE.md should be in the commit. Got:\n${showOutput}`,
    );
    assert.ok(
      showOutput.includes("T01-SUMMARY.md"),
      "task summary should also be in the commit",
    );
  });

  it("without includeOverrides, STATE.md is excluded from commit", () => {
    const service = new GitServiceImpl(base, {});

    const taskDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "T01-SUMMARY.md"), "# T01: Test\n\nDone.\n");
    writeFileSync(join(base, ".gsd", "STATE.md"), "# State\n\nRebuild.\n");

    // Commit WITHOUT includeOverrides — STATE.md should be excluded by smartStage
    const msg = service.autoCommit("execute-task", "M001/S01/T01");

    assert.ok(msg, "commit should have been created");

    const showOutput = execSync("git show --name-only HEAD", { cwd: base, encoding: "utf8" });
    assert.ok(
      !showOutput.includes(".gsd/STATE.md"),
      `STATE.md should NOT be in the commit without includeOverrides. Got:\n${showOutput}`,
    );
    assert.ok(
      showOutput.includes("T01-SUMMARY.md"),
      "task summary should still be in the commit",
    );
  });
});

// ─── Throttle Preservation Test ───────────────────────────────────────────────

describe("atomic-state: throttle preserved for non-execute-task units", () => {
  it("STATE_REBUILD_MIN_INTERVAL_MS is 30 seconds", async () => {
    // Verify the constant value hasn't changed — it's critical for non-execute-task throttle
    const postUnitSource = readFileSync(
      join(__dirname, "..", "auto-post-unit.ts"),
      "utf8",
    );
    assert.ok(
      postUnitSource.includes("STATE_REBUILD_MIN_INTERVAL_MS = 30_000"),
      "throttle constant should be 30 seconds (30_000ms)",
    );
  });

  it("throttled rebuild skips execute-task units", () => {
    // Verify the conditional in postUnitPreVerification excludes execute-task
    const postUnitSource = readFileSync(
      join(__dirname, "..", "auto-post-unit.ts"),
      "utf8",
    );
    // Find the throttled state rebuild section — it should check for execute-task exclusion
    assert.ok(
      postUnitSource.includes('s.currentUnit.type !== "execute-task"'),
      "throttled state rebuild should skip execute-task units",
    );
  });

  it("atomic state rebuild happens before autoCommitCurrentBranch for execute-task", () => {
    const postUnitSource = readFileSync(
      join(__dirname, "..", "auto-post-unit.ts"),
      "utf8",
    );
    // Verify rebuildState is called before autoCommitCurrentBranch in the execute-task path
    const atomicRebuildIndex = postUnitSource.indexOf("state-rebuild-atomic");
    const commitIndex = postUnitSource.indexOf("autoCommitCurrentBranch(s.basePath");
    assert.ok(atomicRebuildIndex > 0, "state-rebuild-atomic debug log should exist");
    assert.ok(commitIndex > 0, "autoCommitCurrentBranch call should exist");
    assert.ok(
      atomicRebuildIndex < commitIndex,
      "atomic state rebuild should happen BEFORE autoCommitCurrentBranch",
    );
  });
});
