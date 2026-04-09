/**
 * worktree-sync-tasks.test.ts — Regression test for #1678.
 *
 * Verifies that syncWorktreeStateBack() correctly syncs task summaries
 * from the tasks/ subdirectory within each slice, not just slice-level files.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { syncWorktreeStateBack } from "../auto-worktree.ts";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `gsd-sync-test-${prefix}-`));
}

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function writeFile(dir: string, relativePath: string, content: string): void {
  const fullPath = join(dir, relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
}

// ─── Tests ───────────────────────────────────────────────────────────

test("syncWorktreeStateBack copies task summaries from tasks/ subdirectory (#1678)", () => {
  const mainBase = makeTempDir("main");
  const wtBase = makeTempDir("wt");
  const currentMid = "M000"; // milestone being merged (skipped by sync)
  const mid = "M001";        // other milestone that should be synced

  try {
    // Set up worktree with milestone, slice, and task files
    writeFile(wtBase, `.gsd/milestones/${mid}/${mid}-ROADMAP.md`, "# Roadmap\n");
    writeFile(wtBase, `.gsd/milestones/${mid}/${mid}-SUMMARY.md`, "# Summary\n");
    writeFile(wtBase, `.gsd/milestones/${mid}/slices/S01/S01-PLAN.md`, "# Plan\n");
    writeFile(wtBase, `.gsd/milestones/${mid}/slices/S01/S01-SUMMARY.md`, "# Slice Summary\n");
    writeFile(wtBase, `.gsd/milestones/${mid}/slices/S01/S01-UAT.md`, "# UAT\n");
    writeFile(wtBase, `.gsd/milestones/${mid}/slices/S01/tasks/T01-PLAN.md`, "# Task 1 Plan\n");
    writeFile(wtBase, `.gsd/milestones/${mid}/slices/S01/tasks/T01-SUMMARY.md`, "# Task 1 Summary\n");
    writeFile(wtBase, `.gsd/milestones/${mid}/slices/S01/tasks/T02-PLAN.md`, "# Task 2 Plan\n");
    writeFile(wtBase, `.gsd/milestones/${mid}/slices/S01/tasks/T02-SUMMARY.md`, "# Task 2 Summary\n");

    // Set up main with empty .gsd
    mkdirSync(join(mainBase, ".gsd"), { recursive: true });

    // Run sync — currentMid is skipped, mid (M001) should be synced
    const result = syncWorktreeStateBack(mainBase, wtBase, currentMid);

    // Verify milestone-level files synced
    assert.ok(
      existsSync(join(mainBase, `.gsd/milestones/${mid}/${mid}-ROADMAP.md`)),
      "ROADMAP should be synced",
    );
    assert.ok(
      existsSync(join(mainBase, `.gsd/milestones/${mid}/${mid}-SUMMARY.md`)),
      "SUMMARY should be synced",
    );

    // Verify slice-level files synced
    assert.ok(
      existsSync(join(mainBase, `.gsd/milestones/${mid}/slices/S01/S01-PLAN.md`)),
      "S01-PLAN should be synced",
    );
    assert.ok(
      existsSync(join(mainBase, `.gsd/milestones/${mid}/slices/S01/S01-SUMMARY.md`)),
      "S01-SUMMARY should be synced",
    );

    // Verify task-level files synced (THE BUG FIX)
    assert.ok(
      existsSync(join(mainBase, `.gsd/milestones/${mid}/slices/S01/tasks/T01-PLAN.md`)),
      "T01-PLAN should be synced (was dropped before fix)",
    );
    assert.ok(
      existsSync(join(mainBase, `.gsd/milestones/${mid}/slices/S01/tasks/T01-SUMMARY.md`)),
      "T01-SUMMARY should be synced (was dropped before fix)",
    );
    assert.ok(
      existsSync(join(mainBase, `.gsd/milestones/${mid}/slices/S01/tasks/T02-PLAN.md`)),
      "T02-PLAN should be synced (was dropped before fix)",
    );
    assert.ok(
      existsSync(join(mainBase, `.gsd/milestones/${mid}/slices/S01/tasks/T02-SUMMARY.md`)),
      "T02-SUMMARY should be synced (was dropped before fix)",
    );

    // Verify task files appear in synced list
    const taskSynced = result.synced.filter(p => p.includes("/tasks/"));
    assert.ok(
      taskSynced.length >= 4,
      `Expected at least 4 task files in synced list, got ${taskSynced.length}: ${taskSynced.join(", ")}`,
    );

    // Verify content integrity
    const t1Summary = readFileSync(
      join(mainBase, `.gsd/milestones/${mid}/slices/S01/tasks/T01-SUMMARY.md`),
      "utf-8",
    );
    assert.equal(t1Summary, "# Task 1 Summary\n");
  } finally {
    cleanup(mainBase, wtBase);
  }
});

test("syncWorktreeStateBack handles multiple slices with tasks (#1678)", () => {
  const mainBase = makeTempDir("main");
  const wtBase = makeTempDir("wt");
  const currentMid = "M000"; // milestone being merged (skipped)
  const mid = "M002";        // other milestone that should be synced

  try {
    // Set up two slices with tasks
    writeFile(wtBase, `.gsd/milestones/${mid}/slices/S01/S01-SUMMARY.md`, "# S01\n");
    writeFile(wtBase, `.gsd/milestones/${mid}/slices/S01/tasks/T01-SUMMARY.md`, "# S01-T01\n");
    writeFile(wtBase, `.gsd/milestones/${mid}/slices/S02/S02-SUMMARY.md`, "# S02\n");
    writeFile(wtBase, `.gsd/milestones/${mid}/slices/S02/tasks/T01-SUMMARY.md`, "# S02-T01\n");
    writeFile(wtBase, `.gsd/milestones/${mid}/slices/S02/tasks/T02-SUMMARY.md`, "# S02-T02\n");
    writeFile(wtBase, `.gsd/milestones/${mid}/slices/S02/tasks/T03-SUMMARY.md`, "# S02-T03\n");

    mkdirSync(join(mainBase, ".gsd"), { recursive: true });

    const result = syncWorktreeStateBack(mainBase, wtBase, currentMid);

    // All task summaries from both slices should be synced
    assert.ok(existsSync(join(mainBase, `.gsd/milestones/${mid}/slices/S01/tasks/T01-SUMMARY.md`)));
    assert.ok(existsSync(join(mainBase, `.gsd/milestones/${mid}/slices/S02/tasks/T01-SUMMARY.md`)));
    assert.ok(existsSync(join(mainBase, `.gsd/milestones/${mid}/slices/S02/tasks/T02-SUMMARY.md`)));
    assert.ok(existsSync(join(mainBase, `.gsd/milestones/${mid}/slices/S02/tasks/T03-SUMMARY.md`)));

    // Verify content integrity across slices
    assert.equal(
      readFileSync(join(mainBase, `.gsd/milestones/${mid}/slices/S02/tasks/T03-SUMMARY.md`), "utf-8"),
      "# S02-T03\n",
    );
  } finally {
    cleanup(mainBase, wtBase);
  }
});

test("syncWorktreeStateBack handles slices without tasks/ directory", () => {
  const mainBase = makeTempDir("main");
  const wtBase = makeTempDir("wt");
  const currentMid = "M000"; // milestone being merged (skipped)
  const mid = "M003";        // other milestone that should be synced

  try {
    // Slice with no tasks/ subdirectory (legitimate case: pre-planning)
    writeFile(wtBase, `.gsd/milestones/${mid}/slices/S01/S01-RESEARCH.md`, "# Research\n");

    mkdirSync(join(mainBase, ".gsd"), { recursive: true });

    const result = syncWorktreeStateBack(mainBase, wtBase, currentMid);

    // Should sync the slice file without errors
    assert.ok(existsSync(join(mainBase, `.gsd/milestones/${mid}/slices/S01/S01-RESEARCH.md`)));
    // Should not have any task entries
    const taskSynced = result.synced.filter(p => p.includes("/tasks/"));
    assert.equal(taskSynced.length, 0);
  } finally {
    cleanup(mainBase, wtBase);
  }
});

test("syncWorktreeStateBack ignores non-md files in tasks/", () => {
  const mainBase = makeTempDir("main");
  const wtBase = makeTempDir("wt");
  const currentMid = "M000"; // milestone being merged (skipped)
  const mid = "M004";        // other milestone that should be synced

  try {
    writeFile(wtBase, `.gsd/milestones/${mid}/slices/S01/S01-PLAN.md`, "# Plan\n");
    writeFile(wtBase, `.gsd/milestones/${mid}/slices/S01/tasks/T01-SUMMARY.md`, "# T01\n");
    // Non-md file should be ignored
    writeFile(wtBase, `.gsd/milestones/${mid}/slices/S01/tasks/.DS_Store`, "junk");
    writeFile(wtBase, `.gsd/milestones/${mid}/slices/S01/tasks/notes.txt`, "notes");

    mkdirSync(join(mainBase, ".gsd"), { recursive: true });

    const result = syncWorktreeStateBack(mainBase, wtBase, currentMid);

    // Only .md files should be synced
    assert.ok(existsSync(join(mainBase, `.gsd/milestones/${mid}/slices/S01/tasks/T01-SUMMARY.md`)));
    assert.ok(!existsSync(join(mainBase, `.gsd/milestones/${mid}/slices/S01/tasks/.DS_Store`)));
    assert.ok(!existsSync(join(mainBase, `.gsd/milestones/${mid}/slices/S01/tasks/notes.txt`)));
  } finally {
    cleanup(mainBase, wtBase);
  }
});
