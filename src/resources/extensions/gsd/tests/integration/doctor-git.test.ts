import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
/**
 * doctor-git.test.ts — Integration tests for doctor git health checks.
 *
 * Creates real temp git repos with deliberate broken state, runs runGSDDoctor,
 * and asserts correct detection and fixing of git issue codes:
 *   orphaned_auto_worktree, stale_milestone_branch,
 *   corrupt_merge_state, tracked_runtime_files,
 *   integration_branch_missing, worktree_directory_orphaned
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync, readFileSync, symlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { runGSDDoctor } from "../../doctor.ts";
import { closeDatabase, insertMilestone, insertSlice, openDatabase } from "../../gsd-db.ts";
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
  writeFileSync(join(msDir, "M001-SUMMARY.md"), `---
id: M001
title: "Test Milestone"
status: complete
completed_at: 2026-04-18T00:00:00Z
---

# M001: Test Milestone

Completed.
`);

  // Commit .gsd files
  run("git add -A", dir);
  run("git commit -m \"add milestone\"", dir);

  return dir;
}

/** Create a repo whose slices are done but milestone closeout is still pending. */
function createRepoWithSlicesDoneButNoMilestoneSummary(): string {
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
title: "Completing Milestone"
---

# M001: Completing Milestone

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

  run("git add -A", dir);
  run("git commit -m \"add completing milestone\"", dir);

  return dir;
}

/** Write a .gsd/PREFERENCES.md with the given git isolation mode. */
function writePreferencesFile(dir: string, isolation: "none" | "worktree" | "branch"): void {
  const gsdDir = join(dir, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  writeFileSync(join(gsdDir, "PREFERENCES.md"), `---\ngit:\n  isolation: "${isolation}"\n---\n`);
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

describe('doctor-git', async () => {
  const cleanups: string[] = [];

  try {
    // ─── Test 1: Orphaned worktree detection & fix ─────────────────────
    // Skip on Windows: git worktree path resolution on Windows temp dirs
    // uses UNC/8.3 forms that don't survive path normalization. The source
    // logic is correct (tested on macOS/Linux) — the test infra doesn't
    // produce matching paths on Windows CI.
    if (process.platform !== "win32") {
    test('orphaned_auto_worktree', async () => {
      const dir = createRepoWithCompletedMilestone();
      cleanups.push(dir);

      // Create worktree with milestone/M001 branch under .gsd/worktrees/
      mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b milestone/M001 .gsd/worktrees/M001", dir);

      const detect = await runGSDDoctor(dir, { isolationMode: "worktree" });
      const orphanIssues = detect.issues.filter(i => i.code === "orphaned_auto_worktree");
      assert.ok(orphanIssues.length > 0, "detects orphaned worktree");
      assert.deepStrictEqual(orphanIssues[0]?.unitId, "M001", "orphaned worktree unitId is M001");

      const fixed = await runGSDDoctor(dir, { fix: true, isolationMode: "worktree" });
      assert.ok(fixed.fixesApplied.some(f => f.includes("removed orphaned worktree")), "fix removes orphaned worktree");

      // Verify worktree is gone
      const wtList = run("git worktree list", dir);
      assert.ok(!wtList.includes("milestone/M001"), "worktree no longer listed after fix");
    });
    } else {
    }

    // ─── Test 1b: Orphaned worktree fix when cwd is inside worktree (#1946) ──
    // Reproduces the deadlock: if process.cwd() is inside the orphaned worktree,
    // the doctor must chdir out before removing it — not skip the removal.
    if (process.platform !== "win32") {
    console.log("\n=== orphaned_auto_worktree (cwd inside worktree) ===");
    {
      const dir = createRepoWithCompletedMilestone();
      cleanups.push(dir);

      // Create worktree with milestone/M001 branch under .gsd/worktrees/
      mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b milestone/M001 .gsd/worktrees/M001", dir);

      const wtPath = realpathSync(join(dir, ".gsd", "worktrees", "M001"));

      // Simulate the deadlock: set cwd inside the orphaned worktree
      const previousCwd = process.cwd();
      process.chdir(wtPath);
      try {
        const fixed = await runGSDDoctor(dir, { fix: true, isolationMode: "worktree" });

        // The fix must NOT skip removal — it should chdir out and remove
        assert.ok(
          !fixed.fixesApplied.some(f => f.includes("skipped removing worktree")),
          "does NOT skip removal when cwd is inside worktree",
        );
        assert.ok(
          fixed.fixesApplied.some(f => f.includes("removed orphaned worktree")),
          "removes orphaned worktree even when cwd was inside it",
        );

        // Verify worktree is gone
        const wtList = run("git worktree list", dir);
        assert.ok(!wtList.includes("milestone/M001"), "worktree removed after fix with cwd inside");

        // Verify cwd was moved out (should be basePath, not still inside worktree)
        const newCwd = process.cwd();
        assert.ok(
          !newCwd.startsWith(wtPath),
          "cwd moved out of worktree after fix",
        );
      } finally {
        // Restore cwd — the worktree dir may be gone, so chdir to previousCwd
        try { process.chdir(previousCwd); } catch { process.chdir(dir); }
      }
    }
    } else {
      console.log("\n=== orphaned_auto_worktree (cwd inside worktree — skipped on Windows) ===");
    }

    // ─── Test 2: Stale milestone branch detection & fix ────────────────
    // Skip on Windows: git branch glob matching and path resolution
    // behave differently in Windows temp dirs.
    if (process.platform !== "win32") {
    test('stale_milestone_branch', async () => {
      const dir = createRepoWithCompletedMilestone();
      cleanups.push(dir);

      // Create a milestone/M001 branch (no worktree)
      run("git branch milestone/M001", dir);

      const detect = await runGSDDoctor(dir, { isolationMode: "worktree" });
      const staleIssues = detect.issues.filter(i => i.code === "stale_milestone_branch");
      assert.ok(staleIssues.length > 0, "detects stale milestone branch");
      assert.deepStrictEqual(staleIssues[0]?.unitId, "M001", "stale branch unitId is M001");

      const fixed = await runGSDDoctor(dir, { fix: true, isolationMode: "worktree" });
      assert.ok(fixed.fixesApplied.some(f => f.includes("deleted stale branch")), "fix deletes stale branch");

      // Verify branch is gone
      const branches = run("git branch --list milestone/*", dir);
      assert.ok(!branches.includes("milestone/M001"), "branch gone after fix");
    });
    } else {
    }

    // ─── Test 3: Corrupt merge state detection & fix ───────────────────
    test('corrupt_merge_state', async () => {
      const dir = createRepoWithCompletedMilestone();
      cleanups.push(dir);

      // Inject MERGE_HEAD into .git
      const headHash = run("git rev-parse HEAD", dir);
      writeFileSync(join(dir, ".git", "MERGE_HEAD"), headHash + "\n");

      const detect = await runGSDDoctor(dir);
      const mergeIssues = detect.issues.filter(i => i.code === "corrupt_merge_state");
      assert.ok(mergeIssues.length > 0, "detects corrupt merge state");

      const fixed = await runGSDDoctor(dir, { fix: true });
      assert.ok(fixed.fixesApplied.some(f => f.includes("cleaned merge state")), "fix cleans merge state");

      // Verify MERGE_HEAD is gone
      assert.ok(!existsSync(join(dir, ".git", "MERGE_HEAD")), "MERGE_HEAD removed after fix");
    });

    // ─── Test 4: Tracked runtime files detection & fix ─────────────────
    test('tracked_runtime_files', async () => {
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
      assert.ok(trackedIssues.length > 0, "detects tracked runtime files");

      const fixed = await runGSDDoctor(dir, { fix: true });
      assert.ok(fixed.fixesApplied.some(f => f.includes("untracked")), "fix untracks runtime files");

      // Verify file is no longer tracked
      const tracked = run("git ls-files .gsd/activity/", dir);
      assert.deepStrictEqual(tracked, "", "runtime file untracked after fix");
    });

    // ─── Test 5: Non-git directory — graceful degradation ──────────────
    test('non-git directory', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "doc-git-test-")));
      cleanups.push(dir);

      // Create minimal .gsd structure (no git)
      mkdirSync(join(dir, ".gsd"), { recursive: true });

      const result = await runGSDDoctor(dir);
      const gitIssues = result.issues.filter(i =>
        ["orphaned_auto_worktree", "stale_milestone_branch", "corrupt_merge_state", "tracked_runtime_files"].includes(i.code)
      );
      assert.deepStrictEqual(gitIssues.length, 0, "no git issues in non-git directory");
      // Should not throw — reaching here means no crash
      assert.ok(true, "non-git directory does not crash");
    });

    // ─── Test 6: Active worktree NOT flagged (false positive prevention) ─
    if (process.platform !== "win32") {
    test('active worktree safety', async () => {
      const dir = createRepoWithActiveMilestone();
      cleanups.push(dir);

      // Create worktree for in-progress milestone under .gsd/worktrees/
      mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b milestone/M001 .gsd/worktrees/M001", dir);

      const detect = await runGSDDoctor(dir, { isolationMode: "worktree" });
      const orphanIssues = detect.issues.filter(i => i.code === "orphaned_auto_worktree");
      assert.deepStrictEqual(orphanIssues.length, 0, "active worktree NOT flagged as orphaned");
    });
    } else {
    }

    // ─── Test 6b: completing-milestone worktree NOT flagged ────────────
    if (process.platform !== "win32") {
    test('completing-milestone worktree safety (DB-backed, no summary)', async () => {
      const dir = createRepoWithSlicesDoneButNoMilestoneSummary();
      cleanups.push(dir);

      mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b milestone/M001 .gsd/worktrees/M001", dir);

      const dbPath = join(dir, ".gsd", "gsd.db");
      assert.equal(openDatabase(dbPath), true, "opens gsd.db");
      try {
        insertMilestone({ id: "M001", title: "Completing Milestone", status: "active" });
        insertSlice({ id: "S01", milestoneId: "M001", title: "Test slice", status: "complete", risk: "low", depends: [] });

        const detect = await runGSDDoctor(dir, { isolationMode: "worktree" });
        const orphanIssues = detect.issues.filter(i => i.code === "orphaned_auto_worktree");
        assert.deepStrictEqual(orphanIssues.length, 0, "completing milestone NOT flagged as orphaned");
      } finally {
        closeDatabase();
      }
    });
    } else {
    }

    // ─── Test 7: none-mode skips orphaned worktree check ───────────────
    // NOTE: loadEffectiveGSDPreferences() resolves PROJECT_PREFERENCES_PATH
    // at module load time from process.cwd(). We write the prefs file to
    // the test runner's cwd .gsd/PREFERENCES.md and clean up afterwards.
    if (process.platform !== "win32") {
    test('none-mode skips orphaned worktree', async () => {
      const dir = createRepoWithCompletedMilestone();
      cleanups.push(dir);

      // Create worktree with milestone/M001 branch under .gsd/worktrees/
      mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b milestone/M001 .gsd/worktrees/M001", dir);

      const result = await runGSDDoctor(dir, { isolationMode: "none" });
      const orphanIssues = result.issues.filter(i => i.code === "orphaned_auto_worktree");
      assert.deepStrictEqual(orphanIssues.length, 0, "none-mode: orphaned worktree NOT detected");
    });
    } else {
    }

    // ─── Test 8: none-mode skips stale branch check ────────────────────
    if (process.platform !== "win32") {
    test('none-mode skips stale branch', async () => {
      const dir = createRepoWithCompletedMilestone();
      cleanups.push(dir);

      // Create a milestone/M001 branch (no worktree)
      run("git branch milestone/M001", dir);

      const result = await runGSDDoctor(dir, { isolationMode: "none" });
      const staleIssues = result.issues.filter(i => i.code === "stale_milestone_branch");
      assert.deepStrictEqual(staleIssues.length, 0, "none-mode: stale branch NOT detected");
    });
    } else {
    }

    // ─── Test: Integration branch missing ──────────────────────────────
    if (process.platform !== "win32") {
    test('integration_branch_missing', async () => {
      const dir = createRepoWithActiveMilestone();
      cleanups.push(dir);

      // Write integration branch metadata for M001 pointing to a non-existent branch
      const metaPath = join(dir, ".gsd", "milestones", "M001", "M001-META.json");
      writeFileSync(metaPath, JSON.stringify({ integrationBranch: "feat/does-not-exist" }, null, 2));

      const detect = await runGSDDoctor(dir);
      const missingBranchIssues = detect.issues.filter(i => i.code === "integration_branch_missing");
      assert.ok(missingBranchIssues.length > 0, "detects missing integration branch");
      assert.ok(
        missingBranchIssues[0]?.message.includes("feat/does-not-exist"),
        "message includes the missing branch name",
      );
      assert.deepStrictEqual(missingBranchIssues[0]?.fixable, true, "integration_branch_missing is auto-fixable via fallback");
      assert.deepStrictEqual(missingBranchIssues[0]?.severity, "warning", "severity is warning (fallback available)");
    });
    } else {
    }

    // ─── Test: Integration branch present — no false positive ──────────
    if (process.platform !== "win32") {
    test('integration_branch_missing (no false positive)', async () => {
      const dir = createRepoWithActiveMilestone();
      cleanups.push(dir);

      // Write integration branch metadata for M001 pointing to "main" (which exists)
      const metaPath = join(dir, ".gsd", "milestones", "M001", "M001-META.json");
      writeFileSync(metaPath, JSON.stringify({ integrationBranch: "main" }, null, 2));

      const detect = await runGSDDoctor(dir);
      const missingBranchIssues = detect.issues.filter(i => i.code === "integration_branch_missing");
      assert.deepStrictEqual(missingBranchIssues.length, 0, "existing integration branch NOT flagged");
    });
    } else {
    }

    // ─── Test: Orphaned worktree directory ─────────────────────────────
    test('integration_branch_missing: stale metadata with detected fallback', async () => {
      const dir = createRepoWithActiveMilestone();
      cleanups.push(dir);

      const metaPath = join(dir, ".gsd", "milestones", "M001", "M001-META.json");
      writeFileSync(metaPath, JSON.stringify({ integrationBranch: "feat/does-not-exist" }, null, 2));

      const detect = await runGSDDoctor(dir);
      const missingBranchIssues = detect.issues.filter(i => i.code === "integration_branch_missing");
      assert.deepStrictEqual(missingBranchIssues.length, 1, "reports one stale integration branch issue");
      assert.deepStrictEqual(missingBranchIssues[0]?.severity, "warning", "stale metadata is warning when a fallback branch exists");
      assert.deepStrictEqual(missingBranchIssues[0]?.fixable, true, "stale metadata becomes auto-fixable when fallback exists");
      assert.ok(
        missingBranchIssues[0]?.message.includes("feat/does-not-exist") &&
        missingBranchIssues[0]?.message.includes("main"),
        "warning mentions stale recorded branch and detected fallback branch",
      );

      const fixed = await runGSDDoctor(dir, { fix: true });
      assert.ok(
        fixed.fixesApplied.some(f => f.includes('updated integration branch for M001 to "main"')),
        "doctor fix rewrites stale integration branch metadata to detected fallback branch",
      );

      const repairedMeta = JSON.parse(readFileSync(metaPath, "utf-8"));
      assert.deepStrictEqual(repairedMeta.integrationBranch, "main", "metadata rewritten to detected fallback branch");
    });

    test('integration_branch_missing: stale metadata with configured fallback', async () => {
      const dir = createRepoWithActiveMilestone();
      cleanups.push(dir);

      run("git branch trunk", dir);
      writeFileSync(join(dir, ".gsd", "PREFERENCES.md"), `---\ngit:\n  isolation: "worktree"\n  main_branch: "trunk"\n---\n`);

      const metaPath = join(dir, ".gsd", "milestones", "M001", "M001-META.json");
      writeFileSync(metaPath, JSON.stringify({ integrationBranch: "feat/does-not-exist" }, null, 2));

      const previousCwd = process.cwd();
      process.chdir(dir);
      try {
        const detect = await runGSDDoctor(dir);
        const missingBranchIssues = detect.issues.filter(i => i.code === "integration_branch_missing");
        assert.deepStrictEqual(missingBranchIssues.length, 1, "configured fallback still reports one stale integration branch issue");
        assert.deepStrictEqual(missingBranchIssues[0]?.severity, "warning", "configured fallback keeps stale metadata at warning severity");
        assert.deepStrictEqual(missingBranchIssues[0]?.fixable, true, "configured fallback remains auto-fixable");
        assert.ok(
          missingBranchIssues[0]?.message.includes("feat/does-not-exist") &&
          missingBranchIssues[0]?.message.includes("trunk"),
          "warning mentions stale recorded branch and configured fallback branch",
        );

        const fixed = await runGSDDoctor(dir, { fix: true });
        assert.ok(
          fixed.fixesApplied.some(f => f.includes('updated integration branch for M001 to "trunk"')),
          "doctor fix rewrites stale metadata to configured fallback branch",
        );
      } finally {
        process.chdir(previousCwd);
      }

      const repairedMeta = JSON.parse(readFileSync(metaPath, "utf-8"));
      assert.deepStrictEqual(repairedMeta.integrationBranch, "trunk", "metadata rewritten to configured fallback branch");
    });

    if (process.platform !== "win32") {
    test('worktree_directory_orphaned', async () => {
      const dir = createRepoWithActiveMilestone();
      cleanups.push(dir);

      // Create a worktrees/ dir with an entry that is NOT in git worktree list
      const orphanDir = join(dir, ".gsd", "worktrees", "orphan-feature");
      mkdirSync(orphanDir, { recursive: true });
      writeFileSync(join(orphanDir, "some-file.txt"), "leftover content\n");

      const detect = await runGSDDoctor(dir);
      const orphanDirIssues = detect.issues.filter(i => i.code === "worktree_directory_orphaned");
      assert.ok(orphanDirIssues.length > 0, "detects orphaned worktree directory");
      assert.ok(
        orphanDirIssues[0]?.message.includes("orphan-feature"),
        "message includes the orphaned directory name",
      );
      assert.ok(orphanDirIssues[0]?.fixable === true, "worktree_directory_orphaned is fixable");

      const fixed = await runGSDDoctor(dir, { fix: true });
      assert.ok(
        fixed.fixesApplied.some(f => f.includes("removed orphaned worktree directory")),
        "fix removes orphaned worktree directory",
      );
      assert.ok(!existsSync(orphanDir), "orphaned directory removed after fix");
    });
    } else {
    }

    // ─── Test: Registered worktree NOT flagged as orphaned ─────────────
    if (process.platform !== "win32") {
    test('worktree_directory_orphaned (registered worktree not flagged)', async () => {
      const dir = createRepoWithActiveMilestone();
      cleanups.push(dir);

      // Create a real registered worktree under .gsd/worktrees/
      mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b worktree/feature-1 .gsd/worktrees/feature-1", dir);

      const detect = await runGSDDoctor(dir);
      const orphanDirIssues = detect.issues.filter(i => i.code === "worktree_directory_orphaned");
      assert.deepStrictEqual(orphanDirIssues.length, 0, "registered worktree NOT flagged as orphaned");
    });
    } else {
    }

    // ─── Test 9: none-mode still detects corrupt merge state ───────────
    test('none-mode keeps corrupt merge state', async () => {
      const dir = createRepoWithCompletedMilestone();
      cleanups.push(dir);

      // Inject MERGE_HEAD into .git
      const headHash = run("git rev-parse HEAD", dir);
      writeFileSync(join(dir, ".git", "MERGE_HEAD"), headHash + "\n");

      const result = await runGSDDoctor(dir, { isolationMode: "none" });
      const mergeIssues = result.issues.filter(i => i.code === "corrupt_merge_state");
      assert.ok(mergeIssues.length > 0, "none-mode: corrupt merge state IS detected");
    });

    // ─── Test 10: none-mode still detects tracked runtime files ────────
    test('none-mode keeps tracked runtime files', async () => {
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
      assert.ok(trackedIssues.length > 0, "none-mode: tracked runtime files IS detected");
    });

    // ─── Test: Symlinked .gsd does not cause false orphan detection ────
    if (process.platform !== "win32") {
    test('worktree_directory_orphaned (symlinked .gsd not false-positive)', async () => {
      const dir = createRepoWithActiveMilestone();
      cleanups.push(dir);

      // Move .gsd to an external location and replace with a symlink.
      // This simulates the ~/.gsd/projects/<hash> layout where .gsd is a symlink.
      const externalGsd = join(realpathSync(mkdtempSync(join(tmpdir(), "doc-git-symlink-"))), "gsd-data");
      cleanups.push(externalGsd);
      renameSync(join(dir, ".gsd"), externalGsd);
      symlinkSync(externalGsd, join(dir, ".gsd"));

      // Create a real registered worktree under the (now symlinked) .gsd/worktrees/
      mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b worktree/symlink-test .gsd/worktrees/symlink-test", dir);

      const detect = await runGSDDoctor(dir);
      const orphanDirIssues = detect.issues.filter(i => i.code === "worktree_directory_orphaned");
      assert.deepStrictEqual(orphanDirIssues.length, 0, "registered worktree via symlinked .gsd NOT flagged as orphaned");
    });
    } else {
    }

    // ─── Test: worktree_branch_merged detection & fix ──────────────────
    if (process.platform !== "win32") {
    test('worktree_branch_merged', async () => {
      const dir = createRepoWithActiveMilestone();
      cleanups.push(dir);

      // Create a worktree, make a commit, then merge the branch into main
      mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b worktree/merged-feature .gsd/worktrees/merged-feature", dir);
      const wtPath = join(dir, ".gsd", "worktrees", "merged-feature");
      writeFileSync(join(wtPath, "feature.txt"), "feature\n");
      run("git add -A", wtPath);
      run("git -c user.email=test@test.com -c user.name=Test commit -m \"feature work\"", wtPath);

      // Merge the worktree branch into main
      run("git merge worktree/merged-feature --no-edit", dir);

      const detect = await runGSDDoctor(dir);
      const mergedIssues = detect.issues.filter(i => i.code === "worktree_branch_merged");
      assert.ok(mergedIssues.length > 0, "detects merged worktree branch");
      assert.ok(mergedIssues[0]?.message.includes("safe to remove"), "message says safe to remove");
      assert.ok(mergedIssues[0]?.fixable === true, "merged worktree is fixable");

      // Fix should remove the worktree
      const fixed = await runGSDDoctor(dir, { fix: true });
      assert.ok(fixed.fixesApplied.some(f => f.includes("removed merged worktree")), "fix removes merged worktree");
      assert.ok(!existsSync(wtPath), "worktree directory removed after fix");
    });
    } else {
    }

    // ─── Test: merged milestone/* worktree removes milestone branch ────
    if (process.platform !== "win32") {
    test('worktree_branch_merged (milestone branch cleanup)', async () => {
      const dir = createRepoWithActiveMilestone();
      cleanups.push(dir);

      mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b milestone/M001 .gsd/worktrees/M001", dir);
      const wtPath = join(dir, ".gsd", "worktrees", "M001");
      writeFileSync(join(wtPath, "feature.txt"), "feature\n");
      run("git add -A", wtPath);
      run("git -c user.email=test@test.com -c user.name=Test commit -m \"feature work\"", wtPath);
      run("git merge milestone/M001 --no-edit", dir);

      const fixed = await runGSDDoctor(dir, { fix: true });
      assert.ok(fixed.fixesApplied.some(f => f.includes("removed merged worktree")), "fix removes merged milestone worktree");
      assert.ok(!existsSync(wtPath), "milestone worktree directory removed after fix");

      const branches = run("git branch --list milestone/M001", dir);
      assert.deepStrictEqual(branches, "", "milestone/M001 branch deleted after merged worktree cleanup");
    });
    } else {
    }

    // ─── Test: worktree_branch_merged NOT flagged for unmerged worktree ─
    if (process.platform !== "win32") {
    test('worktree_branch_merged (no false positive)', async () => {
      const dir = createRepoWithActiveMilestone();
      cleanups.push(dir);

      mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b worktree/active-feature .gsd/worktrees/active-feature", dir);
      const wtPath = join(dir, ".gsd", "worktrees", "active-feature");
      writeFileSync(join(wtPath, "wip.txt"), "work in progress\n");
      run("git add -A", wtPath);
      run("git -c user.email=test@test.com -c user.name=Test commit -m \"wip\"", wtPath);

      // Do NOT merge — branch is ahead of main
      const detect = await runGSDDoctor(dir);
      const mergedIssues = detect.issues.filter(i => i.code === "worktree_branch_merged");
      assert.deepStrictEqual(mergedIssues.length, 0, "unmerged worktree NOT flagged as merged");
    });
    } else {
    }

    // ─── Test: legacy_slice_branches now fixable ───────────────────────
    if (process.platform !== "win32") {
    test('legacy_slice_branches (fixable)', async () => {
      const dir = createRepoWithActiveMilestone();
      cleanups.push(dir);

      // Create legacy gsd/M001/S01 branches
      run("git branch gsd/M001/S01", dir);
      run("git branch gsd/M001/S02", dir);
      // Active quick branches share gsd/*/* shape and must NOT be deleted.
      run("git branch gsd/quick/1-fix-typo", dir);

      const detect = await runGSDDoctor(dir);
      const legacyIssues = detect.issues.filter(i => i.code === "legacy_slice_branches");
      assert.ok(legacyIssues.length > 0, "detects legacy slice branches");
      assert.ok(legacyIssues[0]?.fixable === true, "legacy branches are fixable");

      const fixed = await runGSDDoctor(dir, { fix: true });
      assert.ok(fixed.fixesApplied.some(f => f.includes("legacy slice branch")), "fix deletes legacy branches");

      // Verify branches are gone
      const remaining = run("git branch --list gsd/*/*", dir);
      assert.deepStrictEqual(remaining, "gsd/quick/1-fix-typo", "quick branch preserved; legacy branches removed");
    });
    } else {
    }

    // ─── Test: stale_uncommitted_changes detection & auto-snapshot ──────
    test('stale_uncommitted_changes (detected and auto-committed)', async () => {
      const dir = createRepoWithActiveMilestone();
      cleanups.push(dir);

      // Make the last commit appear old by amending its date to 45 min ago
      const pastDate = new Date(Date.now() - 45 * 60 * 1000).toISOString();
      run(`git commit --amend --no-edit --date="${pastDate}"`, dir);
      // Also set committer date so git log %ct reflects it
      execSync(`git commit --amend --no-edit`, {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
        env: { ...process.env, GIT_COMMITTER_DATE: pastDate },
      });

      // Modify an already-tracked file (nativeAddTracked uses git add -u,
      // which only stages tracked files — new untracked files are not staged)
      writeFileSync(join(dir, "README.md"), "# test\nmodified content\n");

      const detect = await runGSDDoctor(dir);
      const staleIssues = detect.issues.filter(i => i.code === "stale_uncommitted_changes");
      assert.ok(staleIssues.length > 0, "detects stale uncommitted changes");
      assert.ok(staleIssues[0]?.message.includes("minute"), "message mentions minutes");
      assert.ok(staleIssues[0]?.fixable === true, "stale uncommitted changes is fixable");

      // Fix should create a gsd snapshot commit
      const fixed = await runGSDDoctor(dir, { fix: true });
      assert.ok(
        fixed.fixesApplied.some(f => f.includes("gsd snapshot")),
        "fix creates a gsd snapshot commit",
      );

      // Verify the snapshot commit was created with the gsd snapshot tag
      const log = run("git log -1 --oneline", dir);
      assert.ok(log.includes("gsd snapshot"), "commit is tagged with gsd snapshot");
    });

    // ─── Test: stale_uncommitted_changes NOT flagged when recent commit ──
    test('stale_uncommitted_changes (no false positive on recent commit)', async () => {
      const dir = createRepoWithActiveMilestone();
      cleanups.push(dir);

      // Create uncommitted changes (but last commit is fresh — just created)
      writeFileSync(join(dir, "fresh-dirty.txt"), "recent changes\n");

      const detect = await runGSDDoctor(dir);
      const staleIssues = detect.issues.filter(i => i.code === "stale_uncommitted_changes");
      assert.deepStrictEqual(staleIssues.length, 0, "recent commit with dirty tree NOT flagged as stale");
    });

    // ─── Test: stale_uncommitted_changes suppressed by git.snapshots:false (#4420) ──
    test('stale_uncommitted_changes (suppressed by git.snapshots:false)', async () => {
      const dir = createRepoWithActiveMilestone();
      cleanups.push(dir);

      const pastDate = new Date(Date.now() - 45 * 60 * 1000).toISOString();
      run(`git commit --amend --no-edit --date="${pastDate}"`, dir);
      execSync(`git commit --amend --no-edit`, {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
        env: { ...process.env, GIT_COMMITTER_DATE: pastDate },
      });

      writeFileSync(join(dir, "README.md"), "# test\nmodified content\n");
      writeFileSync(join(dir, ".gsd", "PREFERENCES.md"), `---\ngit:\n  snapshots: false\n---\n`);

      const commitsBefore = run("git rev-list --count HEAD", dir);

      const previousCwd = process.cwd();
      process.chdir(dir);
      try {
        const detect = await runGSDDoctor(dir);
        const staleIssues = detect.issues.filter(i => i.code === "stale_uncommitted_changes");
        assert.deepStrictEqual(staleIssues.length, 0, "git.snapshots:false suppresses stale detection");

        const fixed = await runGSDDoctor(dir, { fix: true });
        assert.ok(
          !fixed.fixesApplied.some(f => f.includes("gsd snapshot")),
          `git.snapshots:false suppresses snapshot fix (got: ${JSON.stringify(fixed.fixesApplied)})`,
        );
      } finally {
        process.chdir(previousCwd);
      }

      const commitsAfter = run("git rev-list --count HEAD", dir);
      assert.strictEqual(commitsAfter, commitsBefore, "no snapshot commit was created when git.snapshots:false");
    });

    // ─── Test: stale_uncommitted_changes NOT flagged when tree is clean ──
    test('stale_uncommitted_changes (no false positive on clean tree)', async () => {
      const dir = createRepoWithActiveMilestone();
      cleanups.push(dir);

      // Make the last commit appear old
      const pastDate = new Date(Date.now() - 45 * 60 * 1000).toISOString();
      run(`git commit --amend --no-edit --date="${pastDate}"`, dir);
      execSync(`git commit --amend --no-edit`, {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
        env: { ...process.env, GIT_COMMITTER_DATE: pastDate },
      });

      // No uncommitted changes — tree is clean
      const detect = await runGSDDoctor(dir);
      const staleIssues = detect.issues.filter(i => i.code === "stale_uncommitted_changes");
      assert.deepStrictEqual(staleIssues.length, 0, "old commit with clean tree NOT flagged as stale");
    });

  } finally {
    for (const dir of cleanups) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});
