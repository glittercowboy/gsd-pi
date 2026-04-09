/**
 * gsdroot-worktree-detection.test.ts — Regression test for #2594.
 *
 * gsdRoot() must return the worktree's own .gsd directory when the basePath
 * is inside a .gsd/worktrees/<name>/ structure, not walk up to the project
 * root's .gsd via the git-root probe.
 *
 * The bug: when a git worktree lives at /project/.gsd/worktrees/M008/,
 * probeGsdRoot() runs `git rev-parse --show-toplevel` which can return the
 * main project root (not the worktree root) depending on git version and
 * worktree setup. The walk-up then finds /project/.gsd and returns that
 * instead of the worktree's own .gsd path.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { gsdRoot, _clearGsdRootCache } from "../paths.ts";

describe("gsdRoot() worktree detection (#2594)", () => {
  let projectRoot: string;
  let projectGsd: string;

  beforeEach(() => {
    _clearGsdRootCache();
    // Create a temporary project with a git repo to simulate real conditions.
    // realpathSync handles macOS /tmp -> /private/tmp.
    projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "gsdroot-wt-")));
    projectGsd = join(projectRoot, ".gsd");
    mkdirSync(projectGsd, { recursive: true });

    // Initialize a git repo in the project root so git rev-parse works
    spawnSync("git", ["init", "--initial-branch=main"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    spawnSync("git", ["config", "user.email", "test@test.com"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    spawnSync("git", ["config", "user.name", "Test"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    // Create an initial commit so we have a HEAD
    writeFileSync(join(projectRoot, "README.md"), "# Test");
    spawnSync("git", ["add", "."], { cwd: projectRoot, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "init"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
  });

  afterEach(() => {
    _clearGsdRootCache();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test("returns worktree .gsd when basePath is a worktree with its own .gsd (fast path)", () => {
    // Simulates a worktree that already had copyPlanningArtifacts() run,
    // so it has its own .gsd/ directory.
    const worktreeBase = join(projectGsd, "worktrees", "M008");
    const worktreeGsd = join(worktreeBase, ".gsd");
    mkdirSync(worktreeGsd, { recursive: true });

    const result = gsdRoot(worktreeBase);
    assert.equal(
      result,
      worktreeGsd,
      `Expected worktree .gsd (${worktreeGsd}), got ${result}. ` +
        "gsdRoot() should use the fast path for an existing worktree .gsd.",
    );
  });

  test("returns worktree .gsd path (not project root .gsd) when worktree .gsd does not exist yet", () => {
    // This is the core #2594 bug: the worktree directory exists but its .gsd
    // subdirectory hasn't been created yet. Without the fix, probeGsdRoot()
    // walks up from the worktree path, finds /project/.gsd, and returns it.
    // With the fix, it detects the .gsd/worktrees/<name>/ pattern and returns
    // the worktree-local .gsd path as the creation fallback.
    const worktreeBase = join(projectGsd, "worktrees", "M008");
    mkdirSync(worktreeBase, { recursive: true });
    // NOTE: no .gsd/ inside worktreeBase

    const result = gsdRoot(worktreeBase);
    const expected = join(worktreeBase, ".gsd");

    // Without the fix, this returns projectGsd (/project/.gsd) because the
    // walk-up from worktreeBase finds it. With the fix, it returns the
    // worktree-local path.
    assert.notEqual(
      result,
      projectGsd,
      "gsdRoot() must NOT return the project root .gsd when basePath is inside .gsd/worktrees/",
    );
    assert.equal(
      result,
      expected,
      `Expected worktree-local .gsd (${expected}), got ${result}.`,
    );
  });

  test("returns worktree .gsd when basePath is a real git worktree inside .gsd/worktrees/", () => {
    // Create a real git worktree at .gsd/worktrees/M010
    const worktreeName = "M010";
    const worktreeBase = join(projectGsd, "worktrees", worktreeName);

    // Use git worktree add to create a real worktree
    const result = spawnSync(
      "git",
      ["worktree", "add", "-b", `milestone/${worktreeName}`, worktreeBase],
      { cwd: projectRoot, encoding: "utf-8" },
    );

    if (result.status !== 0) {
      // If git worktree add fails, skip the test gracefully
      assert.ok(true, "Skipped: git worktree add not available");
      return;
    }

    // The real git worktree exists at worktreeBase but has NO .gsd/ subdir yet
    const gsdResult = gsdRoot(worktreeBase);
    const expected = join(worktreeBase, ".gsd");

    assert.notEqual(
      gsdResult,
      projectGsd,
      "gsdRoot() must NOT escape to project root .gsd from inside a git worktree",
    );
    assert.equal(
      gsdResult,
      expected,
      `Expected worktree-local .gsd (${expected}), got ${gsdResult}`,
    );

    // Cleanup worktree
    spawnSync("git", ["worktree", "remove", "--force", worktreeBase], {
      cwd: projectRoot,
      stdio: "ignore",
    });
  });

  test("still returns project .gsd for normal (non-worktree) basePath", () => {
    const result = gsdRoot(projectRoot);
    assert.equal(result, projectGsd);
  });

  test("still returns project .gsd for a subdirectory of the project", () => {
    const subdir = join(projectRoot, "src", "lib");
    mkdirSync(subdir, { recursive: true });

    const result = gsdRoot(subdir);
    assert.equal(
      result,
      projectGsd,
      "Non-worktree subdirectories should still resolve to project .gsd",
    );
  });
});
