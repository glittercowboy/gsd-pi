/**
 * auto-worktree-milestone-merge.test.ts — Integration tests for mergeMilestoneToMain.
 *
 * Covers: squash-merge topology (one commit on main), rich commit message with
 * slice titles, worktree cleanup, nothing-to-commit edge case, auto-push with
 * bare remote. All tests use real git operations in temp repos.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  createAutoWorktree,
  mergeMilestoneToMain,
  getAutoWorktreeOriginalBase,
} from "../auto-worktree.ts";
import { getSliceBranchName } from "../worktree.ts";
import { nativeMergeSquash } from "../native-git-bridge.ts";

import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, assertMatch, report } = createTestContext();

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-ms-merge-test-")));
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

/** Minimal roadmap content for mergeMilestoneToMain. */
function makeRoadmap(milestoneId: string, title: string, slices: Array<{ id: string; title: string }>): string {
  const sliceLines = slices.map(s => `- [x] **${s.id}: ${s.title}**`).join("\n");
  return `# ${milestoneId}: ${title}\n\n## Slices\n${sliceLines}\n`;
}

/** Set up a slice branch on the worktree, add commits, merge it --no-ff to milestone. */
function addSliceToMilestone(
  repo: string,
  wtPath: string,
  milestoneId: string,
  sliceId: string,
  sliceTitle: string,
  commits: Array<{ file: string; content: string; message: string }>,
): void {
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
  run(`git checkout milestone/${milestoneId}`, wtPath);
  run(`git merge --no-ff ${sliceBranch} -m "feat(${milestoneId}/${sliceId}): ${sliceTitle}"`, wtPath);
  // Clean up the slice branch
  run(`git branch -d ${sliceBranch}`, wtPath);
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
    // ─── Test 1: Basic squash merge — one commit on main ───────────────
    console.log("\n=== basic squash merge — one commit on main ===");
    {
      const repo = freshRepo();
      const wtPath = createAutoWorktree(repo, "M010");

      // Add two slices with multiple commits each
      addSliceToMilestone(repo, wtPath, "M010", "S01", "Auth module", [
        { file: "auth.ts", content: "export const auth = true;\n", message: "add auth" },
        { file: "auth-utils.ts", content: "export const hash = () => {};\n", message: "add auth utils" },
      ]);
      addSliceToMilestone(repo, wtPath, "M010", "S02", "User dashboard", [
        { file: "dashboard.ts", content: "export const dash = true;\n", message: "add dashboard" },
        { file: "widgets.ts", content: "export const widgets = [];\n", message: "add widgets" },
      ]);

      const roadmap = makeRoadmap("M010", "User management", [
        { id: "S01", title: "Auth module" },
        { id: "S02", title: "User dashboard" },
      ]);

      const mainLogBefore = run("git log --oneline main", repo);
      const mainCommitCountBefore = mainLogBefore.split("\n").length;

      const result = mergeMilestoneToMain(repo, "M010", roadmap);

      // Exactly one new commit on main
      const mainLog = run("git log --oneline main", repo);
      const mainCommitCountAfter = mainLog.split("\n").length;
      assertEq(mainCommitCountAfter, mainCommitCountBefore + 1, "exactly one new commit on main");

      // Milestone branch deleted
      const branches = run("git branch", repo);
      assertTrue(!branches.includes("milestone/M010"), "milestone branch deleted");

      // Worktree directory removed
      const worktreeDir = join(repo, ".gsd", "worktrees", "M010");
      assertTrue(!existsSync(worktreeDir), "worktree directory removed");

      // Module state cleared
      assertEq(getAutoWorktreeOriginalBase(), null, "originalBase cleared after merge");

      // Files from both slices present on main
      assertTrue(existsSync(join(repo, "auth.ts")), "auth.ts on main");
      assertTrue(existsSync(join(repo, "dashboard.ts")), "dashboard.ts on main");
      assertTrue(existsSync(join(repo, "widgets.ts")), "widgets.ts on main");

      // Result shape
      assertTrue(result.commitMessage.length > 0, "commitMessage returned");
      assertTrue(typeof result.pushed === "boolean", "pushed is boolean");
    }

    // ─── Test 2: Rich commit message format ────────────────────────────
    console.log("\n=== rich commit message format ===");
    {
      const repo = freshRepo();
      const wtPath = createAutoWorktree(repo, "M020");

      addSliceToMilestone(repo, wtPath, "M020", "S01", "Core API", [
        { file: "api.ts", content: "export const api = true;\n", message: "add api" },
      ]);
      addSliceToMilestone(repo, wtPath, "M020", "S02", "Error handling", [
        { file: "errors.ts", content: "export class AppError {}\n", message: "add errors" },
      ]);
      addSliceToMilestone(repo, wtPath, "M020", "S03", "Logging infra", [
        { file: "logger.ts", content: "export const log = () => {};\n", message: "add logger" },
      ]);

      const roadmap = makeRoadmap("M020", "Backend foundation", [
        { id: "S01", title: "Core API" },
        { id: "S02", title: "Error handling" },
        { id: "S03", title: "Logging infra" },
      ]);

      const result = mergeMilestoneToMain(repo, "M020", roadmap);

      // Subject line: conventional commit format
      assertMatch(result.commitMessage, /^feat\(M020\):/, "subject has conventional commit prefix");
      assertTrue(result.commitMessage.includes("Backend foundation"), "subject includes milestone title");

      // Body: slice listing
      assertTrue(result.commitMessage.includes("- S01: Core API"), "body lists S01");
      assertTrue(result.commitMessage.includes("- S02: Error handling"), "body lists S02");
      assertTrue(result.commitMessage.includes("- S03: Logging infra"), "body lists S03");

      // Branch metadata
      assertTrue(result.commitMessage.includes("Branch: milestone/M020"), "body has branch metadata");

      // Verify the actual git commit message matches
      const gitMsg = run("git log -1 --format=%B main", repo).trim();
      assertMatch(gitMsg, /^feat\(M020\):/, "git commit message starts with feat(M020):");
      assertTrue(gitMsg.includes("- S01: Core API"), "git commit body has S01");
    }

    // ─── Test 3: Nothing to commit — preserves branch (#1738) ──────────
    console.log("\n=== nothing to commit — safe when no code changes (#1738, #1792) ===");
    {
      const repo = freshRepo();
      const wtPath = createAutoWorktree(repo, "M030");

      // Don't add any slices/changes — milestone branch is identical to main
      const roadmap = makeRoadmap("M030", "Empty milestone", []);

      // Should NOT throw — milestone branch is identical to main, nothing to lose.
      // The anchor check (#1792) verifies no code files differ and passes through.
      let threw = false;
      let errorMsg = "";
      try {
        mergeMilestoneToMain(repo, "M030", roadmap);
      } catch (err: unknown) {
        threw = true;
        errorMsg = err instanceof Error ? err.message : String(err);
      }
      assertTrue(!threw, `safe empty milestone should not throw (got: ${errorMsg})`);

      // Main log unchanged (only init commit)
      const mainLog = run("git log --oneline main", repo);
      assertEq(mainLog.split("\n").length, 1, "main still has only init commit");
    }

    // ─── Test 4: Auto-push — verify push mechanics work ──────────────
    // Note: loadEffectiveGSDPreferences uses a module-level const for project
    // prefs path (process.cwd() at import time), so temp repo prefs aren't
    // discoverable. We verify the push mechanics work by testing that
    // mergeMilestoneToMain successfully completes with a remote configured,
    // then manually push to verify the remote is set up correctly.
    console.log("\n=== auto-push with bare remote ===");
    {
      const repo = freshRepo();

      // Set up bare remote
      const bareDir = realpathSync(mkdtempSync(join(tmpdir(), "wt-ms-bare-")));
      tempDirs.push(bareDir);
      run("git init --bare", bareDir);
      run(`git remote add origin ${bareDir}`, repo);
      run("git push -u origin main", repo);

      const wtPath = createAutoWorktree(repo, "M040");

      addSliceToMilestone(repo, wtPath, "M040", "S01", "Push test", [
        { file: "pushed.ts", content: "export const pushed = true;\n", message: "add pushed file" },
      ]);

      const roadmap = makeRoadmap("M040", "Push verification", [
        { id: "S01", title: "Push test" },
      ]);

      const result = mergeMilestoneToMain(repo, "M040", roadmap);

      // Verify merge succeeded (commit on main)
      const mainLog = run("git log --oneline main", repo);
      assertTrue(mainLog.includes("feat(M040)"), "milestone commit on main");

      // Manually push to verify remote works
      run("git push origin main", repo);
      const remoteLog = run("git log --oneline main", bareDir);
      assertTrue(remoteLog.includes("feat(M040)"), "milestone commit reachable on remote after manual push");

      // Temp-repo prefs may or may not be discoverable depending on process cwd and
      // current preference-loading behavior. The important contract is that remote
      // push mechanics work and the returned value reflects what happened.
      assertTrue(typeof result.pushed === "boolean", "pushed flag remains boolean");
    }

    // ─── Test 5: Auto-resolve .gsd/ state file conflicts (#530) ───────
    console.log("\n=== auto-resolve .gsd/ state file conflicts ===");
    {
      const repo = freshRepo();
      const wtPath = createAutoWorktree(repo, "M050");

      // Add a slice with real work
      addSliceToMilestone(repo, wtPath, "M050", "S01", "Conflict test", [
        { file: "feature.ts", content: "export const feature = true;\n", message: "add feature" },
      ]);

      // Modify .gsd/STATE.md on the milestone branch (simulates auto-mode state updates)
      writeFileSync(join(wtPath, ".gsd", "STATE.md"), "# State\n\n## Updated on milestone branch\n");
      run("git add .", wtPath);
      run('git commit -m "chore: update state on milestone branch"', wtPath);

      // Now modify .gsd/STATE.md on main too (simulates divergence)
      run("git checkout main", repo);
      writeFileSync(join(repo, ".gsd", "STATE.md"), "# State\n\n## Updated on main\n");
      run("git add .", repo);
      run('git commit -m "chore: update state on main"', repo);

      // Go back to worktree for the merge
      process.chdir(wtPath);

      const roadmap = makeRoadmap("M050", "Conflict resolution", [
        { id: "S01", title: "Conflict test" },
      ]);

      // Merge should succeed despite .gsd/STATE.md conflict — auto-resolved
      let threw = false;
      try {
        const result = mergeMilestoneToMain(repo, "M050", roadmap);
        assertTrue(result.commitMessage.includes("feat(M050)"), "merge commit created despite .gsd conflict");
      } catch (err) {
        threw = true;
      }
      assertTrue(!threw, "auto-resolves .gsd/ state file conflicts without throwing");

      // Feature file should be on main
      assertTrue(existsSync(join(repo, "feature.ts")), "feature.ts merged to main");
    }

    // ─── Test 6: Skip checkout when main already current (#757) ───────
    console.log("\n=== skip checkout when main already current (#757) ===");
    {
      const repo = freshRepo();
      const wtPath = createAutoWorktree(repo, "M060");

      addSliceToMilestone(repo, wtPath, "M060", "S01", "Skip checkout test", [
        { file: "skip-checkout.ts", content: "export const skip = true;\n", message: "add skip-checkout" },
      ]);

      const roadmap = makeRoadmap("M060", "Skip checkout verification", [
        { id: "S01", title: "Skip checkout test" },
      ]);

      // Verify main is already checked out at repo root (worktree default)
      const branchAtRoot = run("git rev-parse --abbrev-ref HEAD", repo);
      assertEq(branchAtRoot, "main", "main is already checked out at project root");

      // mergeMilestoneToMain should succeed without attempting to checkout main
      // (which would fail with "already used by worktree" error)
      let threw = false;
      try {
        const result = mergeMilestoneToMain(repo, "M060", roadmap);
        assertTrue(result.commitMessage.includes("feat(M060)"), "merge commit created");
      } catch (err) {
        threw = true;
        console.error("Unexpected error:", err);
      }
      assertTrue(!threw, "does not fail when main is already checked out at project root");

      // Verify the merge actually happened
      assertTrue(existsSync(join(repo, "skip-checkout.ts")), "skip-checkout.ts merged to main");
    }

    // ─── Test 7: Repo using `master` as default branch (#1668) ────────
    console.log("\n=== master-branch repo — no META.json, no prefs (#1668) ===");
    {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-ms-master-test-")));
      tempDirs.push(dir);
      run("git init -b master", dir);
      run("git config user.email test@test.com", dir);
      run("git config user.name Test", dir);
      writeFileSync(join(dir, "README.md"), "# master-branch repo\n");
      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(join(dir, ".gsd", "STATE.md"), "# State\n");
      run("git add .", dir);
      run("git commit -m init", dir);
      const defaultBranch = run("git rev-parse --abbrev-ref HEAD", dir);
      assertEq(defaultBranch, "master", "repo is on master branch");

      const wtPath = createAutoWorktree(dir, "M070");
      addSliceToMilestone(dir, wtPath, "M070", "S01", "Master branch test", [
        { file: "master-feature.ts", content: "export const masterFeature = true;\n", message: "add master feature" },
      ]);

      const metaFile = join(dir, ".gsd", "milestones", "M070", "M070-META.json");
      assertTrue(!existsSync(metaFile), "no META.json — integration branch not captured");

      const roadmap = makeRoadmap("M070", "Master branch milestone", [
        { id: "S01", title: "Master branch test" },
      ]);

      let threw = false;
      let errMsg = "";
      try {
        const result = mergeMilestoneToMain(dir, "M070", roadmap);
        assertTrue(result.commitMessage.includes("feat(M070)"), "merge commit created on master");
      } catch (err) {
        threw = true;
        errMsg = err instanceof Error ? err.message : String(err);
      }
      assertTrue(!threw, `should not throw on master-branch repo (got: ${errMsg})`);

      const finalBranch = run("git rev-parse --abbrev-ref HEAD", dir);
      assertEq(finalBranch, "master", "repo is still on master after merge");
      assertTrue(existsSync(join(dir, "master-feature.ts")), "feature merged to master");
      const branches = run("git branch", dir);
      assertTrue(!branches.includes("milestone/M070"), "milestone branch deleted after merge");
    }

    // ─── Test 8: #1738 Bug 1 — dirty working tree detected by nativeMergeSquash ──
    console.log("\n=== #1738 bug 1: nativeMergeSquash detects dirty working tree ===");
    {
      const { nativeMergeSquash } = await import("../native-git-bridge.ts");
      const repo = freshRepo();

      run("git checkout -b milestone/M070", repo);
      writeFileSync(join(repo, "feature.ts"), "export const feature = true;\n");
      run("git add .", repo);
      run('git commit -m "add feature"', repo);
      run("git checkout main", repo);

      writeFileSync(join(repo, "feature.ts"), "// local dirty version\n");

      const result = nativeMergeSquash(repo, "milestone/M070");
      assertEq(result.success, false, "merge reports failure on dirty working tree");
      assertTrue(
        result.conflicts.includes("__dirty_working_tree__"),
        "conflicts include __dirty_working_tree__ sentinel",
      );

      run("git checkout -- . 2>/dev/null || true", repo);
      run("rm -f feature.ts", repo);
    }

    // ─── Test 9: #1738 Bug 2 — branch preserved on empty squash commit ──
    console.log("\n=== #1738 bug 2: branch preserved when squash commit empty ===");
    {
      const repo = freshRepo();
      const wtPath = createAutoWorktree(repo, "M080");

      // Make no changes — squash will produce nothing to commit
      const roadmap = makeRoadmap("M080", "Empty milestone", []);

      // With the #1792 anchor check, empty milestones with no code changes
      // are safe to proceed — no data to lose.
      let threw = false;
      let errMsg = "";
      try {
        mergeMilestoneToMain(repo, "M080", roadmap);
      } catch (err: unknown) {
        threw = true;
        errMsg = err instanceof Error ? err.message : String(err);
      }
      assertTrue(!threw, `empty milestone with no code changes should not throw (got: ${errMsg})`);
    }

    // ─── Test 10: #1738 Bug 3 — clearProjectRootStateFiles cleans synced dirs ──
    console.log("\n=== #1738 bug 3: synced .gsd/ dirs cleaned before merge ===");
    {
      const repo = freshRepo();
      const wtPath = createAutoWorktree(repo, "M090");

      addSliceToMilestone(repo, wtPath, "M090", "S01", "Sync test", [
        { file: "sync-test.ts", content: "export const sync = true;\n", message: "add sync-test" },
      ]);

      // Simulate syncStateToProjectRoot: create untracked .gsd/ milestone files
      const msDir = join(repo, ".gsd", "milestones", "M090", "slices", "S01");
      mkdirSync(msDir, { recursive: true });
      writeFileSync(join(msDir, "S01-PLAN.md"), "# synced plan\n");
      writeFileSync(
        join(repo, ".gsd", "milestones", "M090", "M090-ROADMAP.md"),
        "# synced roadmap\n",
      );

      const runtimeDir = join(repo, ".gsd", "runtime", "units");
      mkdirSync(runtimeDir, { recursive: true });
      writeFileSync(join(runtimeDir, "unit-001.json"), '{"stale": true}');

      const roadmap = makeRoadmap("M090", "Sync cleanup test", [
        { id: "S01", title: "Sync test" },
      ]);

      let threw = false;
      try {
        const result = mergeMilestoneToMain(repo, "M090", roadmap);
        assertTrue(
          result.commitMessage.includes("feat(M090)"),
          "#1738 merge succeeds after cleaning synced dirs",
        );
      } catch (err: unknown) {
        threw = true;
        console.error("#1738 bug 3 regression:", err);
      }
      assertTrue(!threw, "#1738 merge does not fail on synced .gsd/ files");
      assertTrue(existsSync(join(repo, "sync-test.ts")), "sync-test.ts on main after merge");
    }

    // ─── Test 11: #1738 Bug 1+2 — dirty tree merge preserves branch end-to-end ──
    console.log("\n=== #1738 e2e: dirty tree rejection preserves branch ===");
    {
      const repo = freshRepo();
      const wtPath = createAutoWorktree(repo, "M100");

      addSliceToMilestone(repo, wtPath, "M100", "S01", "E2E test", [
        { file: "e2e.ts", content: "export const e2e = true;\n", message: "add e2e" },
      ]);

      writeFileSync(join(repo, "e2e.ts"), "// conflicting local file\n");

      const roadmap = makeRoadmap("M100", "E2E dirty tree", [
        { id: "S01", title: "E2E test" },
      ]);

      let threw = false;
      let errorMsg = "";
      try {
        mergeMilestoneToMain(repo, "M100", roadmap);
      } catch (err: unknown) {
        threw = true;
        errorMsg = err instanceof Error ? err.message : String(err);
      }
      assertTrue(threw, "#1738 e2e: throws on dirty working tree");
      assertTrue(
        errorMsg.includes("dirty") || errorMsg.includes("untracked") || errorMsg.includes("overwritten"),
        "#1738 e2e: error identifies dirty tree cause",
      );

      const branches = run("git branch", repo);
      assertTrue(
        branches.includes("milestone/M100"),
        "#1738 e2e: milestone branch preserved on dirty tree rejection",
      );
    }

    // ─── Test 12: Throw on unanchored code changes after empty commit (#1792) ─
    console.log("\n=== throw on unanchored code changes after empty commit (#1792) ===");
    {
      const repo = freshRepo();
      const wtPath = createAutoWorktree(repo, "M120");

      addSliceToMilestone(repo, wtPath, "M120", "S01", "Critical feature", [
        { file: "critical.ts", content: "export const critical = true;\n", message: "add critical feature" },
      ]);

      // Simulate: merge then revert — git considers branch "already merged"
      // but code is NOT on main (reverted).
      run(`git merge milestone/M120 --no-ff -m "merge M120"`, repo);
      run("git revert HEAD --no-edit -m 1", repo);

      const roadmap = makeRoadmap("M120", "Critical milestone", [
        { id: "S01", title: "Critical feature" },
      ]);

      let threw = false;
      let errMsg = "";
      try {
        mergeMilestoneToMain(repo, "M120", roadmap);
      } catch (err) {
        threw = true;
        errMsg = err instanceof Error ? err.message : String(err);
      }
      assertTrue(threw, "throws when milestone has unanchored code changes (#1792)");
      assertTrue(
        errMsg.includes("code file(s) not on"),
        "error message mentions unanchored code files (#1792)",
      );

      const branches = run("git branch", repo);
      assertTrue(
        branches.includes("milestone/M120"),
        "milestone branch preserved when code is unanchored (#1792)",
      );
    }

    // ─── Test 13: Safe teardown when nothing-to-commit and work already on main (#1792) ─
    console.log("\n=== safe teardown — nothing to commit, work already on main (#1792) ===");
    {
      const repo = freshRepo();
      const wtPath = createAutoWorktree(repo, "M130");

      addSliceToMilestone(repo, wtPath, "M130", "S01", "Already landed", [
        { file: "landed.ts", content: "export const landed = true;\n", message: "add landed feature" },
      ]);

      run("git merge --squash milestone/M130", repo);
      run('git commit -m "pre-land milestone work"', repo);

      const roadmap = makeRoadmap("M130", "Pre-landed milestone", [
        { id: "S01", title: "Already landed" },
      ]);

      let threw = false;
      let errMsg = "";
      try {
        mergeMilestoneToMain(repo, "M130", roadmap);
      } catch (err) {
        threw = true;
        errMsg = err instanceof Error ? err.message : String(err);
      }
      assertTrue(!threw, `safe nothing-to-commit should not throw (got: ${errMsg})`);
      assertTrue(existsSync(join(repo, "landed.ts")), "landed.ts present on main");
    }

    // ─── Test 14: Stale branch ref — worktree HEAD ahead of branch (#1846) ─
    console.log("\n=== stale branch ref — fast-forward before squash merge (#1846) ===");
    {
      const repo = freshRepo();
      const wtPath = createAutoWorktree(repo, "M140");

      // Add a first slice normally — this advances both the branch ref and HEAD
      addSliceToMilestone(repo, wtPath, "M140", "S01", "Initial work", [
        { file: "initial.ts", content: "export const initial = true;\n", message: "add initial" },
      ]);

      // Now simulate the bug: detach HEAD in the worktree, then make commits
      // that advance HEAD but leave the milestone/M140 branch ref behind.
      const branchRefBefore = run("git rev-parse milestone/M140", wtPath);
      run("git checkout --detach HEAD", wtPath);

      // Add multiple commits on the detached HEAD (simulates agent work)
      writeFileSync(join(wtPath, "feature-a.ts"), "export const featureA = true;\n");
      run("git add .", wtPath);
      run('git commit -m "add feature-a"', wtPath);

      writeFileSync(join(wtPath, "feature-b.ts"), "export const featureB = true;\n");
      run("git add .", wtPath);
      run('git commit -m "add feature-b"', wtPath);

      writeFileSync(join(wtPath, "feature-c.ts"), "export const featureC = true;\n");
      run("git add .", wtPath);
      run('git commit -m "add feature-c"', wtPath);

      // Verify: branch ref is stale, HEAD is ahead
      const branchRefAfter = run("git rev-parse milestone/M140", wtPath);
      const worktreeHead = run("git rev-parse HEAD", wtPath);
      assertEq(branchRefBefore, branchRefAfter, "branch ref unchanged (stale)");
      assertTrue(worktreeHead !== branchRefAfter, "worktree HEAD ahead of branch ref");

      const roadmap = makeRoadmap("M140", "Stale ref milestone", [
        { id: "S01", title: "Initial work" },
      ]);

      // The fix should fast-forward the branch ref to worktree HEAD before
      // squash-merging, so ALL commits are captured.
      let threw = false;
      let errMsg = "";
      try {
        const result = mergeMilestoneToMain(repo, "M140", roadmap);
        assertTrue(result.commitMessage.includes("feat(M140)"), "merge commit created");
      } catch (err) {
        threw = true;
        errMsg = err instanceof Error ? err.message : String(err);
      }
      assertTrue(!threw, `should not throw with stale branch ref (got: ${errMsg})`);

      // ALL files from detached HEAD commits must be on main — not just
      // the ones from the stale branch ref
      assertTrue(existsSync(join(repo, "initial.ts")), "initial.ts on main");
      assertTrue(existsSync(join(repo, "feature-a.ts")), "feature-a.ts on main (#1846)");
      assertTrue(existsSync(join(repo, "feature-b.ts")), "feature-b.ts on main (#1846)");
      assertTrue(existsSync(join(repo, "feature-c.ts")), "feature-c.ts on main (#1846)");
    }

    // ─── Test 15: Diverged worktree HEAD — throws instead of losing data (#1846) ─
    console.log("\n=== diverged worktree HEAD — throws on divergence (#1846) ===");
    {
      const repo = freshRepo();
      const wtPath = createAutoWorktree(repo, "M150");

      addSliceToMilestone(repo, wtPath, "M150", "S01", "Base work", [
        { file: "base.ts", content: "export const base = true;\n", message: "add base" },
      ]);

      run("git checkout --detach HEAD", wtPath);
      writeFileSync(join(wtPath, "detached-work.ts"), "export const detached = true;\n");
      run("git add .", wtPath);
      run('git commit -m "detached work"', wtPath);

      run("git checkout milestone/M150", repo);
      writeFileSync(join(repo, "diverged-work.ts"), "export const diverged = true;\n");
      run("git add .", repo);
      run('git commit -m "diverged work on branch"', repo);
      run("git checkout main", repo);

      process.chdir(wtPath);

      const roadmap = makeRoadmap("M150", "Diverged milestone", [
        { id: "S01", title: "Base work" },
      ]);

      let threw = false;
      let errMsg = "";
      try {
        mergeMilestoneToMain(repo, "M150", roadmap);
      } catch (err) {
        threw = true;
        errMsg = err instanceof Error ? err.message : String(err);
      }
      assertTrue(threw, "throws when worktree HEAD diverged from branch ref (#1846)");
      assertTrue(errMsg.includes("diverged"), "error message mentions divergence (#1846)");

      const branches = run("git branch", repo);
      assertTrue(branches.includes("milestone/M150"), "milestone branch preserved on divergence (#1846)");
    }

    // ─── Test 16: #1853 Bug 1 — SQUASH_MSG cleaned up after squash-merge ──
    console.log("\n=== #1853 bug 1: SQUASH_MSG cleaned up after successful squash-merge ===");
    {
      const repo = freshRepo();
      const wtPath = createAutoWorktree(repo, "M160");

      addSliceToMilestone(repo, wtPath, "M160", "S01", "SQUASH_MSG cleanup test", [
        { file: "squash-cleanup.ts", content: "export const cleanup = true;\n", message: "add squash-cleanup" },
      ]);

      const roadmap = makeRoadmap("M160", "SQUASH_MSG cleanup", [
        { id: "S01", title: "SQUASH_MSG cleanup test" },
      ]);

      const squashMsgPath = join(repo, ".git", "SQUASH_MSG");
      writeFileSync(squashMsgPath, "leftover squash message\n");
      assertTrue(existsSync(squashMsgPath), "SQUASH_MSG planted before merge");

      const result = mergeMilestoneToMain(repo, "M160", roadmap);
      assertTrue(result.commitMessage.includes("feat(M160)"), "merge commit created");

      assertTrue(
        !existsSync(squashMsgPath),
        "#1853: SQUASH_MSG must not persist after successful squash-merge",
      );
    }

    // ─── Test 17: #1853 Bug 2 — uncommitted worktree code survives teardown ──
    console.log("\n=== #1853 bug 2: uncommitted worktree changes committed before teardown ===");
    {
      const repo = freshRepo();
      const wtPath = createAutoWorktree(repo, "M170");

      addSliceToMilestone(repo, wtPath, "M170", "S01", "Teardown safety test", [
        { file: "safe-file.ts", content: "export const safe = true;\n", message: "add safe file" },
      ]);

      writeFileSync(join(wtPath, "uncommitted-agent-code.ts"), "export const lost = true;\n");

      const roadmap = makeRoadmap("M170", "Teardown safety", [
        { id: "S01", title: "Teardown safety test" },
      ]);

      const result = mergeMilestoneToMain(repo, "M170", roadmap);
      assertTrue(result.commitMessage.includes("feat(M170)"), "merge commit created");

      assertTrue(
        existsSync(join(repo, "uncommitted-agent-code.ts")),
        "#1853: uncommitted worktree code must survive teardown",
      );
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
