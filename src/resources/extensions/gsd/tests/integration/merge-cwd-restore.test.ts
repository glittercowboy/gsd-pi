/**
 * GSD-2 — Regression tests for merge cwd restore (#2929)
 * merge-cwd-restore.test.ts — Regression tests for #2929.
 *
 * Verifies:
 *   1. MergeConflictError restores process.cwd() to the pre-merge directory.
 *   2. autoCommitDirtyState does not run on the integration branch when cwd
 *      leaked there from a prior failed merge (parallel mode).
 *
 * Bug: PR #2298 added a stash lifecycle around mergeMilestoneToMain but the
 * MergeConflictError throw path omitted the process.chdir(previousCwd) that
 * the dirty-working-tree and divergence handlers both include. In parallel
 * merge sequences, this left cwd on the integration branch, causing the next
 * merge's autoCommitDirtyState to commit dirty files from OTHER milestones
 * onto main.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { mergeMilestoneToMain } from "../../auto-worktree.ts";
import { MergeConflictError } from "../../git-service.ts";

function run(cmd: string, cwd: string): string {
  return execSync(cmd, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "merge-cwd-restore-test-")),
  );
  run("git init -b main", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  writeFileSync(join(dir, ".gitignore"), ".gsd/worktrees/\n");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "STATE.md"), "# State\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  return dir;
}

function makeRoadmap(mid: string, title: string): string {
  return [
    `# ${mid}: Test milestone`,
    "",
    "## Slices",
    "- [x] **S01: Test slice**",
  ].join("\n");
}

describe("merge cwd restore (#2929)", () => {
  let repo: string;
  let savedCwd: string;

  beforeEach(() => {
    savedCwd = process.cwd();
    repo = createTempRepo();
  });

  afterEach(() => {
    process.chdir(savedCwd);
    try { run("git reset --hard HEAD", repo); } catch { /* */ }
    rmSync(repo, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 1: MergeConflictError restores cwd (#2929 bug 2)
  // ─────────────────────────────────────────────────────────────────────────

  test("MergeConflictError restores cwd to pre-merge directory", () => {
    // Create milestone branch that modifies README.md
    run("git checkout -b milestone/M010", repo);
    writeFileSync(join(repo, "README.md"), "# M010 version\n");
    run("git add .", repo);
    run('git commit -m "M010 changes README"', repo);
    run("git checkout main", repo);

    // Modify README.md on main to create a conflict
    writeFileSync(join(repo, "README.md"), "# main version (diverged)\n");
    run("git add .", repo);
    run('git commit -m "main diverges README"', repo);

    // cwd must be repo root (simulates parallel-merge calling from project root)
    process.chdir(repo);
    const cwdBefore = process.cwd();

    let caught: unknown = null;
    try {
      mergeMilestoneToMain(repo, "M010", makeRoadmap("M010", "Conflict test"));
    } catch (err) {
      caught = err;
    }

    // Should have thrown a MergeConflictError
    assert.ok(caught instanceof MergeConflictError, "expected MergeConflictError");

    // Critical: cwd must be restored to where it was before the merge
    const cwdAfter = process.cwd();
    assert.equal(
      cwdAfter,
      cwdBefore,
      "cwd should be restored after MergeConflictError — was left on integration branch before fix",
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 2: autoCommitDirtyState skipped when on integration branch (#2929 bug 1)
  // ─────────────────────────────────────────────────────────────────────────

  test("autoCommitDirtyState does not commit on integration branch in worktree mode", () => {
    // Create milestone branch with real work
    run("git checkout -b milestone/M010", repo);
    writeFileSync(join(repo, "m010.ts"), "export const m010 = true;\n");
    run("git add .", repo);
    run('git commit -m "M010 work"', repo);
    run("git checkout main", repo);

    // Simulate the parallel-mode state: cwd is on main with dirty files
    // from another milestone (as if a prior merge's MergeConflictError
    // left cwd on main and syncStateToProjectRoot wrote these files).
    writeFileSync(join(repo, "dirty-from-m020.txt"), "should not be committed\n");

    // Set up roadmap so mergeMilestoneToMain can find milestone metadata
    mkdirSync(join(repo, ".gsd", "milestones", "M010"), { recursive: true });
    writeFileSync(
      join(repo, ".gsd", "milestones", "M010", "M010-ROADMAP.md"),
      makeRoadmap("M010", "First milestone"),
    );

    process.chdir(repo);

    const result = mergeMilestoneToMain(
      repo,
      "M010",
      makeRoadmap("M010", "First milestone"),
    );

    assert.ok(result.commitMessage.includes("M010"), "commit should be for M010");

    // Verify the squash merge brought M010's work file
    const mergeLog = run("git log --oneline --diff-filter=A -- m010.ts", repo);
    assert.ok(mergeLog.length > 0, "m010.ts should be in a commit on main");

    // The dirty file should NOT appear in the squash merge commit.
    const squashCommit = run("git log --format=%H --grep='GSD-Milestone: M010' -1", repo);
    assert.ok(squashCommit.length > 0, "should find the squash merge commit");
    const filesInSquash = run(`git diff-tree --no-commit-id --name-only -r ${squashCommit}`, repo);
    assert.ok(
      !filesInSquash.includes("dirty-from-m020.txt"),
      "dirty-from-m020.txt should NOT be in the squash merge commit",
    );
  });
});
