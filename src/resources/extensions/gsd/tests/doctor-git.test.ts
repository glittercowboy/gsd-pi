/**
 * doctor-git.test.ts — Integration tests for doctor git health checks.
 *
 * Creates real temp git repos with deliberate broken state, runs runGSDDoctor,
 * and asserts correct detection and fixing of git issue codes:
 *   orphaned_auto_worktree, stale_milestone_branch,
 *   corrupt_merge_state, tracked_runtime_files,
 *   integration_branch_missing, worktree_directory_orphaned
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

/** Write a .gsd/preferences.md with the given git isolation mode. */
function writePreferencesFile(dir: string, isolation: "none" | "worktree" | "branch"): void {
  const gsdDir = join(dir, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  writeFileSync(join(gsdDir, "preferences.md"), `---\ngit:\n  isolation: "${isolation}"\n---\n`);
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

      const detect = await runGSDDoctor(dir, { isolationMode: "worktree" });
      const orphanIssues = detect.issues.filter(i => i.code === "orphaned_auto_worktree");
      assertTrue(orphanIssues.length > 0, "detects orphaned worktree");
      assertEq(orphanIssues[0]?.unitId, "M001", "orphaned worktree unitId is M001");

      const fixed = await runGSDDoctor(dir, { fix: true, isolationMode: "worktree" });
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

      const detect = await runGSDDoctor(dir, { isolationMode: "worktree" });
      const staleIssues = detect.issues.filter(i => i.code === "stale_milestone_branch");
      assertTrue(staleIssues.length > 0, "detects stale milestone branch");
      assertEq(staleIssues[0]?.unitId, "M001", "stale branch unitId is M001");

      const fixed = await runGSDDoctor(dir, { fix: true, isolationMode: "worktree" });
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

      const detect = await runGSDDoctor(dir, { isolationMode: "worktree" });
      const orphanIssues = detect.issues.filter(i => i.code === "orphaned_auto_worktree");
      assertEq(orphanIssues.length, 0, "active worktree NOT flagged as orphaned");
    }
    } else {
      console.log("\n=== active worktree safety (skipped on Windows) ===");
    }

    // ─── Test 7: none-mode skips orphaned worktree check ───────────────
    // NOTE: loadEffectiveGSDPreferences() resolves PROJECT_PREFERENCES_PATH
    // at module load time from process.cwd(). We write the prefs file to
    // the test runner's cwd .gsd/preferences.md and clean up afterwards.
    if (process.platform !== "win32") {
    console.log("\n=== none-mode skips orphaned worktree ===");
    {
      const dir = createRepoWithCompletedMilestone();
      cleanups.push(dir);

      // Create worktree with milestone/M001 branch under .gsd/worktrees/
      mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b milestone/M001 .gsd/worktrees/M001", dir);

      const result = await runGSDDoctor(dir, { isolationMode: "none" });
      const orphanIssues = result.issues.filter(i => i.code === "orphaned_auto_worktree");
      assertEq(orphanIssues.length, 0, "none-mode: orphaned worktree NOT detected");
    }
    } else {
      console.log("\n=== none-mode skips orphaned worktree (skipped on Windows) ===");
    }

    // ─── Test 8: none-mode skips stale branch check ────────────────────
    if (process.platform !== "win32") {
    console.log("\n=== none-mode skips stale branch ===");
    {
      const dir = createRepoWithCompletedMilestone();
      cleanups.push(dir);

      // Create a milestone/M001 branch (no worktree)
      run("git branch milestone/M001", dir);

      const result = await runGSDDoctor(dir, { isolationMode: "none" });
      const staleIssues = result.issues.filter(i => i.code === "stale_milestone_branch");
      assertEq(staleIssues.length, 0, "none-mode: stale branch NOT detected");
    }
    } else {
      console.log("\n=== none-mode skips stale branch (skipped on Windows) ===");
    }

    // ─── Test: Integration branch missing ──────────────────────────────
    if (process.platform !== "win32") {
    console.log("\n=== integration_branch_missing ===");
    {
      const dir = createRepoWithActiveMilestone();
      cleanups.push(dir);

      // Write integration branch metadata for M001 pointing to a non-existent branch
      const metaPath = join(dir, ".gsd", "milestones", "M001", "M001-META.json");
      writeFileSync(metaPath, JSON.stringify({ integrationBranch: "feat/does-not-exist" }, null, 2));

      const detect = await runGSDDoctor(dir);
      const missingBranchIssues = detect.issues.filter(i => i.code === "integration_branch_missing");
      assertTrue(missingBranchIssues.length > 0, "detects missing integration branch");
      assertTrue(
        missingBranchIssues[0]?.message.includes("feat/does-not-exist"),
        "message includes the missing branch name",
      );
      assertEq(missingBranchIssues[0]?.fixable, false, "integration_branch_missing is not auto-fixable");
      assertEq(missingBranchIssues[0]?.severity, "error", "severity is error");
    }
    } else {
      console.log("\n=== integration_branch_missing (skipped on Windows) ===");
    }

    // ─── Test: Integration branch present — no false positive ──────────
    if (process.platform !== "win32") {
    console.log("\n=== integration_branch_missing (no false positive) ===");
    {
      const dir = createRepoWithActiveMilestone();
      cleanups.push(dir);

      // Write integration branch metadata for M001 pointing to "main" (which exists)
      const metaPath = join(dir, ".gsd", "milestones", "M001", "M001-META.json");
      writeFileSync(metaPath, JSON.stringify({ integrationBranch: "main" }, null, 2));

      const detect = await runGSDDoctor(dir);
      const missingBranchIssues = detect.issues.filter(i => i.code === "integration_branch_missing");
      assertEq(missingBranchIssues.length, 0, "existing integration branch NOT flagged");
    }
    } else {
      console.log("\n=== integration_branch_missing (no false positive — skipped on Windows) ===");
    }

    // ─── Test: Orphaned worktree directory ─────────────────────────────
    if (process.platform !== "win32") {
    console.log("\n=== worktree_directory_orphaned ===");
    {
      const dir = createRepoWithActiveMilestone();
      cleanups.push(dir);

      // Create a worktrees/ dir with an entry that is NOT in git worktree list
      const orphanDir = join(dir, ".gsd", "worktrees", "orphan-feature");
      mkdirSync(orphanDir, { recursive: true });
      writeFileSync(join(orphanDir, "some-file.txt"), "leftover content\n");

      const detect = await runGSDDoctor(dir);
      const orphanDirIssues = detect.issues.filter(i => i.code === "worktree_directory_orphaned");
      assertTrue(orphanDirIssues.length > 0, "detects orphaned worktree directory");
      assertTrue(
        orphanDirIssues[0]?.message.includes("orphan-feature"),
        "message includes the orphaned directory name",
      );
      assertTrue(orphanDirIssues[0]?.fixable === true, "worktree_directory_orphaned is fixable");

      const fixed = await runGSDDoctor(dir, { fix: true });
      assertTrue(
        fixed.fixesApplied.some(f => f.includes("removed orphaned worktree directory")),
        "fix removes orphaned worktree directory",
      );
      assertTrue(!existsSync(orphanDir), "orphaned directory removed after fix");
    }
    } else {
      console.log("\n=== worktree_directory_orphaned (skipped on Windows) ===");
    }

    // ─── Test: Registered worktree NOT flagged as orphaned ─────────────
    if (process.platform !== "win32") {
    console.log("\n=== worktree_directory_orphaned (registered worktree not flagged) ===");
    {
      const dir = createRepoWithActiveMilestone();
      cleanups.push(dir);

      // Create a real registered worktree under .gsd/worktrees/
      mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b worktree/feature-1 .gsd/worktrees/feature-1", dir);

      const detect = await runGSDDoctor(dir);
      const orphanDirIssues = detect.issues.filter(i => i.code === "worktree_directory_orphaned");
      assertEq(orphanDirIssues.length, 0, "registered worktree NOT flagged as orphaned");
    }
    } else {
      console.log("\n=== worktree_directory_orphaned (registered worktree not flagged — skipped on Windows) ===");
    }

    // ─── Test 9: none-mode still detects corrupt merge state ───────────
    console.log("\n=== none-mode keeps corrupt merge state ===");
    {
      const dir = createRepoWithCompletedMilestone();
      cleanups.push(dir);

      // Inject MERGE_HEAD into .git
      const headHash = run("git rev-parse HEAD", dir);
      writeFileSync(join(dir, ".git", "MERGE_HEAD"), headHash + "\n");

      const result = await runGSDDoctor(dir, { isolationMode: "none" });
      const mergeIssues = result.issues.filter(i => i.code === "corrupt_merge_state");
      assertTrue(mergeIssues.length > 0, "none-mode: corrupt merge state IS detected");
    }

    // ─── Test 10: none-mode still detects tracked runtime files ────────
    console.log("\n=== none-mode keeps tracked runtime files ===");
    {
      const dir = createRepoWithCompletedMilestone();
      cleanups.push(dir);

      // Force-add a runtime file
      const activityDir = join(dir, ".gsd", "activity");
      mkdirSync(activityDir, { recursive: true });
      writeFileSync(join(activityDir, "test.log"), "log data\n");
      run("git add -f .gsd/activity/test.log", dir);
      run("git commit -m \"track runtime file\"", dir);

      const result = await runGSDDoctor(dir, { isolationMode: "none" });
      const trackedIssues = result.issues.filter(i => i.code === "tracked_runtime_files");
      assertTrue(trackedIssues.length > 0, "none-mode: tracked runtime files IS detected");
    }

  } finally {
    for (const dir of cleanups) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  report();
}

main();
