/**
 * Tests for worktree edge-case bugfixes:
 *
 *   1. resolveGitDir() follows gitdir: pointer in worktrees
 *   2. captureIntegrationBranch() is a no-op in worktrees
 *   3. detectWorktreeName() correctly identifies worktree paths
 */

import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
  existsSync, readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { describe, it, after } from "node:test";
import assert from 'node:assert/strict';

import { resolveGitDir } from "../worktree-manager.ts";
import { detectWorktreeName, captureIntegrationBranch } from "../worktree.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

function run(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: "ignore" });
}

function initRepo(dir: string): void {
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  run("git commit --allow-empty -m init", dir);
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("worktree-bugfix", () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("resolveGitDir returns .git directory in normal repo", () => {
    const repo = mkdtempSync(join(tmpdir(), "gsd-wt-fix-"));
    dirs.push(repo);
    initRepo(repo);
    const gitDir = resolveGitDir(repo);
    assert.ok(gitDir.endsWith(".git"), "ends with .git");
    assert.ok(existsSync(gitDir), ".git dir exists");
  });

  it("resolveGitDir follows gitdir: pointer in worktree", () => {
    const repo = mkdtempSync(join(tmpdir(), "gsd-wt-fix-"));
    dirs.push(repo);
    initRepo(repo);

    // Simulate a worktree .git file (git worktree add creates these)
    const wtDir = mkdtempSync(join(tmpdir(), "gsd-wt-fix-wt-"));
    dirs.push(wtDir);
    const realGitDir = join(repo, ".git", "worktrees", "test-wt");
    mkdirSync(realGitDir, { recursive: true });
    writeFileSync(join(wtDir, ".git"), `gitdir: ${realGitDir}\n`);

    const resolved = resolveGitDir(wtDir);
    assert.deepStrictEqual(resolved, realGitDir, "resolves to real git dir");
  });

  it("resolveGitDir returns default when .git doesn't exist", () => {
    const noGit = mkdtempSync(join(tmpdir(), "gsd-wt-fix-"));
    dirs.push(noGit);
    const gitDir = resolveGitDir(noGit);
    assert.ok(gitDir.endsWith(".git"), "returns default .git path");
  });

  it("detectWorktreeName returns name for worktree path", () => {
    assert.deepStrictEqual(
      detectWorktreeName("/project/.gsd/worktrees/M005"),
      "M005",
      "detects worktree name",
    );
  });

  it("detectWorktreeName returns null for normal repo", () => {
    assert.deepStrictEqual(
      detectWorktreeName("/project"),
      null,
      "null for non-worktree path",
    );
  });

  it("captureIntegrationBranch is a no-op when in a worktree", () => {
    const repo = mkdtempSync(join(tmpdir(), "gsd-wt-fix-"));
    dirs.push(repo);
    initRepo(repo);

    // Create a fake worktree path structure
    const wtPath = join(repo, ".gsd", "worktrees", "M005");
    mkdirSync(wtPath, { recursive: true });
    mkdirSync(join(wtPath, ".gsd", "milestones", "M005"), { recursive: true });
    // Initialize git in the worktree so getService doesn't fail
    initRepo(wtPath);

    // captureIntegrationBranch should be a no-op — no META.json written
    const metaPath = join(wtPath, ".gsd", "milestones", "M005", "M005-META.json");
    captureIntegrationBranch(wtPath, "M005");
    assert.ok(!existsSync(metaPath), "no META.json written in worktree");
  });

  it("detectWorktreeName prevents pull in worktree context", () => {
    // Verifies the guard pattern: if detectWorktreeName returns non-null,
    // the caller should skip pull/fetch operations
    const inWorktree = detectWorktreeName("/project/.gsd/worktrees/M006");
    const inNormal = detectWorktreeName("/project");
    assert.ok(inWorktree !== null, "worktree detected → skip pull");
    assert.ok(inNormal === null, "normal repo → allow pull");
  });
});
