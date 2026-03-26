/**
 * worktree-health.test.ts — Unit tests for worktree health status computation.
 *
 * Creates real temp git repos with GSD worktrees in various states and verifies
 * that getWorktreeHealth and formatWorktreeStatusLine return correct results.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { getWorktreeHealth, formatWorktreeStatusLine } from "../worktree-health.ts";
import { listWorktrees } from "../worktree-manager.ts";
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';


function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function createBaseRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-health-test-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);
  return dir;
}

describe('worktree-health', async () => {
  // Skip all tests on Windows — git worktree path resolution issues
  if (process.platform === "win32") {
    console.log("(all worktree-health tests skipped on Windows)");
    return;
  }

  const cleanups: string[] = [];

  try {
    // ─── Test: merged worktree is detected as merged + safe to remove ──
    console.log("\n=== worktree health: merged worktree ===");
    {
      const dir = createBaseRepo();
      cleanups.push(dir);

      mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b worktree/done-feature .gsd/worktrees/done-feature", dir);
      const wtPath = join(dir, ".gsd", "worktrees", "done-feature");
      writeFileSync(join(wtPath, "done.txt"), "done\n");
      run("git add -A", wtPath);
      run("git -c user.email=test@test.com -c user.name=Test commit -m \"done\"", wtPath);
      run("git merge worktree/done-feature --no-edit", dir);

      const worktrees = listWorktrees(dir);
      const wt = worktrees.find(w => w.name === "done-feature");
      assert.ok(!!wt, "worktree found");

      const health = getWorktreeHealth(dir, wt!);
      assert.ok(health.mergedIntoMain, "branch detected as merged");
      assert.ok(!health.dirty, "not dirty");
      assert.ok(health.safeToRemove, "safe to remove");

      const line = formatWorktreeStatusLine(health);
      assert.ok(line.includes("merged"), "status line mentions merged");
      assert.ok(line.includes("safe to remove"), "status line mentions safe to remove");
    }

    // ─── Test: unmerged worktree with dirty files ──────────────────────
    console.log("\n=== worktree health: dirty unmerged worktree ===");
    {
      const dir = createBaseRepo();
      cleanups.push(dir);

      mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b worktree/dirty-wip .gsd/worktrees/dirty-wip", dir);
      const wtPath = join(dir, ".gsd", "worktrees", "dirty-wip");
      // Make a commit so the branch diverges from main, then leave dirty state
      writeFileSync(join(wtPath, "committed.txt"), "committed\n");
      run("git add -A", wtPath);
      run("git -c user.email=test@test.com -c user.name=Test commit -m \"diverge\"", wtPath);
      // Now leave an uncommitted file
      writeFileSync(join(wtPath, "uncommitted.txt"), "wip\n");

      const worktrees = listWorktrees(dir);
      const wt = worktrees.find(w => w.name === "dirty-wip");
      assert.ok(!!wt, "worktree found");

      const health = getWorktreeHealth(dir, wt!);
      assert.ok(!health.mergedIntoMain, "not merged");
      assert.ok(health.dirty, "dirty detected");
      assert.ok(health.dirtyFileCount > 0, "dirty file count > 0");
      assert.ok(!health.safeToRemove, "not safe to remove");
    }

    // ─── Test: unmerged worktree with unpushed commits ─────────────────
    console.log("\n=== worktree health: unpushed commits ===");
    {
      const dir = createBaseRepo();
      cleanups.push(dir);

      mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b worktree/unpushed .gsd/worktrees/unpushed", dir);
      const wtPath = join(dir, ".gsd", "worktrees", "unpushed");
      writeFileSync(join(wtPath, "feature.txt"), "feature\n");
      run("git add -A", wtPath);
      run("git -c user.email=test@test.com -c user.name=Test commit -m \"feature\"", wtPath);

      const worktrees = listWorktrees(dir);
      const wt = worktrees.find(w => w.name === "unpushed");
      assert.ok(!!wt, "worktree found");

      const health = getWorktreeHealth(dir, wt!);
      assert.ok(!health.mergedIntoMain, "not merged");
      assert.ok(health.unpushedCommits > 0, "unpushed commits detected");
      assert.ok(!health.safeToRemove, "not safe to remove");
    }

    // ─── Test: stale detection with short threshold ────────────────────
    console.log("\n=== worktree health: stale detection ===");
    {
      const dir = createBaseRepo();
      cleanups.push(dir);

      mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b worktree/stale-test .gsd/worktrees/stale-test", dir);
      // Diverge from main so the branch is not "merged"
      const wtPath = join(dir, ".gsd", "worktrees", "stale-test");
      writeFileSync(join(wtPath, "stale.txt"), "stale\n");
      run("git add -A", wtPath);
      run("git -c user.email=test@test.com -c user.name=Test commit -m \"stale work\"", wtPath);

      const worktrees = listWorktrees(dir);
      const wt = worktrees.find(w => w.name === "stale-test");
      assert.ok(!!wt, "worktree found");

      // With staleDays=0, any worktree should be stale (commit was just now, but threshold is 0)
      // Actually, a just-created worktree has lastCommitAgeDays ~0 which is >= 0
      const health = getWorktreeHealth(dir, wt!, 0);
      assert.ok(health.stale, "stale with 0-day threshold");
      assert.ok(health.lastCommitAgeDays >= 0, "last commit age is non-negative");

      // With staleDays=9999, should NOT be stale
      const healthNotStale = getWorktreeHealth(dir, wt!, 9999);
      assert.ok(!healthNotStale.stale, "not stale with high threshold");
    }

    // ─── Test: formatWorktreeStatusLine for clean active worktree ──────
    console.log("\n=== worktree health: format clean active worktree ===");
    {
      const dir = createBaseRepo();
      cleanups.push(dir);

      mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b worktree/clean-active .gsd/worktrees/clean-active", dir);
      // Diverge from main so it's not "merged"
      const wtPath = join(dir, ".gsd", "worktrees", "clean-active");
      writeFileSync(join(wtPath, "active.txt"), "active\n");
      run("git add -A", wtPath);
      run("git -c user.email=test@test.com -c user.name=Test commit -m \"active work\"", wtPath);

      const worktrees = listWorktrees(dir);
      const wt = worktrees.find(w => w.name === "clean-active");
      assert.ok(!!wt, "worktree found");

      const health = getWorktreeHealth(dir, wt!, 9999); // high threshold so not stale
      const line = formatWorktreeStatusLine(health);
      // Should show last commit age since it's not merged and not stale
      assert.ok(line.includes("last commit"), "shows last commit age for active worktree");
    }

  } finally {
    for (const dir of cleanups) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});
