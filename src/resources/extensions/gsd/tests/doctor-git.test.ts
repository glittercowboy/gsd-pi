/**
 * doctor-git.test.ts — Integration tests for doctor git health checks.
 *
 * Creates real temp git repos with deliberate broken state, runs runGSDDoctor,
 * and asserts correct detection and fixing of all 4 git issue codes:
 *   orphaned_auto_worktree, stale_milestone_branch,
 *   corrupt_merge_state, tracked_runtime_files
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { runGSDDoctor } from "../doctor.ts";
import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, report } = createTestContext();

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

/** Create a temp git repo with a completed milestone M001 in roadmap. */
function createRepoWithCompletedMilestone(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "doc-git-test-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);

  // Initial commit
  writeFileSync(join(dir, "README.md"), "# test\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);

  // Create .gsd structure with milestone M001 — all slices done → complete
  const msDir = join(dir, ".gsd", "milestones", "M001");
  mkdirSync(msDir, { recursive: true });
  writeFileSync(join(msDir, "ROADMAP.md"), `---
id: M001
title: "Test Milestone"
---

# M001: Test Milestone

## Vision
Test

## Success Criteria
- Done

## Slices
- [x] **S01: Test slice** \`risk:low\` \`depends:[]\`
  > After this: done

## Boundary Map
_None_
`);

  // Commit .gsd files
  run("git add -A", dir);
  run("git commit -m \"add milestone\"", dir);

  return dir;
}

/** Create a repo with an in-progress milestone. */
function createRepoWithActiveMilestone(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "doc-git-test-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);

  writeFileSync(join(dir, "README.md"), "# test\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);

  const msDir = join(dir, ".gsd", "milestones", "M001");
  mkdirSync(msDir, { recursive: true });
  writeFileSync(join(msDir, "ROADMAP.md"), `---
id: M001
title: "Active Milestone"
---

# M001: Active Milestone

## Vision
Test

## Success Criteria
- Done

## Slices
- [ ] **S01: Test slice** \`risk:low\` \`depends:[]\`
  > After this: done

## Boundary Map
_None_
`);

  run("git add -A", dir);
  run("git commit -m \"add milestone\"", dir);

  return dir;
}

async function main(): Promise<void> {
  const cleanups: string[] = [];

  try {
    // ─── Test 1: Orphaned worktree detection & fix ─────────────────────
    // Skip on Windows: git worktree path resolution on Windows temp dirs
    // uses UNC/8.3 forms that don't survive path normalization. The source
    // logic is correct (tested on macOS/Linux) — the test infra doesn't
    // produce matching paths on Windows CI.
    if (process.platform !== "win32") {
    console.log("\n=== orphaned_auto_worktree ===");
    {
      const dir = createRepoWithCompletedMilestone();
      cleanups.push(dir);

      // Create worktree with milestone/M001 branch under .gsd/worktrees/
      mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b milestone/M001 .gsd/worktrees/M001", dir);

      const detect = await runGSDDoctor(dir);
      const orphanIssues = detect.issues.filter(i => i.code === "orphaned_auto_worktree");
      assertTrue(orphanIssues.length > 0, "detects orphaned worktree");
      assertEq(orphanIssues[0]?.unitId, "M001", "orphaned worktree unitId is M001");

      const fixed = await runGSDDoctor(dir, { fix: true });
      assertTrue(fixed.fixesApplied.some(f => f.includes("removed orphaned worktree")), "fix removes orphaned worktree");

      // Verify worktree is gone
      const wtList = run("git worktree list", dir);
      assertTrue(!wtList.includes("milestone/M001"), "worktree no longer listed after fix");
    }
    } else {
      console.log("\n=== orphaned_auto_worktree (skipped on Windows) ===");
    }

    // ─── Test 2: Stale milestone branch detection & fix ────────────────
    // Skip on Windows: git branch glob matching and path resolution
    // behave differently in Windows temp dirs.
    if (process.platform !== "win32") {
    console.log("\n=== stale_milestone_branch ===");
    {
      const dir = createRepoWithCompletedMilestone();
      cleanups.push(dir);

      // Create a milestone/M001 branch (no worktree)
      run("git branch milestone/M001", dir);

      const detect = await runGSDDoctor(dir);
      const staleIssues = detect.issues.filter(i => i.code === "stale_milestone_branch");
      assertTrue(staleIssues.length > 0, "detects stale milestone branch");
      assertEq(staleIssues[0]?.unitId, "M001", "stale branch unitId is M001");

      const fixed = await runGSDDoctor(dir, { fix: true });
      assertTrue(fixed.fixesApplied.some(f => f.includes("deleted stale branch")), "fix deletes stale branch");

      // Verify branch is gone
      const branches = run("git branch --list milestone/*", dir);
      assertTrue(!branches.includes("milestone/M001"), "branch gone after fix");
    }
    } else {
      console.log("\n=== stale_milestone_branch (skipped on Windows) ===");
    }

    // ─── Test 3: Corrupt merge state detection & fix ───────────────────
    console.log("\n=== corrupt_merge_state ===");
    {
      const dir = createRepoWithCompletedMilestone();
      cleanups.push(dir);

      // Inject MERGE_HEAD into .git
      const headHash = run("git rev-parse HEAD", dir);
      writeFileSync(join(dir, ".git", "MERGE_HEAD"), headHash + "\n");

      const detect = await runGSDDoctor(dir);
      const mergeIssues = detect.issues.filter(i => i.code === "corrupt_merge_state");
      assertTrue(mergeIssues.length > 0, "detects corrupt merge state");

      const fixed = await runGSDDoctor(dir, { fix: true });
      assertTrue(fixed.fixesApplied.some(f => f.includes("cleaned merge state")), "fix cleans merge state");

      // Verify MERGE_HEAD is gone
      assertTrue(!existsSync(join(dir, ".git", "MERGE_HEAD")), "MERGE_HEAD removed after fix");
    }

    // ─── Test 4: Tracked runtime files detection & fix ─────────────────
    console.log("\n=== tracked_runtime_files ===");
    {
      const dir = createRepoWithCompletedMilestone();
      cleanups.push(dir);

      // Force-add a runtime file
      const activityDir = join(dir, ".gsd", "activity");
      mkdirSync(activityDir, { recursive: true });
      writeFileSync(join(activityDir, "test.log"), "log data\n");
      run("git add -f .gsd/activity/test.log", dir);
      run("git commit -m \"track runtime file\"", dir);

      const detect = await runGSDDoctor(dir);
      const trackedIssues = detect.issues.filter(i => i.code === "tracked_runtime_files");
      assertTrue(trackedIssues.length > 0, "detects tracked runtime files");

      const fixed = await runGSDDoctor(dir, { fix: true });
      assertTrue(fixed.fixesApplied.some(f => f.includes("untracked")), "fix untracks runtime files");

      // Verify file is no longer tracked
      const tracked = run("git ls-files .gsd/activity/", dir);
      assertEq(tracked, "", "runtime file untracked after fix");
    }

    // ─── Test 5: Non-git directory — graceful degradation ──────────────
    console.log("\n=== non-git directory ===");
    {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "doc-git-test-")));
      cleanups.push(dir);

      // Create minimal .gsd structure (no git)
      mkdirSync(join(dir, ".gsd"), { recursive: true });

      const result = await runGSDDoctor(dir);
      const gitIssues = result.issues.filter(i =>
        ["orphaned_auto_worktree", "stale_milestone_branch", "corrupt_merge_state", "tracked_runtime_files"].includes(i.code)
      );
      assertEq(gitIssues.length, 0, "no git issues in non-git directory");
      // Should not throw — reaching here means no crash
      assertTrue(true, "non-git directory does not crash");
    }

    // ─── Test 6: Active worktree NOT flagged (false positive prevention) ─
    if (process.platform !== "win32") {
    console.log("\n=== active worktree safety ===");
    {
      const dir = createRepoWithActiveMilestone();
      cleanups.push(dir);

      // Create worktree for in-progress milestone under .gsd/worktrees/
      mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b milestone/M001 .gsd/worktrees/M001", dir);

      const detect = await runGSDDoctor(dir);
      const orphanIssues = detect.issues.filter(i => i.code === "orphaned_auto_worktree");
      assertEq(orphanIssues.length, 0, "active worktree NOT flagged as orphaned");
    }
    } else {
      console.log("\n=== active worktree safety (skipped on Windows) ===");
    }

  } finally {
    for (const dir of cleanups) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  report();
}

main();
