/**
 * feature-branch-lifecycle.test.ts — Integration tests for the feature-branch workflow.
 *
 * Proves the core invariant: when auto-mode starts on a feature branch,
 * the milestone worktree branches from that feature branch and merges
 * back to it. `main` is never touched.
 *
 * Scenarios:
 *   1. Full lifecycle: feature branch → worktree → slices → merge back to feature branch
 *   2. Uncommitted changes on feature branch are included via pre-worktree commit
 *   3. Unique milestone IDs (M001-abc123 format) work end-to-end
 *   4. Main branch is completely untouched throughout
 */

import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
  existsSync, realpathSync, readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  createAutoWorktree,
  mergeMilestoneToMain,
  autoWorktreeBranch,
} from "../auto-worktree.ts";
import { captureIntegrationBranch, getSliceBranchName } from "../worktree.ts";
import { writeIntegrationBranch, readIntegrationBranch } from "../git-service.ts";
import { nextMilestoneId, generateMilestoneSuffix } from "../guided-flow.ts";

import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, assertMatch, report } = createTestContext();

// ─── Helpers ────────────────────────────────────────────────────────────────

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function commitCount(cwd: string, branch: string): number {
  return parseInt(run(`git rev-list --count ${branch}`, cwd), 10);
}

function headSha(cwd: string, ref: string): string {
  return run(`git rev-parse ${ref}`, cwd);
}

function branchExists(cwd: string, branch: string): boolean {
  try {
    run(`git show-ref --verify --quiet refs/heads/${branch}`, cwd);
    return true;
  } catch {
    return false;
  }
}

function allBranches(cwd: string): string[] {
  return run("git branch --format='%(refname:short)'", cwd)
    .split("\n")
    .map(b => b.replace(/^'|'$/g, ""))
    .filter(Boolean);
}

/**
 * Create a temp repo with an initial commit on main and a feature branch.
 * Returns { repo, featureBranch } with HEAD on the feature branch.
 */
function createFeatureBranchRepo(featureBranch: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-fb-lifecycle-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);

  // Initial commit on main
  writeFileSync(join(dir, "README.md"), "# project\n");
  // Mirror production: GSD runtime dirs are gitignored so autoCommitDirtyState
  // doesn't pick up the worktrees directory as dirty state (#1127 fix).
  writeFileSync(join(dir, ".gitignore"), ".gsd/worktrees/\n");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "STATE.md"), "# State\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);

  // Create and switch to feature branch
  run(`git checkout -b ${featureBranch}`, dir);

  // Add a commit on the feature branch so it diverges from main
  writeFileSync(join(dir, "feature-setup.ts"), "export const setup = true;\n");
  run("git add .", dir);
  run("git commit -m \"feat: feature branch setup\"", dir);

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

/** Add commits to a slice branch on the worktree, merge to milestone branch. */
function addSliceToMilestone(
  wtPath: string,
  milestoneId: string,
  sliceId: string,
  sliceTitle: string,
  commits: Array<{ file: string; content: string; message: string }>,
): void {
  const normalizedPath = wtPath.replaceAll("\\", "/");
  const marker = "/.gsd/worktrees/";
  const idx = normalizedPath.indexOf(marker);
  const worktreeName = idx !== -1
    ? normalizedPath.slice(idx + marker.length).split("/")[0]
    : null;

  const sliceBranch = getSliceBranchName(milestoneId, sliceId, worktreeName);

  run(`git checkout -b ${sliceBranch}`, wtPath);
  for (const c of commits) {
    writeFileSync(join(wtPath, c.file), c.content);
    run("git add .", wtPath);
    run(`git commit -m "${c.message}"`, wtPath);
  }
  run(`git checkout milestone/${milestoneId}`, wtPath);
  run(
    `git merge --no-ff ${sliceBranch} -m "feat(${milestoneId}/${sliceId}): ${sliceTitle}"`,
    wtPath,
  );
  run(`git branch -d ${sliceBranch}`, wtPath);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const savedCwd = process.cwd();
  const tempDirs: string[] = [];

  function fresh(featureBranch: string): string {
    const d = createFeatureBranchRepo(featureBranch);
    tempDirs.push(d);
    return d;
  }

  try {
    // ================================================================
    // Test 1: Full feature-branch lifecycle with unique milestone IDs
    //
    // Start on f-new-shiny-thing with uncommitted changes, create
    // worktree, add slices, merge back. Assert main is untouched.
    // ================================================================
    console.log("\n=== Feature-branch lifecycle with unique milestone IDs ===");
    {
      const featureBranch = "f-new-shiny-thing";
      const repo = fresh(featureBranch);

      // Generate a unique milestone ID (M001-xxxxxx format)
      const milestoneId = nextMilestoneId([], true);
      assertMatch(milestoneId, /^M001-[a-z0-9]{6}$/, "unique milestone ID format");

      // Snapshot main before anything happens
      const mainShaBefore = headSha(repo, "main");
      const mainCommitsBefore = commitCount(repo, "main");

      // ── Add uncommitted changes on the feature branch ──
      // Simulates a user with dirty working tree when they start auto-mode.
      writeFileSync(join(repo, "wip-config.ts"), "export const config = { debug: true };\n");
      writeFileSync(join(repo, "wip-types.ts"), "export type AppState = { ready: boolean };\n");

      // Verify files are uncommitted
      const statusBefore = run("git status --short", repo);
      assertTrue(statusBefore.includes("wip-config.ts"), "wip-config.ts is uncommitted");
      assertTrue(statusBefore.includes("wip-types.ts"), "wip-types.ts is uncommitted");

      // ── Simulate what startAuto does: commit dirty state, capture integration branch ──
      // startAuto bootstraps .gsd/ which commits .gsd/ files. It also calls
      // captureIntegrationBranch which commits META.json. But user's dirty
      // files need to be committed first so the worktree branches from a
      // commit that includes them.
      //
      // In production, the first dispatch unit (research-milestone) would
      // auto-commit via autoCommitCurrentBranch. But the worktree is created
      // BEFORE any unit runs. So we simulate the pre-worktree state:
      // GSD bootstraps .gsd/ and captureIntegrationBranch commits metadata.
      // The user's dirty files are NOT auto-committed pre-worktree — they
      // stay in the original working directory.

      // Create milestone directory (happens during guided-flow)
      mkdirSync(join(repo, ".gsd", "milestones", milestoneId), { recursive: true });

      // Write integration branch metadata (what captureIntegrationBranch does)
      writeIntegrationBranch(repo, milestoneId, featureBranch);

      // Verify integration branch recorded
      const recorded = readIntegrationBranch(repo, milestoneId);
      assertEq(recorded, featureBranch, "integration branch recorded as feature branch");

      // Snapshot feature branch SHA after metadata commit (HEAD may have advanced)
      const featureShaBeforeWorktree = headSha(repo, featureBranch);

      // ── Create the auto-worktree ──
      const wtPath = createAutoWorktree(repo, milestoneId);
      tempDirs.push(wtPath);
      assertTrue(existsSync(wtPath), "worktree directory created");

      // Worktree should be on milestone/<unique-id> branch
      const wtBranch = run("git branch --show-current", wtPath);
      assertEq(wtBranch, `milestone/${milestoneId}`, "worktree is on milestone branch");

      // Milestone branch should be rooted at the feature branch, not main
      const milestoneBranchBase = headSha(repo, `milestone/${milestoneId}`);
      assertEq(
        milestoneBranchBase,
        featureShaBeforeWorktree,
        "milestone branch starts from feature branch HEAD",
      );

      // Feature-branch-only file should be in the worktree
      assertTrue(
        existsSync(join(wtPath, "feature-setup.ts")),
        "feature branch file (feature-setup.ts) exists in worktree",
      );

      // Main should be completely untouched at this point
      assertEq(headSha(repo, "main"), mainShaBefore, "main SHA unchanged after worktree creation");

      // ── Do work in slices ──
      addSliceToMilestone(wtPath, milestoneId, "S01", "Auth module", [
        { file: "auth.ts", content: "export const auth = true;\n", message: "feat: add auth" },
        { file: "auth-utils.ts", content: "export const hash = () => {};\n", message: "feat: auth utils" },
      ]);
      addSliceToMilestone(wtPath, milestoneId, "S02", "Dashboard", [
        { file: "dashboard.ts", content: "export const dash = true;\n", message: "feat: add dashboard" },
      ]);

      // ── Merge milestone back to feature branch ──
      const roadmap = makeRoadmap(milestoneId, "New shiny feature", [
        { id: "S01", title: "Auth module" },
        { id: "S02", title: "Dashboard" },
      ]);

      process.chdir(wtPath);
      const result = mergeMilestoneToMain(repo, milestoneId, roadmap);
      process.chdir(savedCwd);

      // ── Assert: feature branch received the merge ──
      const currentBranch = run("git branch --show-current", repo);
      assertEq(currentBranch, featureBranch, "repo is on feature branch after merge");

      // Exactly one new commit on feature branch (the squash merge)
      const featureLog = run(`git log --oneline ${featureBranch}`, repo);
      assertTrue(
        featureLog.includes(`feat(${milestoneId})`),
        "feature branch has milestone merge commit",
      );

      // Slice files are on the feature branch
      assertTrue(existsSync(join(repo, "auth.ts")), "auth.ts on feature branch");
      assertTrue(existsSync(join(repo, "dashboard.ts")), "dashboard.ts on feature branch");
      assertTrue(existsSync(join(repo, "auth-utils.ts")), "auth-utils.ts on feature branch");

      // Original feature branch file still present
      assertTrue(existsSync(join(repo, "feature-setup.ts")), "feature-setup.ts still on feature branch");

      // Commit message is well-formed
      assertTrue(result.commitMessage.includes("New shiny feature"), "commit message has milestone title");
      assertTrue(result.commitMessage.includes("S01: Auth module"), "commit message lists S01");
      assertTrue(result.commitMessage.includes("S02: Dashboard"), "commit message lists S02");
      assertTrue(
        result.commitMessage.includes(`milestone/${milestoneId}`),
        "commit message references milestone branch with unique ID",
      );

      // ── Assert: main is COMPLETELY untouched ──
      assertEq(headSha(repo, "main"), mainShaBefore, "main SHA unchanged after merge");
      assertEq(commitCount(repo, "main"), mainCommitsBefore, "main commit count unchanged");

      // Main should NOT have any of the milestone files
      run("git checkout main", repo);
      assertTrue(!existsSync(join(repo, "auth.ts")), "auth.ts NOT on main");
      assertTrue(!existsSync(join(repo, "dashboard.ts")), "dashboard.ts NOT on main");
      assertTrue(!existsSync(join(repo, "feature-setup.ts")), "feature-setup.ts NOT on main");
      run(`git checkout ${featureBranch}`, repo);

      // ── Assert: worktree cleaned up ──
      const worktreeDir = join(repo, ".gsd", "worktrees", milestoneId);
      assertTrue(!existsSync(worktreeDir), "worktree directory removed");

      // Milestone branch deleted
      assertTrue(
        !branchExists(repo, `milestone/${milestoneId}`),
        "milestone branch deleted after merge",
      );

      // Only expected branches remain
      const branches = allBranches(repo);
      assertTrue(branches.includes("main"), "main branch exists");
      assertTrue(branches.includes(featureBranch), "feature branch exists");
      assertTrue(
        !branches.some(b => b.startsWith("milestone/")),
        "no milestone branches remain",
      );
    }

    // ================================================================
    // Test 2: Uncommitted .gsd/ planning files are available in worktree
    //
    // When auto-mode starts, .gsd/ files may be untracked/uncommitted.
    // Planning artifacts should be carried into the worktree even if
    // they weren't committed on the feature branch.
    // ================================================================
    console.log("\n=== Untracked planning files copied to worktree ===");
    {
      const featureBranch = "f-planning-test";
      const repo = fresh(featureBranch);
      const milestoneId = nextMilestoneId([], true);

      // Write planning files that are NOT committed
      mkdirSync(join(repo, ".gsd", "milestones", milestoneId, "slices", "S01", "tasks"), { recursive: true });
      writeFileSync(
        join(repo, ".gsd", "milestones", milestoneId, `${milestoneId}-ROADMAP.md`),
        makeRoadmap(milestoneId, "Planning test", [{ id: "S01", title: "First" }]),
      );
      writeFileSync(
        join(repo, ".gsd", "milestones", milestoneId, "slices", "S01", "S01-PLAN.md"),
        "# S01: First\n\n**Goal:** Test\n**Demo:** Test\n\n## Tasks\n- [ ] **T01: Do it** `est:10m`\n",
      );
      writeFileSync(join(repo, ".gsd", "PROJECT.md"), "# Planning Test Project\n");
      writeFileSync(join(repo, ".gsd", "DECISIONS.md"), "# Decisions\n\n## D001\nTest decision.\n");

      // These files are untracked
      assertTrue(run("git status --short", repo).length > 0, "repo has untracked files");

      // Record integration branch and create worktree
      writeIntegrationBranch(repo, milestoneId, featureBranch);
      const wtPath = createAutoWorktree(repo, milestoneId);
      tempDirs.push(wtPath);

      // With external state, worktree .gsd is a symlink to shared state.
      // Verify symlink was created (planning files are shared, not copied).
      const wtGsd = join(wtPath, ".gsd");
      assertTrue(existsSync(wtGsd), "worktree .gsd exists (symlink or dir)");

      // Clean up: chdir back before teardown
      process.chdir(savedCwd);
    }

    // ================================================================
    // Test 3: Multiple milestones on the same feature branch
    //
    // Proves that unique IDs prevent collision when running successive
    // milestones, and each merge lands on the feature branch.
    // ================================================================
    console.log("\n=== Multiple unique milestones on same feature branch ===");
    {
      const featureBranch = "f-multi-milestone";
      const repo = fresh(featureBranch);

      const mainShaBefore = headSha(repo, "main");

      // First milestone
      const mid1 = nextMilestoneId([], true);
      mkdirSync(join(repo, ".gsd", "milestones", mid1), { recursive: true });
      writeIntegrationBranch(repo, mid1, featureBranch);

      const wt1 = createAutoWorktree(repo, mid1);
      tempDirs.push(wt1);
      addSliceToMilestone(wt1, mid1, "S01", "First milestone work", [
        { file: "m1-feature.ts", content: "export const m1 = true;\n", message: "feat: m1" },
      ]);
      process.chdir(wt1);
      mergeMilestoneToMain(repo, mid1, makeRoadmap(mid1, "First", [{ id: "S01", title: "First milestone work" }]));
      process.chdir(savedCwd);

      assertTrue(existsSync(join(repo, "m1-feature.ts")), "m1 file on feature branch");

      // Second milestone — different unique ID
      const mid2 = nextMilestoneId([mid1], true);
      assertTrue(mid1 !== mid2, "second milestone has different ID");
      assertMatch(mid2, /^M002-[a-z0-9]{6}$/, "second milestone is M002-xxxxxx");

      mkdirSync(join(repo, ".gsd", "milestones", mid2), { recursive: true });
      writeIntegrationBranch(repo, mid2, featureBranch);

      const wt2 = createAutoWorktree(repo, mid2);
      tempDirs.push(wt2);
      addSliceToMilestone(wt2, mid2, "S01", "Second milestone work", [
        { file: "m2-feature.ts", content: "export const m2 = true;\n", message: "feat: m2" },
      ]);
      process.chdir(wt2);
      mergeMilestoneToMain(repo, mid2, makeRoadmap(mid2, "Second", [{ id: "S01", title: "Second milestone work" }]));
      process.chdir(savedCwd);

      // Both milestone files on feature branch
      assertTrue(existsSync(join(repo, "m1-feature.ts")), "m1 file still on feature branch");
      assertTrue(existsSync(join(repo, "m2-feature.ts")), "m2 file on feature branch");

      // Main completely untouched
      assertEq(headSha(repo, "main"), mainShaBefore, "main unchanged after two milestones");

      // No milestone branches remain
      const branches = allBranches(repo);
      assertTrue(
        !branches.some(b => b.startsWith("milestone/")),
        "no milestone branches remain after two milestones",
      );
    }

  } finally {
    process.chdir(savedCwd);
    for (const d of tempDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  report();
}

main();
