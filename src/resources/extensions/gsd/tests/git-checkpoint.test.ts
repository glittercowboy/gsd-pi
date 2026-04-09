// GSD2 — Regression tests for git-checkpoint rollback (#3576)
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createCheckpoint, rollbackToCheckpoint, cleanupCheckpoint } from "../safety/git-checkpoint.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ckpt-test-"));
  git(["init"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "file.txt"), "initial\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  git(["branch", "-M", "main"], dir);
  return dir;
}

describe("git-checkpoint rollback", () => {
  it("rolls back to checkpoint on checked-out branch", (t) => {
    const repo = createTempRepo();
    t.after(() => rmSync(repo, { recursive: true, force: true }));

    // Create checkpoint at initial commit
    const sha = createCheckpoint(repo, "unit-1");
    assert.ok(sha, "checkpoint should return a SHA");

    // Make a second commit
    writeFileSync(join(repo, "file.txt"), "modified\n");
    git(["add", "."], repo);
    git(["commit", "-m", "second"], repo);

    const headBefore = git(["rev-parse", "HEAD"], repo);
    assert.notEqual(headBefore, sha, "HEAD should have advanced");

    // Rollback — this must work on the checked-out branch
    const result = rollbackToCheckpoint(repo, "unit-1", sha);
    assert.equal(result, true, "rollback should succeed");

    const headAfter = git(["rev-parse", "HEAD"], repo);
    assert.equal(headAfter, sha, "HEAD should match checkpoint SHA after rollback");
  });

  it("returns false on detached HEAD", (t) => {
    const repo = createTempRepo();
    t.after(() => rmSync(repo, { recursive: true, force: true }));

    const sha = git(["rev-parse", "HEAD"], repo);
    git(["checkout", "--detach", sha], repo);

    const result = rollbackToCheckpoint(repo, "unit-2", sha);
    assert.equal(result, false, "rollback should fail on detached HEAD");
  });

  it("cleans up checkpoint ref after rollback", (t) => {
    const repo = createTempRepo();
    t.after(() => rmSync(repo, { recursive: true, force: true }));

    const sha = createCheckpoint(repo, "unit-3");
    assert.ok(sha);

    // Ref should exist
    const refBefore = git(["for-each-ref", "refs/gsd/checkpoints/unit-3", "--format=%(objectname)"], repo);
    assert.equal(refBefore, sha);

    rollbackToCheckpoint(repo, "unit-3", sha);

    // Ref should be cleaned up
    const refAfter = git(["for-each-ref", "refs/gsd/checkpoints/unit-3", "--format=%(objectname)"], repo);
    assert.equal(refAfter, "", "checkpoint ref should be removed after rollback");
  });

  it("cleanupCheckpoint removes the ref without error", (t) => {
    const repo = createTempRepo();
    t.after(() => rmSync(repo, { recursive: true, force: true }));

    const sha = createCheckpoint(repo, "unit-4");
    assert.ok(sha);

    cleanupCheckpoint(repo, "unit-4");

    const ref = git(["for-each-ref", "refs/gsd/checkpoints/unit-4", "--format=%(objectname)"], repo);
    assert.equal(ref, "", "ref should be gone");
  });
});
