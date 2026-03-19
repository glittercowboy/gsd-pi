/**
 * auto-worktree-fallback.test.ts — Tests for worktree fallback (#1339).
 *
 * Validates the scenario where a worktree does not contain the next queued
 * milestone, so dispatchNextUnit must fall back to the project root to
 * discover it after merging the completed milestone.
 *
 * Tests the core invariants the fix relies on:
 * 1. deriveState from a dir with only completed milestones returns phase "complete"
 * 2. deriveState from a dir with completed + queued returns the queued one as active
 * 3. mergeMilestoneToMain produces clean state for re-derive
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  createAutoWorktree,
  teardownAutoWorktree,
  isInAutoWorktree,
  mergeMilestoneToMain,
} from "../auto-worktree.ts";
import { deriveState } from "../state.ts";
import { invalidateAllCaches } from "../cache.ts";
import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, report } = createTestContext();

function run(command: string, cwd: string): string {
  return execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "auto-wt-fallback-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);
  return dir;
}

/**
 * Write a fully complete milestone (roadmap with all slices done + validation pass + summary).
 */
function writeCompleteMilestone(base: string, mid: string): void {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${mid}-ROADMAP.md`),
    `# ${mid}: Test Milestone\n\n**Vision:** Test.\n\n## Slices\n\n- [x] **S01: Done** \`risk:low\` \`depends:[]\`\n  > Done.\n`,
  );
  writeFileSync(
    join(dir, `${mid}-VALIDATION.md`),
    `---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation\nValidated.\n`,
  );
  writeFileSync(
    join(dir, `${mid}-SUMMARY.md`),
    `# ${mid} Summary\n\nMilestone complete.\n`,
  );
}

/**
 * Write a queued (not-yet-started) milestone with roadmap and context.
 */
function writeQueuedMilestone(base: string, mid: string): void {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${mid}-ROADMAP.md`),
    `# ${mid}: Next Milestone\n\n**Vision:** Next.\n\n## Slices\n\n- [ ] **S01: Pending** \`risk:low\` \`depends:[]\`\n  > Todo.\n`,
  );
  writeFileSync(
    join(dir, `${mid}-CONTEXT.md`),
    `# ${mid} Context\n\nContext for next milestone.\n`,
  );
}

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

async function main(): Promise<void> {
  const savedCwd = process.cwd();

  // ─── Test 1: all milestones complete → phase "complete" ────────────────
  // This is the state the worktree sees (M003 not present).
  // deriveState returns activeMilestone pointing to the last completed one,
  // but phase is "complete" — which triggers the milestone-complete handler.
  console.log("\n=== all complete → phase complete, activeMilestone is last entry ===");
  {
    const base = mkdtempSync(join(tmpdir(), "gsd-fallback-1-"));
    mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
    try {
      writeCompleteMilestone(base, "M001");
      writeCompleteMilestone(base, "M002");

      invalidateAllCaches();
      const state = await deriveState(base);
      assertEq(state.phase, "complete", "phase is complete when all milestones done");
      // activeMilestone is set to the last registry entry even when complete
      assertTrue(state.activeMilestone !== null, "activeMilestone is non-null (last entry)");
      const incomplete = state.registry.filter(m => m.status !== "complete");
      assertEq(incomplete.length, 0, "no incomplete milestones in registry");
    } finally {
      cleanup(base);
    }
  }

  // ─── Test 2: completed + queued → queued is active ─────────────────────
  // This is what the project root sees after M003 is added.
  console.log("\n=== completed + queued → queued milestone is active ===");
  {
    const base = mkdtempSync(join(tmpdir(), "gsd-fallback-2-"));
    mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
    try {
      writeCompleteMilestone(base, "M001");
      writeCompleteMilestone(base, "M002");
      writeQueuedMilestone(base, "M003");

      invalidateAllCaches();
      const state = await deriveState(base);
      assertEq(state.activeMilestone?.id, "M003", "M003 is the active milestone");
      assertTrue(
        state.registry.some(m => m.id === "M003" && m.status === "active"),
        "M003 is active in registry",
      );
      assertTrue(state.phase !== "complete", "phase is not complete when M003 is queued");
    } finally {
      cleanup(base);
    }
  }

  // ─── Test 3: key invariant — worktree misses milestone the root has ────
  // Creates a worktree from a repo with M001+M002 (both complete),
  // adds M003 to main AFTER worktree creation. The worktree won't see M003,
  // but re-deriving from the project root after teardown WILL find it.
  console.log("\n=== worktree misses M003, project root finds it ===");
  {
    let tempDir = "";
    try {
      tempDir = createTempRepo();

      // Commit M001 (complete) and M002 (complete) on main
      writeCompleteMilestone(tempDir, "M001");
      writeCompleteMilestone(tempDir, "M002");
      run("git add .", tempDir);
      run('git commit -m "add M001 M002"', tempDir);

      // Create worktree for M002
      const wtPath = createAutoWorktree(tempDir, "M002");
      assertTrue(existsSync(wtPath), "worktree created for M002");
      assertTrue(isInAutoWorktree(tempDir), "inside auto-worktree");

      // Worktree should NOT have M003
      assertTrue(
        !existsSync(join(wtPath, ".gsd", "milestones", "M003")),
        "M003 not in worktree",
      );

      // Teardown and go back to main
      teardownAutoWorktree(tempDir, "M002");
      process.chdir(tempDir);
      run("git checkout main", tempDir);

      // Add M003 on main
      writeQueuedMilestone(tempDir, "M003");
      run("git add .", tempDir);
      run('git commit -m "add M003"', tempDir);

      // Derive from project root — should find M003
      invalidateAllCaches();
      const rootState = await deriveState(tempDir);
      assertEq(rootState.activeMilestone?.id, "M003", "project root finds M003 after adding it");
    } finally {
      process.chdir(savedCwd);
      if (tempDir) cleanup(tempDir);
    }
  }

  // ─── Test 4: mergeMilestoneToMain leaves clean state ──────────────────
  console.log("\n=== merge-to-main produces clean state ===");
  {
    let tempDir = "";
    try {
      tempDir = createTempRepo();

      // Set up M002 with work
      const m002Dir = join(tempDir, ".gsd", "milestones", "M002");
      mkdirSync(m002Dir, { recursive: true });
      writeFileSync(
        join(m002Dir, "M002-ROADMAP.md"),
        "# M002: Work\n\n**Vision:** Work.\n\n## Slices\n\n- [x] **S01: Done** `risk:low` `depends:[]`\n  > Done.\n",
      );
      run("git add .", tempDir);
      run('git commit -m "add M002"', tempDir);

      // Create worktree, do work
      const wtPath = createAutoWorktree(tempDir, "M002");
      writeFileSync(join(wtPath, "feature.txt"), "new feature\n");
      run("git add .", wtPath);
      run('git commit -m "feature work"', wtPath);

      const roadmapContent = "# M002: Work\n\n**Vision:** Work.\n\n## Slices\n\n- [x] **S01: Done** `risk:low` `depends:[]`\n  > Done.\n";
      mergeMilestoneToMain(tempDir, "M002", roadmapContent);

      // Should be on main
      const branch = run("git branch --show-current", tempDir);
      assertEq(branch, "main", "on main after merge");

      // Worktree removed
      assertTrue(!existsSync(wtPath), "worktree removed after merge");

      // Feature file squash-merged
      assertTrue(existsSync(join(tempDir, "feature.txt")), "feature.txt on main after merge");

      // Can still derive state cleanly from project root
      invalidateAllCaches();
      const postMergeState = await deriveState(tempDir);
      assertTrue(postMergeState !== null, "deriveState works after merge");
    } finally {
      process.chdir(savedCwd);
      if (tempDir) cleanup(tempDir);
    }
  }

  report();
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
