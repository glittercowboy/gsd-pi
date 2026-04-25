/**
 * uat-stuck-loop-orphaned-worktree.test.ts — Regression tests for #2821.
 *
 * Reproduces two cascading bugs:
 *
 * Bug 1 — UAT stuck-loop: syncProjectRootToWorktree uses force:false for
 *   milestone files. When the project root has an ASSESSMENT with a verdict
 *   but the worktree has a stale/empty ASSESSMENT (or none at all after DB
 *   rebuild), the verdict is NOT synced into the worktree. checkNeedsRunUat
 *   finds no verdict → re-dispatches run-uat indefinitely.
 *
 * Bug 2 — Orphaned worktree: removeWorktree silently swallows failures when
 *   git worktree remove fails (untracked files, CWD inside worktree, etc.).
 *   The worktree directory and branch persist on disk after teardown.
 *   teardownAutoWorktree has a fallback rmSync but it also fails when the
 *   git internal .git/worktrees/<name> directory holds a lock.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { syncProjectRootToWorktree } from "../auto-worktree.ts";
import {
  createWorktree,
  removeWorktree,
  worktreePath,
} from "../worktree-manager.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function makeBaseRepo(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-2821-"));
  git(["init", "-b", "main"], base);
  git(["config", "user.name", "Test"], base);
  git(["config", "user.email", "test@test.com"], base);
  writeFileSync(join(base, "README.md"), "# test\n");
  mkdirSync(join(base, ".gsd", "milestones", "M011"), { recursive: true });
  git(["add", "."], base);
  git(["commit", "-m", "init"], base);
  return base;
}

// ─── Bug 1: ASSESSMENT force-sync ─────────────────────────────────────────

describe("#2821 Bug 1 — ASSESSMENT file force-synced on resume", () => {
  let mainBase: string;
  let wtBase: string;

  beforeEach(() => {
    mainBase = mkdtempSync(join(tmpdir(), "gsd-2821-main-"));
    wtBase = mkdtempSync(join(tmpdir(), "gsd-2821-wt-"));
    mkdirSync(join(mainBase, ".gsd", "milestones", "M011", "slices", "S01"), {
      recursive: true,
    });
    mkdirSync(join(wtBase, ".gsd", "milestones", "M011", "slices", "S01"), {
      recursive: true,
    });
  });

  afterEach(() => {
    rmSync(mainBase, { recursive: true, force: true });
    rmSync(wtBase, { recursive: true, force: true });
  });

  test("force-syncs ASSESSMENT with verdict from project root into worktree when worktree copy has no verdict", () => {
    // Project root has ASSESSMENT with a PASS verdict (written by run-uat, synced by post-unit)
    const prAssessment = join(
      mainBase,
      ".gsd",
      "milestones",
      "M011",
      "slices",
      "S01",
      "S01-ASSESSMENT.md",
    );
    writeFileSync(
      prAssessment,
      "---\nverdict: pass\n---\n# S01 Assessment\nAll tests pass.\n",
    );

    // Worktree has a stale ASSESSMENT with FAIL verdict (from the initial run-uat execution)
    const wtAssessment = join(
      wtBase,
      ".gsd",
      "milestones",
      "M011",
      "slices",
      "S01",
      "S01-ASSESSMENT.md",
    );
    writeFileSync(
      wtAssessment,
      "---\nverdict: fail\n---\n# S01 Assessment\nSome tests fail.\n",
    );

    syncProjectRootToWorktree(mainBase, wtBase, "M011");

    // The worktree ASSESSMENT must now have the project root's PASS verdict
    const content = readFileSync(wtAssessment, "utf-8");
    assert.ok(
      content.includes("verdict: pass"),
      `Expected worktree ASSESSMENT to have verdict:pass after sync, got: ${content.slice(0, 100)}`,
    );
  });

  test("force-syncs ASSESSMENT from project root when worktree has no ASSESSMENT at all", () => {
    // Project root has ASSESSMENT with verdict
    const prAssessment = join(
      mainBase,
      ".gsd",
      "milestones",
      "M011",
      "slices",
      "S01",
      "S01-ASSESSMENT.md",
    );
    writeFileSync(
      prAssessment,
      "---\nverdict: pass\n---\n# S01 Assessment\n",
    );

    // Worktree has NO ASSESSMENT (deleted during DB rebuild)
    // — file simply doesn't exist

    syncProjectRootToWorktree(mainBase, wtBase, "M011");

    const wtAssessment = join(
      wtBase,
      ".gsd",
      "milestones",
      "M011",
      "slices",
      "S01",
      "S01-ASSESSMENT.md",
    );
    assert.ok(
      existsSync(wtAssessment),
      "ASSESSMENT should be copied to worktree when missing",
    );
    const content = readFileSync(wtAssessment, "utf-8");
    assert.ok(
      content.includes("verdict: pass"),
      `Synced ASSESSMENT should contain verdict:pass, got: ${content.slice(0, 100)}`,
    );
  });

  test("does NOT overwrite worktree ASSESSMENT when project root has no verdict", () => {
    // Project root has ASSESSMENT without verdict (incomplete)
    const prAssessment = join(
      mainBase,
      ".gsd",
      "milestones",
      "M011",
      "slices",
      "S01",
      "S01-ASSESSMENT.md",
    );
    writeFileSync(prAssessment, "# S01 Assessment\nIn progress...\n");

    // Worktree has ASSESSMENT with verdict:fail
    const wtAssessment = join(
      wtBase,
      ".gsd",
      "milestones",
      "M011",
      "slices",
      "S01",
      "S01-ASSESSMENT.md",
    );
    writeFileSync(
      wtAssessment,
      "---\nverdict: fail\n---\n# S01 Assessment\nSome tests fail.\n",
    );

    syncProjectRootToWorktree(mainBase, wtBase, "M011");

    // Worktree copy should NOT be overwritten by the verdictless project root copy
    const content = readFileSync(wtAssessment, "utf-8");
    assert.ok(
      content.includes("verdict: fail"),
      `Worktree ASSESSMENT should keep verdict:fail when project root has no verdict, got: ${content.slice(0, 100)}`,
    );
  });
});

// ─── Bug 2: Orphaned worktree cleanup ─────────────────────────────────────

describe("#2821 Bug 2 — removeWorktree cleans up despite untracked files", () => {
  let base: string;

  beforeEach(() => {
    base = makeBaseRepo();
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("removes worktree directory even when it contains untracked files", () => {
    const info = createWorktree(base, "M011", {
      branch: "milestone/M011",
    });

    // Simulate run-uat writing untracked files (S01-UAT-RESULT.md, ASSESSMENT)
    mkdirSync(
      join(info.path, ".gsd", "milestones", "M011", "slices", "S01"),
      { recursive: true },
    );
    writeFileSync(
      join(
        info.path,
        ".gsd",
        "milestones",
        "M011",
        "slices",
        "S01",
        "S01-UAT-RESULT.md",
      ),
      "# UAT Result\nverdict: fail\n",
    );
    writeFileSync(
      join(
        info.path,
        ".gsd",
        "milestones",
        "M011",
        "slices",
        "S01",
        "S01-ASSESSMENT.md",
      ),
      "---\nverdict: fail\n---\n# Assessment\n",
    );

    removeWorktree(base, "M011", {
      branch: "milestone/M011",
      deleteBranch: true,
      force: true,
    });

    const wtDir = worktreePath(base, "M011");
    assert.ok(
      !existsSync(wtDir),
      `Worktree directory should be removed after teardown, but still exists at ${wtDir}`,
    );
  });

  test("removes git internal worktree metadata after filesystem removal", () => {
    createWorktree(base, "M011", {
      branch: "milestone/M011",
    });

    removeWorktree(base, "M011", {
      branch: "milestone/M011",
      deleteBranch: true,
      force: true,
    });

    // The git internal worktree directory should be cleaned up
    const gitInternalWorktreeDir = join(base, ".git", "worktrees", "M011");
    assert.ok(
      !existsSync(gitInternalWorktreeDir),
      `Git internal worktree dir should be removed: ${gitInternalWorktreeDir}`,
    );

    // The branch should be deleted
    const branches = git(["branch"], base);
    assert.ok(
      !branches.includes("milestone/M011"),
      "milestone/M011 branch should be deleted after removeWorktree",
    );
  });
});
