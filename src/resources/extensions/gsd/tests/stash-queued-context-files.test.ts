/**
 * stash-queued-context-files.test.ts — Regression test for #2505.
 *
 * When mergeMilestoneToMain runs `git stash push --include-untracked`,
 * untracked `.gsd/milestones/M<queued>/` directories created by `/gsd queue`
 * are swept into the stash. If stash pop fails (conflict on tracked files),
 * the queued milestone CONTEXT files are permanently lost.
 *
 * The fix: drop `--include-untracked` from the stash push, since the stash
 * only needs to handle tracked dirty files. Untracked `.gsd/` files are
 * already handled separately by clearProjectRootStateFiles.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  lstatSync,
} from "node:fs";
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
  return execSync(cmd, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-ctx-stash-test-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "STATE.md"), "version: 1\n");
  // In projects with tracked .gsd/ files (hasGitTrackedGsdFiles=true),
  // .gsd is NOT added to .gitignore. This means untracked files under
  // .gsd/ are visible to --include-untracked and get swept into the
  // stash, destroying queued milestone CONTEXT files (#2505).
  run("git add -f .gsd/STATE.md", dir);
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);
  return dir;
}

function createTempRepoWithSymlinkedGsd(): { repo: string; stateDir: string } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "wt-symlink-stash-test-")));
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "wt-symlink-state-")));
  run("git init", repo);
  run("git config user.email test@test.com", repo);
  run("git config user.name Test", repo);
  writeFileSync(join(repo, "README.md"), "# test\n");
  symlinkSync(stateDir, join(repo, ".gsd"));
  run("git add README.md", repo);
  run("git commit -m init", repo);
  run("git branch -M main", repo);
  return { repo, stateDir };
}

function makeRoadmap(
  milestoneId: string,
  title: string,
  slices: Array<{ id: string; title: string }>,
): string {
  const sliceLines = slices
    .map((s) => `- [x] **${s.id}: ${s.title}**`)
    .join("\n");
  return `# ${milestoneId}: ${title}\n\n## Slices\n${sliceLines}\n`;
}

/**
 * Standalone test proving that --include-untracked sweeps queued
 * milestone CONTEXT files into the git stash. This is a direct
 * git-level test, not going through mergeMilestoneToMain.
 */
test("#2505: git stash --include-untracked sweeps queued CONTEXT files (demonstrates the bug)", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-stash-bug-demo-")));
  try {
    run("git init", dir);
    run("git config user.email test@test.com", dir);
    run("git config user.name Test", dir);
    writeFileSync(join(dir, "README.md"), "# test\n");
    mkdirSync(join(dir, ".gsd"), { recursive: true });
    writeFileSync(join(dir, ".gsd", "STATE.md"), "version: 1\n");
    run("git add -f .gsd/STATE.md", dir);
    run("git add .", dir);
    run("git commit -m init", dir);

    // Create queued milestone CONTEXT files (untracked, not gitignored)
    const m013Dir = join(dir, ".gsd", "milestones", "M013");
    mkdirSync(m013Dir, { recursive: true });
    writeFileSync(
      join(m013Dir, "M013-CONTEXT.md"),
      "# M013: Login Page Redesign\n",
    );

    // Dirty a tracked file
    writeFileSync(join(dir, "README.md"), "# test\n\nDirty.\n");

    // Verify the CONTEXT file is untracked
    const status = run("git status --porcelain", dir);
    assert.ok(status.includes("?? .gsd/milestones/"), "precondition: M013 dir is untracked");

    // Stash WITH --include-untracked (the bug)
    run('git stash push --include-untracked -m "test stash"', dir);

    // BUG: the queued CONTEXT file was swept into the stash
    assert.ok(
      !existsSync(join(m013Dir, "M013-CONTEXT.md")),
      "BUG CONFIRMED: --include-untracked swept CONTEXT file into stash",
    );

    // Stash WITHOUT --include-untracked (the fix)
    run("git stash pop", dir);

    // Recreate the scenario
    mkdirSync(m013Dir, { recursive: true });
    writeFileSync(
      join(m013Dir, "M013-CONTEXT.md"),
      "# M013: Login Page Redesign\n",
    );
    writeFileSync(join(dir, "README.md"), "# test\n\nDirty again.\n");

    // Stash WITHOUT --include-untracked (the fix)
    run('git stash push -m "test stash no untracked"', dir);

    // FIX: the queued CONTEXT file stays on disk
    assert.ok(
      existsSync(join(m013Dir, "M013-CONTEXT.md")),
      "FIX CONFIRMED: without --include-untracked, CONTEXT file stays on disk",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2505: mergeMilestoneToMain preserves queued CONTEXT files (not swept into stash)", () => {
  const repo = createTempRepo();
  try {
    const wtPath = createAutoWorktree(repo, "M015");
    const normalizedPath = wtPath.replaceAll("\\", "/");
    const worktreeName = normalizedPath.split("/").pop() || "M015";
    const sliceBranch = `slice/${worktreeName}/S01`;
    run(`git checkout -b "${sliceBranch}"`, wtPath);
    writeFileSync(join(wtPath, "app.ts"), "export const app = true;\n");
    run("git add .", wtPath);
    run('git commit -m "add app feature"', wtPath);
    run("git checkout milestone/M015", wtPath);
    run(`git merge --no-ff "${sliceBranch}" -m "merge S01"`, wtPath);

    // Simulate `/gsd queue` creating queued milestone CONTEXT files at the
    // project root. These are untracked, and in repos with tracked .gsd/
    // files they are NOT gitignored.
    const m013Dir = join(repo, ".gsd", "milestones", "M013");
    const m014Dir = join(repo, ".gsd", "milestones", "M014");
    mkdirSync(m013Dir, { recursive: true });
    mkdirSync(m014Dir, { recursive: true });
    writeFileSync(
      join(m013Dir, "M013-CONTEXT.md"),
      "# M013: Login Page Redesign\n\nQueued milestone context.\n",
    );
    writeFileSync(
      join(m014Dir, "M014-CONTEXT.md"),
      "# M014: Dashboard Redesign\n\nQueued milestone context.\n",
    );

    // Dirty a tracked file to trigger the pre-merge stash
    writeFileSync(join(repo, "README.md"), "# test\n\nDirty change.\n");

    // Verify M013 is untracked (precondition)
    const statusBefore = run("git status --porcelain", repo);
    assert.ok(
      statusBefore.includes("?? .gsd/milestones/"),
      "M013 directory is untracked before merge (precondition)",
    );

    const roadmap = makeRoadmap("M015", "App Feature", [
      { id: "S01", title: "Feature" },
    ]);

    const result = mergeMilestoneToMain(repo, "M015", roadmap);
    assert.ok(
      result.commitMessage.includes("GSD-Milestone: M015"),
      "merge should succeed",
    );

    // CRITICAL: Queued milestone CONTEXT files must still exist on disk.
    // With --include-untracked, these files get swept into the stash
    // during the merge and are only restored if stash pop succeeds.
    // Without --include-untracked, they are never touched.
    assert.ok(
      existsSync(join(m013Dir, "M013-CONTEXT.md")),
      "M013-CONTEXT.md must survive the merge (not swept into stash)",
    );
    assert.ok(
      existsSync(join(m014Dir, "M014-CONTEXT.md")),
      "M014-CONTEXT.md must survive the merge (not swept into stash)",
    );
    assert.ok(
      readFileSync(join(m013Dir, "M013-CONTEXT.md"), "utf-8").includes("Login Page Redesign"),
      "M013 context content preserved",
    );
    assert.ok(
      readFileSync(join(m014Dir, "M014-CONTEXT.md"), "utf-8").includes("Dashboard Redesign"),
      "M014 context content preserved",
    );

    // Verify milestone code merged correctly
    assert.ok(existsSync(join(repo, "app.ts")), "milestone code merged to main");

    // Verify no stash entry remains that could contain queued files.
    // If --include-untracked is removed, the stash (if needed) should
    // pop cleanly since it only contains tracked files.
    let stashList: string;
    try {
      stashList = run("git stash list", repo);
    } catch {
      stashList = "";
    }
    // A leftover stash after merge is acceptable (pop conflict on tracked
    // files), but it must NOT contain queued milestone files.
    if (stashList) {
      // Verify the stash does not contain queued milestone entries
      try {
        const stashDiff = run("git diff stash@{0}^3 --name-only 2>/dev/null || true", repo);
        assert.ok(
          !stashDiff.includes("M013-CONTEXT"),
          "stash must not contain queued milestone M013 files",
        );
        assert.ok(
          !stashDiff.includes("M014-CONTEXT"),
          "stash must not contain queued milestone M014 files",
        );
      } catch {
        // No untracked tree in stash — that's the expected outcome with the fix
      }
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("#2505: pre-merge stash handles symlinked .gsd without traversing it", () => {
  const { repo, stateDir } = createTempRepoWithSymlinkedGsd();
  try {
    const wtPath = createAutoWorktree(repo, "M016");
    const normalizedPath = wtPath.replaceAll("\\", "/");
    const worktreeName = normalizedPath.split("/").pop() || "M016";
    const sliceBranch = `slice/${worktreeName}/S01`;
    run(`git checkout -b "${sliceBranch}"`, wtPath);
    writeFileSync(join(wtPath, "app.ts"), "export const app = true;\n");
    run("git add app.ts", wtPath);
    run('git commit -m "add app feature"', wtPath);
    run("git checkout milestone/M016", wtPath);
    run(`git merge --no-ff "${sliceBranch}" -m "merge S01"`, wtPath);

    const queuedDir = join(stateDir, "milestones", "M017");
    mkdirSync(queuedDir, { recursive: true });
    writeFileSync(join(queuedDir, "M017-CONTEXT.md"), "# M017: Queued\n");

    // Trigger the pre-merge stash with both tracked and untracked project files.
    writeFileSync(join(repo, "README.md"), "# test\n\nDirty change.\n");
    writeFileSync(join(repo, "local-note.txt"), "local scratch\n");

    const result = mergeMilestoneToMain(repo, "M016", makeRoadmap("M016", "App Feature", [
      { id: "S01", title: "Feature" },
    ]));

    assert.ok(result.commitMessage.includes("GSD-Milestone: M016"), "merge should succeed");
    assert.ok(existsSync(join(repo, "app.ts")), "milestone code merged to main");
    assert.equal(lstatSync(join(repo, ".gsd")).isSymbolicLink(), true, ".gsd symlink remains in place");
    assert.ok(existsSync(join(queuedDir, "M017-CONTEXT.md")), "queued context remains in external state");
    assert.equal(readFileSync(join(repo, "README.md"), "utf-8").replace(/\r\n/g, "\n"), "# test\n\nDirty change.\n");
    assert.equal(readFileSync(join(repo, "local-note.txt"), "utf-8"), "local scratch\n");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#2505: back-to-back merges preserve queued CONTEXT files", () => {
  const repo = createTempRepo();
  try {
    // ── First milestone: M015 ──
    const wt1 = createAutoWorktree(repo, "M015");
    const wt1Name = wt1.replaceAll("\\", "/").split("/").pop() || "M015";
    const slice1 = `slice/${wt1Name}/S01`;
    run(`git checkout -b "${slice1}"`, wt1);
    writeFileSync(join(wt1, "feature1.ts"), "export const f1 = true;\n");
    run("git add .", wt1);
    run('git commit -m "feature 1"', wt1);
    run("git checkout milestone/M015", wt1);
    run(`git merge --no-ff "${slice1}" -m "merge S01"`, wt1);

    // Create queued milestone CONTEXT file
    const m013Dir = join(repo, ".gsd", "milestones", "M013");
    mkdirSync(m013Dir, { recursive: true });
    writeFileSync(
      join(m013Dir, "M013-CONTEXT.md"),
      "# M013: Login Page Redesign\n\nQueued milestone context.\n",
    );

    // Dirty tracked file to trigger stash
    writeFileSync(join(repo, "README.md"), "# test\n\nDirty for M015.\n");

    mergeMilestoneToMain(repo, "M015", makeRoadmap("M015", "Feature 1", [
      { id: "S01", title: "Feature 1" },
    ]));

    assert.ok(
      existsSync(join(m013Dir, "M013-CONTEXT.md")),
      "M013-CONTEXT.md survives first merge",
    );

    // ── Second milestone: M016 ──
    const wt2 = createAutoWorktree(repo, "M016");
    const wt2Name = wt2.replaceAll("\\", "/").split("/").pop() || "M016";
    const slice2 = `slice/${wt2Name}/S01`;
    run(`git checkout -b "${slice2}"`, wt2);
    writeFileSync(join(wt2, "feature2.ts"), "export const f2 = true;\n");
    run("git add .", wt2);
    run('git commit -m "feature 2"', wt2);
    run("git checkout milestone/M016", wt2);
    run(`git merge --no-ff "${slice2}" -m "merge S01"`, wt2);

    // Dirty tracked file again
    writeFileSync(join(repo, "README.md"), "# test\n\nDirty for M016.\n");

    mergeMilestoneToMain(repo, "M016", makeRoadmap("M016", "Feature 2", [
      { id: "S01", title: "Feature 2" },
    ]));

    // After two consecutive merges, queued M013 CONTEXT must still exist
    assert.ok(
      existsSync(join(m013Dir, "M013-CONTEXT.md")),
      "M013-CONTEXT.md must survive two consecutive milestone merges",
    );
    assert.ok(
      readFileSync(join(m013Dir, "M013-CONTEXT.md"), "utf-8").includes("Login Page Redesign"),
      "M013 context content preserved after back-to-back merges",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// #4573: When `.gsd` is a gitignored symlink (ADR-002 layout) and the project
// `.gitignore` contains `.gsd`, `git stash push --include-untracked -- <pathspec>`
// fatals with "The following paths are ignored by one of your .gitignore files".
// The prior tests used a symlinked `.gsd` but no `.gitignore`, so this failure
// mode was invisible to CI. Fixture must include BOTH the symlink AND the
// ignore rule to reproduce the bug on pre-fix code.
test("#4573: gitignored .gsd symlink does not break pre-merge stash", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "wt-4573-ignored-symlink-")));
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "wt-4573-state-")));
  try {
    run("git init", repo);
    run("git config user.email test@test.com", repo);
    run("git config user.name Test", repo);
    writeFileSync(join(repo, "README.md"), "# test\n");
    // Matches what BASELINE_PATTERNS in gitignore.ts writes for real projects.
    writeFileSync(join(repo, ".gitignore"), ".gsd\n.gsd-id\n");
    symlinkSync(stateDir, join(repo, ".gsd"));
    run("git add README.md .gitignore", repo);
    run("git commit -m init", repo);
    run("git branch -M main", repo);

    const wtPath = createAutoWorktree(repo, "M001");
    const worktreeName = wtPath.replaceAll("\\", "/").split("/").pop() || "M001";
    const sliceBranch = `slice/${worktreeName}/S01`;
    run(`git checkout -b "${sliceBranch}"`, wtPath);
    writeFileSync(join(wtPath, "app.ts"), "export const app = true;\n");
    run("git add app.ts", wtPath);
    run('git commit -m "add feature"', wtPath);
    run("git checkout milestone/M001", wtPath);
    run(`git merge --no-ff "${sliceBranch}" -m "merge S01"`, wtPath);

    // Dirty a tracked file so the pre-merge stash branch actually runs.
    writeFileSync(join(repo, "README.md"), "# test\n\nDirty.\n");

    const result = mergeMilestoneToMain(
      repo,
      "M001",
      makeRoadmap("M001", "Feature", [{ id: "S01", title: "Feature" }]),
    );

    assert.ok(
      result.commitMessage.includes("GSD-Milestone: M001"),
      "merge must succeed despite gitignored .gsd symlink",
    );
    assert.ok(existsSync(join(repo, "app.ts")), "milestone code merged to main");
    assert.equal(
      lstatSync(join(repo, ".gsd")).isSymbolicLink(),
      true,
      ".gsd symlink remains in place",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
