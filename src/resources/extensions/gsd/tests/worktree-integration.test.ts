/**
 * Worktree Integration Tests
 *
 * Tests the full lifecycle of GSD operations inside a worktree:
 * - Branch namespacing (gsd/<wt>/<M>/<S> instead of gsd/<M>/<S>)
 * - getMainBranch returns worktree/<name> inside a worktree
 * - Parallel worktrees don't conflict on branch names
 * - State derivation works correctly inside worktrees
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  createWorktree,
  listWorktrees,
  removeWorktree,
} from "../worktree-manager.ts";

import {
  detectWorktreeName,
  getCurrentBranch,
  getMainBranch,
  getSliceBranchName,
  autoCommitCurrentBranch,
  SLICE_BRANCH_RE,
  _resetServiceCache,
} from "../worktree.ts";

import { deriveState } from "../state.ts";
import { _clearGsdRootCache } from "../paths.ts";
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

function run(command: string, cwd: string): string {
  return execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

// ─── Test repo setup ──────────────────────────────────────────────────────────

const base = mkdtempSync(join(tmpdir(), "gsd-wt-integration-"));
run("git init -b main", base);
run("git config user.name 'Pi Test'", base);
run("git config user.email 'pi@example.com'", base);

// Create a project with one milestone and two slices
mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S02", "tasks"), { recursive: true });
writeFileSync(join(base, "README.md"), "# Test Project\n", "utf-8");
writeFileSync(
  join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
  [
    "# M001: Demo",
    "",
    "## Slices",
    "- [ ] **S01: First** `risk:low` `depends:[]`",
    "  > After this: part one works",
    "- [ ] **S02: Second** `risk:low` `depends:[]`",
    "  > After this: part two works",
  ].join("\n") + "\n",
  "utf-8",
);
writeFileSync(
  join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
  "# S01: First\n\n**Goal:** Demo\n**Demo:** Demo\n\n## Must-Haves\n- done\n\n## Tasks\n- [ ] **T01: Implement** `est:10m`\n  do it\n",
  "utf-8",
);
writeFileSync(
  join(base, ".gsd", "milestones", "M001", "slices", "S02", "S02-PLAN.md"),
  "# S02: Second\n\n**Goal:** Demo\n**Demo:** Demo\n\n## Must-Haves\n- done\n\n## Tasks\n- [ ] **T01: Implement** `est:10m`\n  do it\n",
  "utf-8",
);
run("git add .", base);
run('git commit -m "chore: init"', base);

describe('worktree-integration', async () => {
  // Isolate from user's global preferences (which may have git.main_branch set).
  // Reset caches so getService() creates a fresh instance with empty preferences.
  const originalHome = process.env.HOME;
  const fakeHome = mkdtempSync(join(tmpdir(), "gsd-fake-home-"));
  process.env.HOME = fakeHome;
  _clearGsdRootCache();
  _resetServiceCache();

  // ── Verify main tree baseline ──────────────────────────────────────────────

  console.log("\n=== Main tree baseline ===");
  assert.deepStrictEqual(getMainBranch(base), "main", "main tree getMainBranch returns main");
  assert.deepStrictEqual(detectWorktreeName(base), null, "main tree not detected as worktree");

  // ── Create worktree and verify detection ───────────────────────────────────

  console.log("\n=== Create worktree ===");
  const wt = createWorktree(base, "alpha");
  assert.ok(existsSync(wt.path), "worktree created on disk");
  assert.deepStrictEqual(wt.branch, "worktree/alpha", "worktree branch name");

  console.log("\n=== Worktree detection ===");
  assert.deepStrictEqual(detectWorktreeName(wt.path), "alpha", "detectWorktreeName inside worktree");
  assert.deepStrictEqual(getMainBranch(wt.path), "worktree/alpha", "getMainBranch returns worktree branch inside worktree");

  // ── Verify current branch inside worktree ──────────────────────────────────

  console.log("\n=== Worktree initial branch ===");
  assert.deepStrictEqual(getCurrentBranch(wt.path), "worktree/alpha", "worktree starts on its own branch");

  // ── Verify branch name helper ──────────────────────────────────────────────

  console.log("\n=== getSliceBranchName with worktree ===");
  assert.deepStrictEqual(getSliceBranchName("M001", "S01", "alpha"), "gsd/alpha/M001/S01", "explicit worktree param");
  assert.deepStrictEqual(getSliceBranchName("M001", "S01"), "gsd/M001/S01", "no worktree param = plain branch");

  // ── Slice branch creation and detection inside worktree ────────────────────

  console.log("\n=== Slice branch in worktree ===");
  const sliceBranch = getSliceBranchName("M001", "S01", "alpha");
  run(`git checkout -b ${sliceBranch}`, wt.path);
  assert.deepStrictEqual(getCurrentBranch(wt.path), "gsd/alpha/M001/S01", "worktree-namespaced slice branch");
  assert.ok(SLICE_BRANCH_RE.test(getCurrentBranch(wt.path)), "slice branch regex matches namespaced branch");

  // ── Do work on slice branch, then merge to worktree branch ─────────────────

  console.log("\n=== Work and merge slice in worktree ===");
  writeFileSync(join(wt.path, "feature.txt"), "new feature\n", "utf-8");
  run("git add .", wt.path);
  run('git commit -m "feat: add feature"', wt.path);

  // Checkout worktree base branch and merge slice branch
  run("git checkout worktree/alpha", wt.path);
  assert.deepStrictEqual(getCurrentBranch(wt.path), "worktree/alpha", "back on worktree branch");

  run(`git merge --no-ff ${sliceBranch} -m "feat(M001/S01): First"`, wt.path);
  run(`git branch -d ${sliceBranch}`, wt.path);
  assert.deepStrictEqual(getCurrentBranch(wt.path), "worktree/alpha", "still on worktree branch after merge");
  assert.ok(readFileSync(join(wt.path, "feature.txt"), "utf-8").includes("new feature"), "merge brought feature to worktree branch");

  // Verify slice branch is gone
  const branches = run("git branch", base);
  assert.ok(!branches.includes("gsd/alpha/M001/S01"), "slice branch cleaned up");

  // ── Second slice in same worktree ──────────────────────────────────────────

  console.log("\n=== Second slice in worktree ===");
  const sliceBranch2 = getSliceBranchName("M001", "S02", "alpha");
  run(`git checkout -b ${sliceBranch2}`, wt.path);
  assert.deepStrictEqual(getCurrentBranch(wt.path), "gsd/alpha/M001/S02", "on S02 namespaced branch");

  writeFileSync(join(wt.path, "feature2.txt"), "second feature\n", "utf-8");
  run("git add .", wt.path);
  run('git commit -m "feat: add feature 2"', wt.path);

  run("git checkout worktree/alpha", wt.path);
  run(`git merge --no-ff ${sliceBranch2} -m "feat(M001/S02): Second"`, wt.path);
  run(`git branch -d ${sliceBranch2}`, wt.path);
  assert.deepStrictEqual(getCurrentBranch(wt.path), "worktree/alpha", "back on worktree branch");

  // ── Parallel worktrees don't conflict ──────────────────────────────────────

  console.log("\n=== Parallel worktrees ===");
  const wt2 = createWorktree(base, "beta");
  assert.deepStrictEqual(getMainBranch(wt2.path), "worktree/beta", "second worktree has its own base branch");

  // Both worktrees can create S01 branches without conflict
  const betaBranch = getSliceBranchName("M001", "S01", "beta");
  run(`git checkout -b ${betaBranch}`, wt2.path);
  assert.deepStrictEqual(getCurrentBranch(wt2.path), "gsd/beta/M001/S01", "beta has its own namespaced branch");

  // Alpha worktree can re-create S01 too (it was already merged+deleted earlier)
  const alphaReBranch = getSliceBranchName("M001", "S01", "alpha");
  run(`git checkout -b ${alphaReBranch}`, wt.path);
  assert.deepStrictEqual(getCurrentBranch(wt.path), "gsd/alpha/M001/S01", "alpha re-created S01");

  // Both exist simultaneously
  const allBranches = run("git branch", base);
  assert.ok(allBranches.includes("gsd/alpha/M001/S01"), "alpha S01 branch exists");
  assert.ok(allBranches.includes("gsd/beta/M001/S01"), "beta S01 branch exists");

  // ── State derivation in worktree ───────────────────────────────────────────

  console.log("\n=== State derivation in worktree ===");
  // Switch alpha back to its base so deriveState sees milestone files
  run("git checkout worktree/alpha", wt.path);
  const state = await deriveState(wt.path);
  assert.ok(state.activeMilestone !== null, "worktree has active milestone");
  assert.deepStrictEqual(state.activeMilestone?.id, "M001", "correct milestone");

  // ── autoCommitCurrentBranch in worktree ────────────────────────────────────

  console.log("\n=== autoCommitCurrentBranch in worktree ===");
  // Re-checkout the beta slice branch
  run(`git checkout ${betaBranch}`, wt2.path);
  writeFileSync(join(wt2.path, "dirty.txt"), "uncommitted\n", "utf-8");
  const commitMsg = autoCommitCurrentBranch(wt2.path, "execute-task", "M001/S01/T01");
  assert.ok(commitMsg !== null, "auto-commit works in worktree");
  assert.deepStrictEqual(run("git status --short", wt2.path), "", "worktree clean after auto-commit");

  // ── Cleanup ────────────────────────────────────────────────────────────────

  console.log("\n=== Cleanup ===");
  // Switch worktrees back to their base branches before removal
  run("git checkout worktree/alpha", wt.path);
  run("git checkout worktree/beta", wt2.path);
  removeWorktree(base, "alpha", { deleteBranch: true });
  removeWorktree(base, "beta", { deleteBranch: true });
  assert.deepStrictEqual(listWorktrees(base).length, 0, "all worktrees removed");

  rmSync(base, { recursive: true, force: true });

  // Restore HOME and reset caches
  process.env.HOME = originalHome;
  _clearGsdRootCache();
  _resetServiceCache();
  rmSync(fakeHome, { recursive: true, force: true });
});
