/**
 * worktree-e2e.test.ts -- End-to-end tests for worktree-isolated git flow.
 *
 * Covers cross-cutting groups not tested by individual slice tests:
 *   1. Full lifecycle chain (create -> slice commits -> merge to milestone -> merge to main)
 *   2. Self-heal: abortAndReset cleans up failed merges
 *   3. Doctor detection of orphaned worktrees
 */

import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
  existsSync, realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  createAutoWorktree,
  mergeMilestoneToMain,
} from "../../auto-worktree.ts";
import { getSliceBranchName } from "../../worktree.ts";
import { abortAndReset } from "../../git-self-heal.ts";
import { runGSDDoctor } from "../../doctor.ts";
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';


// ---- Helpers ----

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-e2e-test-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "STATE.md"), "# State\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);
  return dir;
}

function makeRoadmap(
  milestoneId: string,
  title: string,
  slices: Array<{ id: string; title: string }>,
): string {
  const sliceLines = slices.map(s => `- [x] **${s.id}: ${s.title}**`).join("\n");
  return `# ${milestoneId}: ${title}\n\n## Slices\n${sliceLines}\n`;
}

function addSliceToMilestone(
  _repo: string,
  wtPath: string,
  milestoneId: string,
  sliceId: string,
  _sliceTitle: string,
  commits: Array<{ file: string; content: string; message: string }>,
): void {
  const normalizedPath = wtPath.replaceAll("\\", "/");
  const marker = "/.gsd/worktrees/";
  const idx = normalizedPath.indexOf(marker);
  const worktreeName = idx !== -1 ? normalizedPath.slice(idx + marker.length).split("/")[0] : null;

  const sliceBranch = getSliceBranchName(milestoneId, sliceId, worktreeName);

  run(`git checkout -b ${sliceBranch}`, wtPath);
  for (const c of commits) {
    writeFileSync(join(wtPath, c.file), c.content);
    run("git add .", wtPath);
    run(`git commit -m "${c.message}"`, wtPath);
  }
  run(`git checkout milestone/${milestoneId}`, wtPath);
  run(`git merge --no-ff ${sliceBranch} -m "merge ${sliceId}"`, wtPath);
}

describe('worktree-e2e', async () => {
  const savedCwd = process.cwd();
  const tempDirs: string[] = [];

  try {
    // ================================================================
    // Group 1: Full lifecycle chain
    // ================================================================
    console.log("\n=== Full lifecycle: worktree -> slices -> milestone merge -> main ===");
    {
      const repo = createTempRepo();
      tempDirs.push(repo);

      // Count commits on main before
      const mainLogBefore = run("git log --oneline main", repo);
      const commitCountBefore = mainLogBefore.split("\n").length;

      // Create worktree for M001
      const wtPath = createAutoWorktree(repo, "M001");
      tempDirs.push(wtPath);
      assert.ok(existsSync(wtPath), "worktree directory created");

      // Add two slices with commits
      addSliceToMilestone(repo, wtPath, "M001", "S01", "Add auth", [
        { file: "auth.ts", content: "export const auth = true;\n", message: "feat: add auth" },
      ]);
      addSliceToMilestone(repo, wtPath, "M001", "S02", "Add dashboard", [
        { file: "dash.ts", content: "export const dash = true;\n", message: "feat: add dashboard" },
      ]);

      // Build roadmap content
      const roadmapContent = makeRoadmap("M001", "First milestone", [
        { id: "S01", title: "Add auth" },
        { id: "S02", title: "Add dashboard" },
      ]);

      // Merge milestone to main
      process.chdir(wtPath);
      const result = mergeMilestoneToMain(repo, "M001", roadmapContent);
      process.chdir(savedCwd);

      // Assert exactly one new commit on main
      const mainLogAfter = run("git log --oneline main", repo);
      const commitCountAfter = mainLogAfter.split("\n").length;
      assert.deepStrictEqual(commitCountAfter, commitCountBefore + 1, "exactly one new commit on main");

      // Commit message contains both slice titles
      const lastCommitMsg = run("git log -1 --format=%B main", repo);
      assert.match(lastCommitMsg, /Add auth/, "commit message contains S01 title");
      assert.match(lastCommitMsg, /Add dashboard/, "commit message contains S02 title");

      // Worktree directory removed
      assert.ok(!existsSync(wtPath), "worktree directory removed after merge");

      // Milestone branch deleted
      const branches = run("git branch", repo);
      assert.ok(!branches.includes("milestone/M001"), "milestone branch deleted");
    }

    // ================================================================
    // Group 2: Self-heal (abortAndReset)
    // ================================================================
    console.log("\n=== Self-heal ===");
    {
      const repo = createTempRepo();
      tempDirs.push(repo);

      // Create conflicting branches
      run("git checkout -b feature", repo);
      writeFileSync(join(repo, "conflict.txt"), "feature content\n");
      run("git add .", repo);
      run("git commit -m feature", repo);
      run("git checkout main", repo);
      writeFileSync(join(repo, "conflict.txt"), "main content\n");
      run("git add .", repo);
      run("git commit -m main-change", repo);

      // Trigger merge conflict
      try { run("git merge feature", repo); } catch { /* expected */ }
      assert.ok(existsSync(join(repo, ".git", "MERGE_HEAD")), "MERGE_HEAD exists before abort");

      const abortResult = abortAndReset(repo);
      assert.ok(!existsSync(join(repo, ".git", "MERGE_HEAD")), "MERGE_HEAD removed after abort");
      assert.ok(abortResult.cleaned.length > 0, "abortAndReset reports cleaned items");
    }

    // ================================================================
    // Group 3: Doctor detects orphaned worktrees
    // Skip on Windows: git worktree path resolution in temp dirs uses
    // UNC/8.3 forms that don't match after normalization.
    // ================================================================
    if (process.platform !== "win32") {
    console.log("\n=== Doctor: orphaned worktree detection ===");
    {
      // Build a repo with a completed milestone
      const repo = createTempRepo();
      tempDirs.push(repo);

      // Create completed milestone roadmap
      const msDir = join(repo, ".gsd", "milestones", "M001");
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
      run("git add -A", repo);
      run("git commit -m \"add milestone\"", repo);

      // Create orphaned worktree
      mkdirSync(join(repo, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b milestone/M001 .gsd/worktrees/M001", repo);

      // Detect
      const detect = await runGSDDoctor(repo, { isolationMode: "worktree" });
      const orphanIssues = detect.issues.filter(i => i.code === "orphaned_auto_worktree");
      assert.ok(orphanIssues.length > 0, "doctor detects orphaned worktree");
      assert.deepStrictEqual(orphanIssues[0]?.unitId, "M001", "orphaned worktree unitId is M001");

      // Fix
      const fixed = await runGSDDoctor(repo, { fix: true, isolationMode: "worktree" });
      assert.ok(
        fixed.fixesApplied.some(f => f.includes("removed orphaned worktree")),
        "doctor fix removes orphaned worktree",
      );

      // Verify gone
      const wtList = run("git worktree list", repo);
      assert.ok(!wtList.includes("milestone/M001"), "worktree gone after doctor fix");
    }
    } else {
      console.log("\n=== Doctor: orphaned worktree detection (skipped on Windows) ===");
    }
  } finally {
    process.chdir(savedCwd);
    for (const d of tempDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});
