/**
 * stash-pop-gsd-conflict.test.ts — Regression test for #2766.
 *
 * When a squash merge stash-pops and hits conflicts on .gsd/ state files,
 * the UU entries block every subsequent merge. This test verifies that
 * mergeMilestoneToMain auto-resolves .gsd/ conflicts by accepting HEAD
 * and drops the stash, leaving the repo in a clean state.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { createAutoWorktree, mergeMilestoneToMain } from "../auto-worktree.ts";
import { _resetServiceCache } from "../worktree.ts";
import { _clearGsdRootCache } from "../paths.ts";

// Isolate from user's global preferences (which may have git.main_branch set)
let originalHome: string | undefined;
let fakeHome: string;

test.before(() => {
  originalHome = process.env.HOME;
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-fake-home-")));
  process.env.HOME = fakeHome;
  _clearGsdRootCache();
  _resetServiceCache();
});

test.after(() => {
  process.env.HOME = originalHome;
  _clearGsdRootCache();
  _resetServiceCache();
  rmSync(fakeHome, { recursive: true, force: true });
});

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-stashpop-test-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "STATE.md"), "version: 1\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);
  return dir;
}

function makeRoadmap(milestoneId: string, title: string, slices: Array<{ id: string; title: string }>): string {
  const sliceLines = slices.map(s => `- [x] **${s.id}: ${s.title}**`).join("\n");
  return `# ${milestoneId}: ${title}\n\n## Slices\n${sliceLines}\n`;
}

test("#2766: stash pop conflict on .gsd/ files is auto-resolved", () => {
  const repo = createTempRepo();
  try {
    const wtPath = createAutoWorktree(repo, "M300");

    // Add a slice with real code on the milestone branch
    const normalizedPath = wtPath.replaceAll("\\", "/");
    const worktreeName = normalizedPath.split("/").pop() || "M300";
    const sliceBranch = `slice/${worktreeName}/S01`;
    run(`git checkout -b "${sliceBranch}"`, wtPath);
    writeFileSync(join(wtPath, "feature.ts"), "export const feature = true;\n");

    // Modify .gsd/STATE.md on the milestone branch (diverges from main)
    writeFileSync(join(wtPath, ".gsd", "STATE.md"), "version: 2-milestone\n");
    run("git add .", wtPath);
    run('git commit -m "add feature and update state"', wtPath);
    run("git checkout milestone/M300", wtPath);
    run(`git merge --no-ff "${sliceBranch}" -m "merge S01: feature"`, wtPath);

    // Dirty .gsd/STATE.md in the main repo (stash will conflict on pop)
    writeFileSync(join(repo, ".gsd", "STATE.md"), "version: 2-main-dirty\n");

    const roadmap = makeRoadmap("M300", "Stash pop conflict test", [
      { id: "S01", title: "Feature" },
    ]);

    // mergeMilestoneToMain should succeed — .gsd/ conflict auto-resolved
    const result = mergeMilestoneToMain(repo, "M300", roadmap);
    assert.ok(
      result.commitMessage.includes("GSD-Milestone: M300"),
      "merge succeeds despite stash pop conflict on .gsd/ file",
    );
    assert.ok(existsSync(join(repo, "feature.ts")), "milestone code merged to main");

    // Verify repo is clean (no UU entries blocking future merges)
    const status = run("git status --porcelain", repo);
    assert.ok(
      !status.includes("UU "),
      "no unmerged (UU) entries remain after stash pop conflict resolution",
    );

    // Stash should be dropped (no remaining stash entries)
    let stashList = "";
    try { stashList = run("git stash list", repo); } catch { /* empty stash */ }
    assert.strictEqual(stashList, "", "stash is empty after .gsd/ conflict auto-resolution");
  } finally {
    try { rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* cleanup best-effort */ }
  }
});

test("#2766: stash pop conflict on non-.gsd files preserves stash for manual resolution", () => {
  const repo = createTempRepo();
  try {
    const wtPath = createAutoWorktree(repo, "M301");

    // Add a slice that modifies a file also dirty on main
    const normalizedPath = wtPath.replaceAll("\\", "/");
    const worktreeName = normalizedPath.split("/").pop() || "M301";
    const sliceBranch = `slice/${worktreeName}/S01`;
    run(`git checkout -b "${sliceBranch}"`, wtPath);
    writeFileSync(join(wtPath, "README.md"), "# milestone version\n");
    run("git add .", wtPath);
    run('git commit -m "update readme"', wtPath);
    run("git checkout milestone/M301", wtPath);
    run(`git merge --no-ff "${sliceBranch}" -m "merge S01: readme"`, wtPath);

    // Dirty README.md in the main repo — this will conflict on stash pop
    // and is NOT a .gsd/ file, so it should be left for manual resolution
    writeFileSync(join(repo, "README.md"), "# locally modified\n");

    const roadmap = makeRoadmap("M301", "Non-gsd stash conflict", [
      { id: "S01", title: "Readme update" },
    ]);

    // The merge itself should still succeed (stash pop conflict is non-fatal)
    const result = mergeMilestoneToMain(repo, "M301", roadmap);
    assert.ok(
      result.commitMessage.includes("GSD-Milestone: M301"),
      "merge succeeds even with non-.gsd stash pop conflict",
    );
  } finally {
    try { rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* cleanup best-effort */ }
  }
});
