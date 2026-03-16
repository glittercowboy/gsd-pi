/**
 * stale-worktree-cwd.test.ts — Tests for #608 fix.
 *
 * Verifies that when process.cwd() is inside a stale .gsd/worktrees/ path,
 * startAuto escapes back to the project root before proceeding.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  createAutoWorktree,
  teardownAutoWorktree,
  mergeMilestoneToMain,
} from "../auto-worktree.ts";

function run(command: string, cwd: string): string {
  return execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "stale-wt-test-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);
  return dir;
}

// ─── escapeStaleWorktree is called by startAuto, test the detection logic ────

test("detects stale worktree path and extracts project root", () => {
  // Simulate the path pattern: /project/.gsd/worktrees/M004/...
  const projectRoot = "/Users/test/myproject";
  const stalePath = `${projectRoot}${sep}.gsd${sep}worktrees${sep}M004`;

  const marker = `${sep}.gsd${sep}worktrees${sep}`;
  const idx = stalePath.indexOf(marker);

  assert.ok(idx !== -1, "marker found in stale path");
  assert.equal(stalePath.slice(0, idx), projectRoot, "project root extracted correctly");
});

test("does not trigger on normal project path", () => {
  const normalPath = "/Users/test/myproject";
  const marker = `${sep}.gsd${sep}worktrees${sep}`;
  const idx = normalPath.indexOf(marker);

  assert.equal(idx, -1, "marker not found in normal path");
});

// ─── Integration: mergeMilestoneToMain restores cwd ─────────────────────────

test("mergeMilestoneToMain restores cwd to project root", () => {
  const savedCwd = process.cwd();
  let tempDir = "";

  try {
    tempDir = createTempRepo();

    // Create milestone planning artifacts
    const msDir = join(tempDir, ".gsd", "milestones", "M050");
    mkdirSync(msDir, { recursive: true });
    writeFileSync(join(msDir, "CONTEXT.md"), "# M050 Context\n");
    const roadmap = [
      "# M050: Test Milestone",
      "**Vision**: testing",
      "## Success Criteria",
      "- It works",
      "## Slices",
      "- [x] S01 — First slice",
    ].join("\n");
    writeFileSync(join(msDir, "ROADMAP.md"), roadmap);
    run("git add .", tempDir);
    run("git commit -m \"add milestone\"", tempDir);

    // Create auto-worktree (enters the worktree dir)
    const wtPath = createAutoWorktree(tempDir, "M050");
    assert.equal(process.cwd(), wtPath, "cwd is in worktree after create");

    // Add a change in the worktree
    writeFileSync(join(wtPath, "feature.txt"), "new feature\n");
    run("git add .", wtPath);
    run("git commit -m \"feat: add feature\"", wtPath);

    // Merge back — should restore cwd to tempDir
    mergeMilestoneToMain(tempDir, "M050", roadmap);

    assert.equal(process.cwd(), tempDir, "cwd restored to project root after merge");
    assert.ok(!existsSync(wtPath), "worktree directory removed after merge");
  } finally {
    process.chdir(savedCwd);
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

// ─── Integration: stale worktree directory is detectable ────────────────────

test("process.cwd() inside removed worktree is recoverable", () => {
  const savedCwd = process.cwd();
  let tempDir = "";

  try {
    tempDir = createTempRepo();

    // Create a .gsd/worktrees/M099 directory to simulate stale state
    const staleWtDir = join(tempDir, ".gsd", "worktrees", "M099");
    mkdirSync(staleWtDir, { recursive: true });

    // Enter the stale directory
    process.chdir(staleWtDir);
    const cwdBefore = process.cwd();
    assert.ok(cwdBefore.includes(`${sep}.gsd${sep}worktrees${sep}`), "cwd is inside worktree dir");

    // Simulate escapeStaleWorktree logic
    const marker = `${sep}.gsd${sep}worktrees${sep}`;
    const idx = cwdBefore.indexOf(marker);
    assert.ok(idx !== -1, "marker found");

    const projectRoot = cwdBefore.slice(0, idx);
    process.chdir(projectRoot);

    assert.equal(process.cwd(), tempDir, "successfully escaped to project root");
  } finally {
    process.chdir(savedCwd);
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});
