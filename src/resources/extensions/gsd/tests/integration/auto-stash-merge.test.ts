/**
 * auto-stash-merge.test.ts — Regression tests for #2151.
 *
 * Tests that mergeMilestoneToMain auto-stashes dirty files before squash merge,
 * and that nativeMergeSquash returns dirty filenames from git stderr.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { createAutoWorktree, mergeMilestoneToMain } from "../../auto-worktree.ts";
import { nativeMergeSquash } from "../../native-git-bridge.ts";

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-autostash-test-")));
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

function makeRoadmap(milestoneId: string, title: string, slices: Array<{ id: string; title: string }>): string {
  const sliceLines = slices.map(s => `- [x] **${s.id}: ${s.title}**`).join("\n");
  return `# ${milestoneId}: ${title}\n\n## Slices\n${sliceLines}\n`;
}

function addSliceToMilestone(
  repo: string, wtPath: string, milestoneId: string,
  sliceId: string, sliceTitle: string,
  commits: Array<{ file: string; content: string; message: string }>,
): void {
  const normalizedPath = wtPath.replaceAll("\\", "/");
  const worktreeName = normalizedPath.split("/").pop() || milestoneId;
  const sliceBranch = `slice/${worktreeName}/${sliceId}`;
  run(`git checkout -b "${sliceBranch}"`, wtPath);
  for (const c of commits) {
    writeFileSync(join(wtPath, c.file), c.content);
    run("git add .", wtPath);
    run(`git commit -m "${c.message}"`, wtPath);
  }
  const milestoneBranch = `milestone/${milestoneId}`;
  run(`git checkout "${milestoneBranch}"`, wtPath);
  run(`git merge --no-ff "${sliceBranch}" -m "merge ${sliceId}: ${sliceTitle}"`, wtPath);
}

test("#2151 bug 1: auto-stash unblocks merge when unrelated files are dirty", () => {
  const repo = createTempRepo();
  try {
    const wtPath = createAutoWorktree(repo, "M200");

    addSliceToMilestone(repo, wtPath, "M200", "S01", "Stash test", [
      { file: "stash-test.ts", content: "export const stash = true;\n", message: "add stash test" },
    ]);

    // Dirty an unrelated tracked file in the project root — this previously
    // blocked the squash merge with "local changes would be overwritten".
    writeFileSync(join(repo, "README.md"), "# modified locally\n");

    const roadmap = makeRoadmap("M200", "Auto-stash test", [
      { id: "S01", title: "Stash test" },
    ]);

    // Should succeed — the dirty README.md is auto-stashed before merge.
    const result = mergeMilestoneToMain(repo, "M200", roadmap);
    assert.ok(result.commitMessage.includes("feat:") && result.commitMessage.includes("GSD-Milestone: M200"), "merge succeeds with dirty unrelated file");
    assert.ok(existsSync(join(repo, "stash-test.ts")), "milestone code merged to main");

    // Verify the dirty file was restored (stash popped).
    const readmeContent = readFileSync(join(repo, "README.md"), "utf-8");
    assert.equal(readmeContent.replace(/\r\n/g, "\n"), "# modified locally\n", "stash popped — dirty file restored after merge");
  } finally {
    try { rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows EPERM: git holds locks on .git files */ }
  }
});

test("#2151 bug 2: nativeMergeSquash returns dirty filenames", async () => {
  const { nativeMergeSquash } = await import("../../native-git-bridge.ts");
  const repo = createTempRepo();
  try {
    run("git checkout -b milestone/M210", repo);
    writeFileSync(join(repo, "overlap.ts"), "export const overlap = true;\n");
    run("git add .", repo);
    run('git commit -m "add overlap"', repo);
    run("git checkout main", repo);

    // Create the same file as a dirty local change
    writeFileSync(join(repo, "overlap.ts"), "// local dirty version\n");

    const result = nativeMergeSquash(repo, "milestone/M210");
    assert.equal(result.success, false, "merge reports failure");
    assert.ok(
      result.conflicts.includes("__dirty_working_tree__"),
      "conflicts include __dirty_working_tree__ sentinel",
    );
    assert.ok(
      Array.isArray(result.dirtyFiles) && result.dirtyFiles.length > 0,
      "dirtyFiles array is populated",
    );
    assert.ok(
      result.dirtyFiles!.includes("overlap.ts"),
      "dirtyFiles includes the actual dirty file name",
    );
  } finally {
    run("git checkout -- . 2>/dev/null || true", repo);
    try { rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows EPERM: git holds locks on .git files */ }
  }
});
