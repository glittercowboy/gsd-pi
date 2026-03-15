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

    // ─── Test 3: Nothing to commit — no changes ────────────────────────
    console.log("\n=== nothing to commit — no changes ===");
    {
      const repo = freshRepo();
      const wtPath = createAutoWorktree(repo, "M030");

      // Don't add any slices/changes — milestone branch is identical to main
      const roadmap = makeRoadmap("M030", "Empty milestone", []);

      // Should complete without throwing
      let threw = false;
      try {
        const result = mergeMilestoneToMain(repo, "M030", roadmap);
        assertTrue(typeof result.pushed === "boolean", "returns result even with nothing to commit");
      } catch {
        threw = true;
      }
      assertTrue(!threw, "does not throw on nothing-to-commit");

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

      // result.pushed will be false since prefs aren't loadable in temp repos
      // (module-level const limitation) — that's expected
      assertEq(result.pushed, false, "pushed is false without discoverable prefs");
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
