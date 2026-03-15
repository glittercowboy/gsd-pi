/**
 * auto-worktree-merge.test.ts — Integration tests for mergeSliceToMilestone.
 *
 * Covers: --no-ff merge topology, rich commit messages, slice branch deletion,
 * zero-commit error, real code conflicts, .gsd/ non-conflict in worktree mode.
 * All tests use real git operations in temp repos.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  createAutoWorktree,
  teardownAutoWorktree,
  mergeSliceToMilestone,
} from "../auto-worktree.ts";
import { MergeConflictError } from "../git-service.ts";
import { getSliceBranchName } from "../worktree.ts";

import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, assertMatch, report } = createTestContext();

function run(cmd: string, cwd: string): string {
  return execSync(cmd, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    shell: process.platform === "win32" ? "pwsh.exe" : true,
  }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-merge-test-")));
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

/** Create a slice branch in the worktree, add commits, return branch name. */
function setupSliceBranch(
  wtPath: string,
  milestoneId: string,
  sliceId: string,
  commits: Array<{ file: string; content: string; message: string }>,
): string {
  // Detect worktree name for branch naming
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
  return sliceBranch;
}

async function main(): Promise<void> {
  const savedCwd = process.cwd();
  const tempDirs: string[] = [];

  function freshRepo(): string {
    const d = createTempRepo();
    tempDirs.push(d);
    return d;
  }

  try {
    // ─── Test 1: Single slice --no-ff merge ────────────────────────────
    console.log("\n=== single slice --no-ff merge ===");
    {
      const repo = freshRepo();
      const wtPath = createAutoWorktree(repo, "M003");

      const sliceBranch = setupSliceBranch(wtPath, "M003", "S01", [
        { file: "a.ts", content: "const a = 1;\n", message: "add a.ts" },
        { file: "b.ts", content: "const b = 2;\n", message: "add b.ts" },
        { file: "c.ts", content: "const c = 3;\n", message: "add c.ts" },
      ]);
      run("git checkout milestone/M003", wtPath);

      const result = mergeSliceToMilestone(repo, "M003", "S01", "Add core files");

      // Verify we're back on milestone branch
      const branch = run("git branch --show-current", wtPath);
      assertEq(branch, "milestone/M003", "back on milestone branch after merge");

      // Verify merge topology via git log --graph
      const log = run("git log --oneline --graph", wtPath);
      assertTrue(log.includes("*   "), "merge commit visible in graph (asterisk with two parents)");
      assertTrue(log.includes("add a.ts"), "slice commit 'add a.ts' visible");
      assertTrue(log.includes("add b.ts"), "slice commit 'add b.ts' visible");
      assertTrue(log.includes("add c.ts"), "slice commit 'add c.ts' visible");

      // Verify commit message format
      assertMatch(result.mergedCommitMessage, /feat\(M003\/S01\)/, "commit message has conventional format");
      assertTrue(result.mergedCommitMessage.includes("Add core files"), "commit message includes slice title");

      // Verify slice branch deleted
      assertTrue(result.deletedBranch, "slice branch deleted");
      const branches = run("git branch", wtPath);
      assertTrue(!branches.includes(sliceBranch), "slice branch no longer in git branch list");

      teardownAutoWorktree(repo, "M003");
    }

    // ─── Test 2: Two sequential slices ─────────────────────────────────
    console.log("\n=== two sequential slices ===");
    {
      const repo = freshRepo();
      const wtPath = createAutoWorktree(repo, "M003");

      // Slice S01
      setupSliceBranch(wtPath, "M003", "S01", [
        { file: "s1.ts", content: "export const s1 = 1;\n", message: "s1 work" },
      ]);
      run("git checkout milestone/M003", wtPath);
      mergeSliceToMilestone(repo, "M003", "S01", "First slice");

      // Slice S02
      setupSliceBranch(wtPath, "M003", "S02", [
        { file: "s2.ts", content: "export const s2 = 2;\n", message: "s2 work" },
      ]);
      run("git checkout milestone/M003", wtPath);
      mergeSliceToMilestone(repo, "M003", "S02", "Second slice");

      // Verify two merge boundaries
      const log = run("git log --oneline --graph", wtPath);
      const mergeLines = log.split("\n").filter(l => l.includes("*   "));
      assertTrue(mergeLines.length >= 2, "two distinct merge commits in graph");
      assertTrue(log.includes("s1 work"), "S01 commit visible");
      assertTrue(log.includes("s2 work"), "S02 commit visible");

      teardownAutoWorktree(repo, "M003");
    }

    // ─── Test 3: Zero commits throws ───────────────────────────────────
    console.log("\n=== zero commits throws ===");
    {
      const repo = freshRepo();
      const wtPath = createAutoWorktree(repo, "M003");

      // Create slice branch with no commits ahead
      const normalizedPath = wtPath.replaceAll("\\", "/");
      const marker = "/.gsd/worktrees/";
      const idx = normalizedPath.indexOf(marker);
      const worktreeName = idx !== -1 ? normalizedPath.slice(idx + marker.length).split("/")[0] : null;
      const sliceBranch = getSliceBranchName("M003", "S01", worktreeName);
      run(`git checkout -b ${sliceBranch}`, wtPath);
      // No commits — immediately try to merge
      run(`git checkout milestone/M003`, wtPath);

      let threw = false;
      try {
        mergeSliceToMilestone(repo, "M003", "S01", "Empty slice");
      } catch (err) {
        threw = true;
        assertTrue(
          err instanceof Error && err.message.includes("no commits ahead"),
          "error message mentions no commits ahead",
        );
      }
      assertTrue(threw, "mergeSliceToMilestone throws on zero commits");

      teardownAutoWorktree(repo, "M003");
    }

    // ─── Test 4: Real code conflict throws MergeConflictError ──────────
    console.log("\n=== real code conflict throws MergeConflictError ===");
    {
      const repo = freshRepo();
      const wtPath = createAutoWorktree(repo, "M003");

      // Add a file on milestone branch
      writeFileSync(join(wtPath, "shared.ts"), "// version 1\n");
      run("git add .", wtPath);
      run('git commit -m "add shared.ts"', wtPath);

      // Create slice branch, modify same file differently
      const normalizedPath = wtPath.replaceAll("\\", "/");
      const marker = "/.gsd/worktrees/";
      const idx = normalizedPath.indexOf(marker);
      const worktreeName = idx !== -1 ? normalizedPath.slice(idx + marker.length).split("/")[0] : null;
      const sliceBranch = getSliceBranchName("M003", "S01", worktreeName);
      run(`git checkout -b ${sliceBranch}`, wtPath);
      writeFileSync(join(wtPath, "shared.ts"), "// slice version\nexport const x = 1;\n");
      run("git add .", wtPath);
      run('git commit -m "slice edit shared.ts"', wtPath);

      // Modify same file on milestone branch
      run("git checkout milestone/M003", wtPath);
      writeFileSync(join(wtPath, "shared.ts"), "// milestone version\nexport const y = 2;\n");
      run("git add .", wtPath);
      run('git commit -m "milestone edit shared.ts"', wtPath);

      // Go back to milestone branch for merge call
      run("git checkout milestone/M003", wtPath);

      let caught: MergeConflictError | null = null;
      try {
        mergeSliceToMilestone(repo, "M003", "S01", "Conflicting slice");
      } catch (err) {
        if (err instanceof MergeConflictError) {
          caught = err;
        } else {
          throw err;
        }
      }

      assertTrue(caught !== null, "MergeConflictError thrown on conflict");
      if (caught) {
        assertTrue(caught.conflictedFiles.includes("shared.ts"), "conflictedFiles includes shared.ts");
        assertEq(caught.strategy, "merge", "strategy is merge");
        assertTrue(caught.branch.includes("S01"), "branch includes S01");
      }

      // Clean up conflict state before teardown
      run("git merge --abort || true", wtPath);
      run("git checkout milestone/M003", wtPath);
      teardownAutoWorktree(repo, "M003");
    }

    // ─── Test 5: .gsd/ changes don't conflict ─────────────────────────
    console.log("\n=== .gsd/ changes don't conflict ===");
    {
      const repo = freshRepo();
      const wtPath = createAutoWorktree(repo, "M003");

      // The .gsd/ directory in worktrees is local — it's not shared via git
      // between the main repo and the worktree. So modifications to .gsd/
      // files in both branches shouldn't cause conflicts because .gsd/ is
      // in the main repo's tree but the worktree has its own working copy.
      //
      // In the worktree, .gsd/ IS tracked (inherited from main). But since
      // slice branches diverge from milestone branch, .gsd/ changes on both
      // can conflict. The key insight: in real auto-mode, .gsd/ changes only
      // happen on the milestone branch (planning artifacts), not on slice
      // branches (which only have code changes). So we test that code-only
      // slice commits merge cleanly even when milestone has .gsd/ changes.

      // Add a .gsd/ change on milestone branch
      writeFileSync(join(wtPath, ".gsd", "STATE.md"), "# Updated State\nactive: M003\n");
      run("git add .", wtPath);
      run('git commit -m "update .gsd/STATE.md on milestone"', wtPath);

      // Create slice branch with code-only changes
      setupSliceBranch(wtPath, "M003", "S01", [
        { file: "feature.ts", content: "export const feature = true;\n", message: "add feature" },
      ]);
      run("git checkout milestone/M003", wtPath);

      // Merge should succeed — no .gsd/ conflict since slice didn't touch .gsd/
      const result = mergeSliceToMilestone(repo, "M003", "S01", "Feature slice");
      assertTrue(result.branch.includes("S01"), ".gsd/ no-conflict merge succeeded");
      assertTrue(result.deletedBranch, "slice branch deleted after .gsd/-safe merge");

      // Verify feature file exists after merge
      assertTrue(existsSync(join(wtPath, "feature.ts")), "feature.ts present after merge");

      teardownAutoWorktree(repo, "M003");
    }

  } finally {
    process.chdir(savedCwd);
    for (const d of tempDirs) {
      if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    }
  }

  report();
}

main();
