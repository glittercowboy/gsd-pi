/**
 * auto-worktree.test.ts — Tests for auto-worktree lifecycle.
 *
 * Covers: create → detect → teardown, re-entry, path helpers.
 * Runs in a real temp git repo.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  createAutoWorktree,
  teardownAutoWorktree,
  isInAutoWorktree,
  getAutoWorktreePath,
  enterAutoWorktree,
  getAutoWorktreeOriginalBase,
  getActiveAutoWorktreeContext,
} from "../auto-worktree.ts";

import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, report } = createTestContext();

function run(command: string, cwd: string): string {
  return execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "auto-wt-test-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  // Create initial commit on main
  writeFileSync(join(dir, "README.md"), "# test\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  // Ensure branch is called main
  run("git branch -M main", dir);
  return dir;
}

async function main(): Promise<void> {
  const savedCwd = process.cwd();
  let tempDir = "";

  try {
    tempDir = createTempRepo();

    // Create .gsd/milestones/M003 with a dummy file (simulates planning artifacts)
    const msDir = join(tempDir, ".gsd", "milestones", "M003");
    mkdirSync(msDir, { recursive: true });
    writeFileSync(join(msDir, "CONTEXT.md"), "# M003 Context\n");
    run("git add .", tempDir);
    run("git commit -m \"add milestone\"", tempDir);

    console.log("\n=== auto-worktree lifecycle ===");

    // ─── createAutoWorktree ──────────────────────────────────────────
    const wtPath = createAutoWorktree(tempDir, "M003");

    assertTrue(existsSync(wtPath), "worktree directory exists after create");
    assertEq(process.cwd(), wtPath, "process.cwd() is worktree path after create");

    const branch = run("git branch --show-current", wtPath);
    assertEq(branch, "milestone/M003", "git branch is milestone/M003");

    assertTrue(
      existsSync(join(wtPath, ".gsd", "milestones", "M003", "CONTEXT.md")),
      "planning files inherited in worktree",
    );

    // ─── isInAutoWorktree ────────────────────────────────────────────
    assertTrue(isInAutoWorktree(tempDir), "isInAutoWorktree returns true when inside");

    // ─── getAutoWorktreeOriginalBase ─────────────────────────────────
    assertEq(getAutoWorktreeOriginalBase(), tempDir, "originalBase returns temp dir");
    assertEq(
      getActiveAutoWorktreeContext(),
      {
        originalBase: tempDir,
        worktreeName: "M003",
        branch: "milestone/M003",
      },
      "active auto-worktree context reflects the worktree cwd",
    );

    // ─── getAutoWorktreePath ─────────────────────────────────────────
    assertEq(getAutoWorktreePath(tempDir, "M003"), wtPath, "getAutoWorktreePath returns correct path");
    assertEq(getAutoWorktreePath(tempDir, "M999"), null, "getAutoWorktreePath returns null for nonexistent");

    // ─── teardownAutoWorktree ────────────────────────────────────────
    teardownAutoWorktree(tempDir, "M003");

    assertEq(process.cwd(), tempDir, "process.cwd() back to original after teardown");
    assertTrue(!existsSync(wtPath), "worktree directory removed after teardown");
    assertTrue(!isInAutoWorktree(tempDir), "isInAutoWorktree returns false after teardown");
    assertEq(getAutoWorktreeOriginalBase(), null, "originalBase is null after teardown");
    assertEq(getActiveAutoWorktreeContext(), null, "active auto-worktree context clears after teardown");

    // ─── Re-entry: create again, exit without teardown, re-enter ─────
    console.log("\n=== re-entry ===");

    const wtPath2 = createAutoWorktree(tempDir, "M003");
    assertTrue(existsSync(wtPath2), "worktree re-created");

    // Manually chdir out (simulates pause/crash)
    process.chdir(tempDir);

    // enterAutoWorktree should re-enter
    const entered = enterAutoWorktree(tempDir, "M003");
    assertEq(process.cwd(), entered, "re-entered worktree via enterAutoWorktree");
    assertEq(getAutoWorktreeOriginalBase(), tempDir, "originalBase restored on re-entry");
    assertTrue(isInAutoWorktree(tempDir), "isInAutoWorktree true after re-entry");
    assertEq(
      getActiveAutoWorktreeContext(),
      {
        originalBase: tempDir,
        worktreeName: "M003",
        branch: "milestone/M003",
      },
      "active auto-worktree context is restored on re-entry",
    );

    // Cleanup
    teardownAutoWorktree(tempDir, "M003");

    // ─── Coexistence with manual worktree ─────────────────────────────
    console.log("\n=== coexistence ===");

    // Import createWorktree directly for manual worktree
    const { createWorktree } = await import("../worktree-manager.ts");

    // Create manual worktree (uses worktree/<name> branch)
    const manualWt = createWorktree(tempDir, "feature-x");
    assertTrue(existsSync(manualWt.path), "manual worktree exists");
    assertEq(manualWt.branch, "worktree/feature-x", "manual worktree uses worktree/ prefix");

    // Create auto-worktree alongside
    const autoWtPath = createAutoWorktree(tempDir, "M003");
    assertTrue(existsSync(autoWtPath), "auto-worktree coexists with manual");
    assertTrue(existsSync(manualWt.path), "manual worktree still exists");

    // Cleanup both
    teardownAutoWorktree(tempDir, "M003");
    const { removeWorktree } = await import("../worktree-manager.ts");
    removeWorktree(tempDir, "feature-x");

    // ─── Failure: split-brain prevention ──────────────────────────────
    console.log("\n=== split-brain prevention ===");
    // After teardown, originalBase should be null
    assertEq(getAutoWorktreeOriginalBase(), null, "no split-brain: originalBase cleared");

    // ─── #1526: getMainBranch returns milestone branch in auto-worktree ──
    console.log("\n=== #1526: getMainBranch() returns milestone/<MID> in auto-worktree ===");
    {
      const { GitServiceImpl } = await import("../git-service.ts");

      // Create worktree
      const wtPath = createAutoWorktree(tempDir, "M005");
      // Don't set main_branch pref so getMainBranch falls through to worktree detection
      const gitService = new GitServiceImpl(wtPath);
      gitService.setMilestoneId("M005");

      // Verify getMainBranch returns the milestone branch
      const mainBranch = gitService.getMainBranch();
      assertEq(mainBranch, "milestone/M005", "getMainBranch returns milestone/<MID> in auto-worktree");

      // Cleanup
      teardownAutoWorktree(tempDir, "M005");
    }

    // ─── #1713: stale worktree directory recovery ─────────────────────
    console.log("\n=== #1713: stale worktree directory without .git file ===");
    {
      // Simulate a crash leaving a stale directory with no .git file.
      // createAutoWorktree should detect and remove the stale directory,
      // then successfully create a fresh worktree.
      const { worktreePath } = await import("../worktree-manager.ts");
      const staleDir = worktreePath(tempDir, "M010");
      mkdirSync(staleDir, { recursive: true });
      // Write a dummy file to prove it's not an empty directory
      writeFileSync(join(staleDir, "orphan.txt"), "stale leftover\n");
      assertTrue(existsSync(staleDir), "stale directory exists before recovery");
      assertTrue(!existsSync(join(staleDir, ".git")), "stale directory has no .git file");

      // createAutoWorktree should remove the stale dir and create a real worktree
      const recoveredPath = createAutoWorktree(tempDir, "M010");
      assertTrue(existsSync(recoveredPath), "worktree created after stale dir recovery");
      assertTrue(existsSync(join(recoveredPath, ".git")), "recovered worktree has .git file");
      assertTrue(!existsSync(join(recoveredPath, "orphan.txt")), "stale file removed by recovery");

      teardownAutoWorktree(tempDir, "M010");
    }

    // ─── #778: reconcile plan checkboxes on re-attach ─────────────────
    console.log("\n=== #778: reconcile plan checkboxes on re-attach ===");
    {
      // Simulate: T01 [x] was committed to milestone branch, T02 [x] was
      // written to project root by syncStateToProjectRoot() but the
      // auto-commit crashed before it fired. On restart the worktree is
      // re-created from the milestone branch HEAD (T02 still [ ]).
      // reconcilePlanCheckboxes should forward-apply T02 [x] from the root.

      const planRelPath = join(".gsd", "milestones", "M004", "slices", "S01", "S01-PLAN.md");
      const planDir = join(tempDir, ".gsd", "milestones", "M004", "slices", "S01");
      const { mkdirSync: mkdir, writeFileSync: write, readFileSync: read } = await import("node:fs");

      // Plan on integration branch (project root): T01 [x], T02 [x]
      mkdir(planDir, { recursive: true });
      write(
        join(tempDir, planRelPath),
        "# S01 Plan\n- [x] **T01:** task one\n- [x] **T02:** task two\n- [ ] **T03:** task three\n",
      );

      // Write integration-branch plan to git so milestone branch starts from it
      run(`git add .`, tempDir);
      run(`git commit -m "add plan with T01 and T02 checked" --allow-empty`, tempDir);

      // Create milestone branch with only T01 [x] (simulating crash before T02 commit)
      const milestoneBranch = "milestone/M004";
      run(`git checkout -b ${milestoneBranch}`, tempDir);
      mkdir(planDir, { recursive: true });
      write(
        join(tempDir, planRelPath),
        "# S01 Plan\n- [x] **T01:** task one\n- [ ] **T02:** task two\n- [ ] **T03:** task three\n",
      );
      run(`git add .`, tempDir);
      run(`git commit -m "milestone: only T01 checked"`, tempDir);
      run(`git checkout main`, tempDir);

      // Restore project root plan (T01+T02 [x]) — simulates syncStateToProjectRoot
      write(
        join(tempDir, planRelPath),
        "# S01 Plan\n- [x] **T01:** task one\n- [x] **T02:** task two\n- [ ] **T03:** task three\n",
      );

      // Create worktree re-attached to existing milestone branch (T02 still [ ] in branch)
      const wtPath = createAutoWorktree(tempDir, "M004");

      try {
        const wtPlanPath = join(wtPath, planRelPath);
        assertTrue(existsSync(wtPlanPath), "plan file exists in worktree after re-attach");

        const wtPlan = read(wtPlanPath, "utf-8");
        assertTrue(wtPlan.includes("- [x] **T02:"), "T02 should be [x] after reconciliation (was [ ] on branch)");
        assertTrue(wtPlan.includes("- [x] **T01:"), "T01 stays [x]");
        assertTrue(wtPlan.includes("- [ ] **T03:"), "T03 stays [ ] (not in root either)");
      } finally {
        teardownAutoWorktree(tempDir, "M004");
      }
    }

  } finally {
    // Always restore cwd and clean up
    process.chdir(savedCwd);
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  report();
}

main();
