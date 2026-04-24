/**
 * Tests for slice-cadence collapse — #4765.
 *
 * Covers mergeSliceToMain (squash + advance), resquashMilestoneOnMain,
 * and the preference accessors.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import {
  mergeSliceToMain,
  resquashMilestoneOnMain,
  getCollapseCadence,
  getMilestoneResquash,
} from "../slice-cadence.ts";
import { MergeConflictError } from "../git-service.ts";
import { summarizeWorktreeTelemetry } from "../worktree-telemetry.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

/** Create a temp git repo with an initial commit on main. */
function createRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "slice-cad-test-")));
  git(["init"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  git(["branch", "-M", "main"], dir);
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  return dir;
}

function enterMilestoneBranch(dir: string, milestoneId: string): void {
  git(["checkout", "-b", `milestone/${milestoneId}`], dir);
}

function commitFile(dir: string, file: string, content: string, msg: string): string {
  writeFileSync(join(dir, file), content);
  git(["add", "."], dir);
  git(["commit", "-m", msg], dir);
  return git(["rev-parse", "HEAD"], dir);
}

describe("getCollapseCadence / getMilestoneResquash", () => {
  test("defaults to milestone cadence", () => {
    assert.equal(getCollapseCadence(undefined), "milestone");
    assert.equal(getCollapseCadence(null), "milestone");
    assert.equal(getCollapseCadence({}), "milestone");
    assert.equal(getCollapseCadence({ git: {} }), "milestone");
  });
  test("reads slice cadence when set", () => {
    assert.equal(getCollapseCadence({ git: { collapse_cadence: "slice" } }), "slice");
  });
  test("milestone_resquash defaults to true when not set", () => {
    assert.equal(getMilestoneResquash(undefined), true);
    assert.equal(getMilestoneResquash({ git: {} }), true);
    assert.equal(getMilestoneResquash({ git: { milestone_resquash: true } }), true);
  });
  test("milestone_resquash can be disabled explicitly", () => {
    assert.equal(getMilestoneResquash({ git: { milestone_resquash: false } }), false);
  });
});

describe("mergeSliceToMain", () => {
  let dir: string;
  let originalCwd: string;

  beforeEach(() => {
    dir = createRepo();
    originalCwd = process.cwd();
  });

  afterEach(() => {
    try { process.chdir(originalCwd); } catch { /* */ }
    rmSync(dir, { recursive: true, force: true });
  });

  test("squashes one slice's commits onto main and advances the milestone branch", () => {
    enterMilestoneBranch(dir, "M001");
    commitFile(dir, "feature.txt", "slice 1 work\n", "feat: S01 work");

    process.chdir(dir);
    const result = mergeSliceToMain(dir, "M001", "S01");

    assert.equal(result.skipped, false);
    assert.ok(result.commitSha, "expected a commit SHA");
    assert.equal(result.milestoneBranch, "milestone/M001");
    assert.equal(result.mainBranch, "main");

    const mainLog = git(["log", "main", "--oneline"], dir);
    assert.ok(mainLog.includes("S01 of M001 (slice-cadence)"), `main log: ${mainLog}`);
    assert.equal(readFileSync(join(dir, "feature.txt"), "utf-8"), "slice 1 work\n");

    const mainSha = git(["rev-parse", "main"], dir);
    const milestoneSha = git(["rev-parse", "milestone/M001"], dir);
    assert.equal(milestoneSha, mainSha, "milestone branch must be advanced to main");

    const summary = summarizeWorktreeTelemetry(dir);
    assert.equal(summary.slicesMerged, 1);
    assert.equal(summary.sliceMergeConflicts, 0);
  });

  test("handles sequential slice merges cleanly", () => {
    enterMilestoneBranch(dir, "M001");
    commitFile(dir, "a.txt", "slice 1\n", "feat: S01");

    process.chdir(dir);
    mergeSliceToMain(dir, "M001", "S01");

    git(["checkout", "milestone/M001"], dir);
    commitFile(dir, "b.txt", "slice 2\n", "feat: S02");

    const result = mergeSliceToMain(dir, "M001", "S02");
    assert.equal(result.skipped, false);

    const mainLog = git(["log", "main", "--oneline"], dir);
    assert.ok(mainLog.includes("S01 of M001"));
    assert.ok(mainLog.includes("S02 of M001"));

    assert.equal(readFileSync(join(dir, "a.txt"), "utf-8"), "slice 1\n");
    assert.equal(readFileSync(join(dir, "b.txt"), "utf-8"), "slice 2\n");

    const summary = summarizeWorktreeTelemetry(dir);
    assert.equal(summary.slicesMerged, 2);
  });

  test("returns skipped when milestone branch has no commits ahead of main", () => {
    enterMilestoneBranch(dir, "M001");

    process.chdir(dir);
    const result = mergeSliceToMain(dir, "M001", "S01");

    assert.equal(result.skipped, true);
    assert.equal(result.skippedReason, "no-commits-ahead");
    assert.equal(result.commitSha, null);
  });

  test("throws MergeConflictError on a real conflict and leaves no merge artifacts", () => {
    writeFileSync(join(dir, "shared.txt"), "main version\n");
    git(["add", "."], dir);
    git(["commit", "-m", "main-seed"], dir);

    enterMilestoneBranch(dir, "M001");
    commitFile(dir, "shared.txt", "slice version\n", "feat: S01 conflicting");

    git(["checkout", "main"], dir);
    commitFile(dir, "shared.txt", "main evolved\n", "main evolved");
    git(["checkout", "milestone/M001"], dir);

    process.chdir(dir);
    assert.throws(
      () => mergeSliceToMain(dir, "M001", "S01"),
      (err: unknown) => err instanceof MergeConflictError,
    );

    const gitDir = join(dir, ".git");
    for (const f of ["SQUASH_MSG", "MERGE_MSG", "MERGE_HEAD"]) {
      assert.ok(!existsSync(join(gitDir, f)), `${f} should be cleaned up`);
    }

    const summary = summarizeWorktreeTelemetry(dir);
    assert.equal(summary.sliceMergeConflicts, 1);
  });

  test("restores cwd even when merge fails (dirty working tree)", () => {
    enterMilestoneBranch(dir, "M001");
    commitFile(dir, "feature.txt", "slice 1\n", "feat: S01");
    // Introduce an untracked file AFTER the slice commit so it's still
    // present when mergeSliceToMain runs its status check.
    writeFileSync(join(dir, "dirty.txt"), "uncommitted\n");

    process.chdir(dir);
    const cwdBefore = process.cwd();
    assert.throws(() => mergeSliceToMain(dir, "M001", "S01"));
    assert.equal(process.cwd(), cwdBefore, "cwd must be restored on failure");
  });
});

describe("resquashMilestoneOnMain", () => {
  let dir: string;
  let originalCwd: string;

  beforeEach(() => {
    dir = createRepo();
    originalCwd = process.cwd();
  });

  afterEach(() => {
    try { process.chdir(originalCwd); } catch { /* */ }
    rmSync(dir, { recursive: true, force: true });
  });

  test("collapses N slice commits on main into one milestone commit", () => {
    const startSha = git(["rev-parse", "main"], dir);

    enterMilestoneBranch(dir, "M001");
    commitFile(dir, "a.txt", "slice 1\n", "feat: S01");
    process.chdir(dir);
    mergeSliceToMain(dir, "M001", "S01");

    git(["checkout", "milestone/M001"], dir);
    commitFile(dir, "b.txt", "slice 2\n", "feat: S02");
    mergeSliceToMain(dir, "M001", "S02");

    const beforeCount = parseInt(git(["rev-list", "--count", `${startSha}..main`], dir), 10);
    assert.equal(beforeCount, 2);

    const result = resquashMilestoneOnMain(dir, "M001", startSha);
    assert.equal(result.resquashed, true);
    assert.ok(result.newSha);

    git(["checkout", "main"], dir);
    const afterCount = parseInt(git(["rev-list", "--count", `${startSha}..main`], dir), 10);
    assert.equal(afterCount, 1, "slice commits collapsed into one milestone commit");

    const msg = git(["log", "-1", "--format=%s", "main"], dir);
    assert.ok(msg.includes("M001") && msg.includes("2 slices"), `commit message should describe the resquash; got: ${msg}`);

    assert.equal(readFileSync(join(dir, "a.txt"), "utf-8"), "slice 1\n");
    assert.equal(readFileSync(join(dir, "b.txt"), "utf-8"), "slice 2\n");

    const summary = summarizeWorktreeTelemetry(dir);
    assert.equal(summary.milestoneResquashes, 1);
  });

  test("no-op when startSha equals HEAD", () => {
    const startSha = git(["rev-parse", "main"], dir);
    process.chdir(dir);
    const result = resquashMilestoneOnMain(dir, "M001", startSha);
    assert.equal(result.resquashed, false);
    assert.equal(result.newSha, null);
  });
});
