/**
 * auto-worktree-milestone-merge.test.ts — Integration tests for mergeMilestoneToMain.
 *
 * Covers: squash-merge topology (one commit on main), rich commit message with
 * slice titles, worktree cleanup, nothing-to-commit edge case, auto-push with
 * bare remote. All tests use real git operations in temp repos.
 *
 * Note: execSync is used intentionally in these tests for git operations with
 * controlled, hardcoded inputs (no user input). This is safe and necessary for
 * testing real git behavior.
 */

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  createAutoWorktree,
  mergeMilestoneToMain,
  getAutoWorktreeOriginalBase,
} from "../../auto-worktree.ts";
import { getSliceBranchName } from "../../worktree.ts";
import { nativeMergeSquash } from "../../native-git-bridge.ts";

function run(cmd: string, cwd: string): string {
  // Safe: all inputs are hardcoded test strings, not user input
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
  run(`git branch -d ${sliceBranch}`, wtPath);
}

describe("auto-worktree-milestone-merge", { timeout: 300_000 }, () => {
  const savedCwd = process.cwd();
  const tempDirs: string[] = [];

  function freshRepo(): string {
    const d = createTempRepo();
    tempDirs.push(d);
    return d;
  }

  afterEach(() => {
    process.chdir(savedCwd);
    for (const d of tempDirs) {
      if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("basic squash merge — one commit on main", () => {
    const repo = freshRepo();
    const wtPath = createAutoWorktree(repo, "M010");

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

    const mainLog = run("git log --oneline main", repo);
    const mainCommitCountAfter = mainLog.split("\n").length;
    assert.strictEqual(mainCommitCountAfter, mainCommitCountBefore + 1, "exactly one new commit on main");

    const branches = run("git branch", repo);
    assert.ok(!branches.includes("milestone/M010"), "milestone branch deleted");

    const worktreeDir = join(repo, ".gsd", "worktrees", "M010");
    assert.ok(!existsSync(worktreeDir), "worktree directory removed");

    assert.strictEqual(getAutoWorktreeOriginalBase(), null, "originalBase cleared after merge");

    assert.ok(existsSync(join(repo, "auth.ts")), "auth.ts on main");
    assert.ok(existsSync(join(repo, "dashboard.ts")), "dashboard.ts on main");
    assert.ok(existsSync(join(repo, "widgets.ts")), "widgets.ts on main");

    assert.ok(result.commitMessage.length > 0, "commitMessage returned");
    assert.strictEqual(typeof result.pushed, "boolean", "pushed is boolean");
  });

  test("rich commit message format", () => {
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

    assert.match(result.commitMessage, /^feat:/, "subject has conventional commit prefix without milestone ID");
    assert.ok(result.commitMessage.includes("Backend foundation"), "subject includes milestone title");
    assert.ok(result.commitMessage.includes("- S01: Core API"), "body lists S01");
    assert.ok(result.commitMessage.includes("- S02: Error handling"), "body lists S02");
    assert.ok(result.commitMessage.includes("- S03: Logging infra"), "body lists S03");
    assert.ok(result.commitMessage.includes("GSD-Milestone: M020"), "body has GSD-Milestone trailer");
    assert.ok(result.commitMessage.includes("Branch: milestone/M020"), "body has branch metadata");

    const gitMsg = run("git log -1 --format=%B main", repo).trim();
    assert.match(gitMsg, /^feat:/, "git commit message starts with feat:");
    assert.ok(gitMsg.includes("GSD-Milestone: M020"), "git commit has GSD-Milestone trailer");
    assert.ok(gitMsg.includes("- S01: Core API"), "git commit body has S01");
  });

  test("nothing to commit — safe when no code changes (#1738, #1792)", () => {
    const repo = freshRepo();
    const wtPath = createAutoWorktree(repo, "M030");
    const roadmap = makeRoadmap("M030", "Empty milestone", []);

    let threw = false;
    let errorMsg = "";
    try {
      mergeMilestoneToMain(repo, "M030", roadmap);
    } catch (err: unknown) {
      threw = true;
      errorMsg = err instanceof Error ? err.message : String(err);
    }
    assert.ok(!threw, `safe empty milestone should not throw (got: ${errorMsg})`);

    const mainLog = run("git log --oneline main", repo);
    assert.strictEqual(mainLog.split("\n").length, 1, "main still has only init commit");
  });

  test("auto-push with bare remote", () => {
    const repo = freshRepo();

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

    const mainLog = run("git log --oneline main", repo);
    assert.ok(mainLog.includes("feat:"), "milestone commit on main");

    run("git push origin main", repo);
    const remoteLog = run("git log --oneline main", bareDir);
    assert.ok(remoteLog.includes("feat:"), "milestone commit reachable on remote after manual push");

    assert.strictEqual(typeof result.pushed, "boolean", "pushed flag remains boolean");
  });

  test("auto-resolve .gsd/ state file conflicts", () => {
    const repo = freshRepo();
    const wtPath = createAutoWorktree(repo, "M050");

    addSliceToMilestone(repo, wtPath, "M050", "S01", "Conflict test", [
      { file: "feature.ts", content: "export const feature = true;\n", message: "add feature" },
    ]);

    writeFileSync(join(wtPath, ".gsd", "STATE.md"), "# State\n\n## Updated on milestone branch\n");
    run("git add .", wtPath);
    run('git commit -m "chore: update state on milestone branch"', wtPath);

    run("git checkout main", repo);
    writeFileSync(join(repo, ".gsd", "STATE.md"), "# State\n\n## Updated on main\n");
    run("git add .", repo);
    run('git commit -m "chore: update state on main"', repo);

    process.chdir(wtPath);

    const roadmap = makeRoadmap("M050", "Conflict resolution", [
      { id: "S01", title: "Conflict test" },
    ]);

    let threw = false;
    try {
      const result = mergeMilestoneToMain(repo, "M050", roadmap);
      assert.ok(result.commitMessage.includes("feat:") && result.commitMessage.includes("GSD-Milestone: M050"), "merge commit created despite .gsd conflict");
    } catch (err) {
      threw = true;
    }
    assert.ok(!threw, "auto-resolves .gsd/ state file conflicts without throwing");
    assert.ok(existsSync(join(repo, "feature.ts")), "feature.ts merged to main");
  });

  test("skip checkout when main already current (#757)", () => {
    const repo = freshRepo();
    const wtPath = createAutoWorktree(repo, "M060");

    addSliceToMilestone(repo, wtPath, "M060", "S01", "Skip checkout test", [
      { file: "skip-checkout.ts", content: "export const skip = true;\n", message: "add skip-checkout" },
    ]);

    const roadmap = makeRoadmap("M060", "Skip checkout verification", [
      { id: "S01", title: "Skip checkout test" },
    ]);

    const branchAtRoot = run("git rev-parse --abbrev-ref HEAD", repo);
    assert.strictEqual(branchAtRoot, "main", "main is already checked out at project root");

    let threw = false;
    try {
      const result = mergeMilestoneToMain(repo, "M060", roadmap);
      assert.ok(result.commitMessage.includes("feat:") && result.commitMessage.includes("GSD-Milestone: M060"), "merge commit created");
    } catch (err) {
      threw = true;
    }
    assert.ok(!threw, "does not fail when main is already checked out at project root");
    assert.ok(existsSync(join(repo, "skip-checkout.ts")), "skip-checkout.ts merged to main");
  });

  test("master-branch repo — no META.json, no prefs (#1668)", () => {
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
    assert.strictEqual(defaultBranch, "master", "repo is on master branch");

    const wtPath = createAutoWorktree(dir, "M070");
    addSliceToMilestone(dir, wtPath, "M070", "S01", "Master branch test", [
      { file: "master-feature.ts", content: "export const masterFeature = true;\n", message: "add master feature" },
    ]);

    const metaFile = join(dir, ".gsd", "milestones", "M070", "M070-META.json");
    assert.ok(!existsSync(metaFile), "no META.json — integration branch not captured");

    const roadmap = makeRoadmap("M070", "Master branch milestone", [
      { id: "S01", title: "Master branch test" },
    ]);

    let threw = false;
    let errMsg = "";
    try {
      const result = mergeMilestoneToMain(dir, "M070", roadmap);
      assert.ok(result.commitMessage.includes("feat:") && result.commitMessage.includes("GSD-Milestone: M070"), "merge commit created on master");
    } catch (err) {
      threw = true;
      errMsg = err instanceof Error ? err.message : String(err);
    }
    assert.ok(!threw, `should not throw on master-branch repo (got: ${errMsg})`);

    const finalBranch = run("git rev-parse --abbrev-ref HEAD", dir);
    assert.strictEqual(finalBranch, "master", "repo is still on master after merge");
    assert.ok(existsSync(join(dir, "master-feature.ts")), "feature merged to master");
    const branches = run("git branch", dir);
    assert.ok(!branches.includes("milestone/M070"), "milestone branch deleted after merge");
  });

  test("#1738 bug 1: nativeMergeSquash detects dirty working tree", async () => {
    const { nativeMergeSquash } = await import("../../native-git-bridge.ts");
    const repo = freshRepo();

    run("git checkout -b milestone/M070", repo);
    writeFileSync(join(repo, "feature.ts"), "export const feature = true;\n");
    run("git add .", repo);
    run('git commit -m "add feature"', repo);
    run("git checkout main", repo);

    writeFileSync(join(repo, "feature.ts"), "// local dirty version\n");

    const result = nativeMergeSquash(repo, "milestone/M070");
    assert.strictEqual(result.success, false, "merge reports failure on dirty working tree");
    assert.ok(
      result.conflicts.includes("__dirty_working_tree__"),
      "conflicts include __dirty_working_tree__ sentinel",
    );

    run("git checkout -- . 2>/dev/null || true", repo);
    run("rm -f feature.ts", repo);
  });

  test("#1738 bug 2: branch preserved when squash commit empty", () => {
    const repo = freshRepo();
    const wtPath = createAutoWorktree(repo, "M080");
    const roadmap = makeRoadmap("M080", "Empty milestone", []);

    let threw = false;
    let errMsg = "";
    try {
      mergeMilestoneToMain(repo, "M080", roadmap);
    } catch (err: unknown) {
      threw = true;
      errMsg = err instanceof Error ? err.message : String(err);
    }
    assert.ok(!threw, `empty milestone with no code changes should not throw (got: ${errMsg})`);
  });

  test("#1738 bug 3: synced .gsd/ dirs cleaned before merge", () => {
    const repo = freshRepo();
    const wtPath = createAutoWorktree(repo, "M090");

    addSliceToMilestone(repo, wtPath, "M090", "S01", "Sync test", [
      { file: "sync-test.ts", content: "export const sync = true;\n", message: "add sync-test" },
    ]);

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
      assert.ok(result.commitMessage.includes("feat:") && result.commitMessage.includes("GSD-Milestone: M090"), "#1738 merge succeeds after cleaning synced dirs");
    } catch (err: unknown) {
      threw = true;
    }
    assert.ok(!threw, "#1738 merge does not fail on synced .gsd/ files");
    assert.ok(existsSync(join(repo, "sync-test.ts")), "sync-test.ts on main after merge");
  });

  test("#1738 e2e: dirty tree is stashed before merge (#2151)", () => {
    const repo = freshRepo();
    const wtPath = createAutoWorktree(repo, "M100");

    addSliceToMilestone(repo, wtPath, "M100", "S01", "E2E test", [
      { file: "e2e.ts", content: "export const e2e = true;\n", message: "add e2e" },
    ]);

    writeFileSync(join(repo, "e2e.ts"), "// conflicting local file\n");

    const roadmap = makeRoadmap("M100", "E2E dirty tree", [
      { id: "S01", title: "E2E test" },
    ]);

    // Since #2151, dirty files are stashed before the squash merge instead
    // of causing an immediate rejection.  The merge should succeed.
    let threw = false;
    try {
      const result = mergeMilestoneToMain(repo, "M100", roadmap);
      assert.ok(result.commitMessage.includes("feat:") && result.commitMessage.includes("GSD-Milestone: M100"), "#2151: merge succeeds after stashing dirty files");
    } catch {
      threw = true;
    }
    assert.ok(!threw, "#2151: dirty tree no longer rejects — stash handles it");
  });

  test("throw on unanchored code changes after empty commit (#1792)", () => {
    const repo = freshRepo();
    const wtPath = createAutoWorktree(repo, "M120");

    addSliceToMilestone(repo, wtPath, "M120", "S01", "Critical feature", [
      { file: "critical.ts", content: "export const critical = true;\n", message: "add critical feature" },
    ]);

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
    assert.ok(threw, "throws when milestone has unanchored code changes (#1792)");
    assert.ok(errMsg.includes("code file(s) not on"), "error message mentions unanchored code files (#1792)");

    const branches = run("git branch", repo);
    assert.ok(branches.includes("milestone/M120"), "milestone branch preserved when code is unanchored (#1792)");
  });

  test("safe teardown — nothing to commit, work already on main (#1792)", () => {
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
    assert.ok(!threw, `safe nothing-to-commit should not throw (got: ${errMsg})`);
    assert.ok(existsSync(join(repo, "landed.ts")), "landed.ts present on main");
  });

  test("stale branch ref — fast-forward before squash merge (#1846)", () => {
    const repo = freshRepo();
    const wtPath = createAutoWorktree(repo, "M140");

    addSliceToMilestone(repo, wtPath, "M140", "S01", "Initial work", [
      { file: "initial.ts", content: "export const initial = true;\n", message: "add initial" },
    ]);

    const branchRefBefore = run("git rev-parse milestone/M140", wtPath);
    run("git checkout --detach HEAD", wtPath);

    writeFileSync(join(wtPath, "feature-a.ts"), "export const featureA = true;\n");
    run("git add .", wtPath);
    run('git commit -m "add feature-a"', wtPath);

    writeFileSync(join(wtPath, "feature-b.ts"), "export const featureB = true;\n");
    run("git add .", wtPath);
    run('git commit -m "add feature-b"', wtPath);

    writeFileSync(join(wtPath, "feature-c.ts"), "export const featureC = true;\n");
    run("git add .", wtPath);
    run('git commit -m "add feature-c"', wtPath);

    const branchRefAfter = run("git rev-parse milestone/M140", wtPath);
    const worktreeHead = run("git rev-parse HEAD", wtPath);
    assert.strictEqual(branchRefBefore, branchRefAfter, "branch ref unchanged (stale)");
    assert.ok(worktreeHead !== branchRefAfter, "worktree HEAD ahead of branch ref");

    const roadmap = makeRoadmap("M140", "Stale ref milestone", [
      { id: "S01", title: "Initial work" },
    ]);

    let threw = false;
    let errMsg = "";
    try {
      const result = mergeMilestoneToMain(repo, "M140", roadmap);
      assert.ok(result.commitMessage.includes("feat:") && result.commitMessage.includes("GSD-Milestone: M140"), "merge commit created");
    } catch (err) {
      threw = true;
      errMsg = err instanceof Error ? err.message : String(err);
    }
    assert.ok(!threw, `should not throw with stale branch ref (got: ${errMsg})`);

    assert.ok(existsSync(join(repo, "initial.ts")), "initial.ts on main");
    assert.ok(existsSync(join(repo, "feature-a.ts")), "feature-a.ts on main (#1846)");
    assert.ok(existsSync(join(repo, "feature-b.ts")), "feature-b.ts on main (#1846)");
    assert.ok(existsSync(join(repo, "feature-c.ts")), "feature-c.ts on main (#1846)");
  });

  test("diverged worktree HEAD — throws on divergence (#1846)", () => {
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
    assert.ok(threw, "throws when worktree HEAD diverged from branch ref (#1846)");
    assert.ok(errMsg.includes("diverged"), "error message mentions divergence (#1846)");

    const branches = run("git branch", repo);
    assert.ok(branches.includes("milestone/M150"), "milestone branch preserved on divergence (#1846)");
  });

  test("#1853 bug 1: SQUASH_MSG cleaned up after successful squash-merge", () => {
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
    assert.ok(existsSync(squashMsgPath), "SQUASH_MSG planted before merge");

    const result = mergeMilestoneToMain(repo, "M160", roadmap);
    assert.ok(result.commitMessage.includes("feat:") && result.commitMessage.includes("GSD-Milestone: M160"), "merge commit created");

    assert.ok(!existsSync(squashMsgPath), "#1853: SQUASH_MSG must not persist after successful squash-merge");
  });

  test("#1853 bug 2: uncommitted worktree changes committed before teardown", () => {
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
    assert.ok(result.commitMessage.includes("feat:") && result.commitMessage.includes("GSD-Milestone: M170"), "merge commit created");

    assert.ok(
      existsSync(join(repo, "uncommitted-agent-code.ts")),
      "#1853: uncommitted worktree code must survive teardown",
    );
  });

  test("#1906: codeFilesChanged=false when only .gsd/ metadata merged", () => {
    const repo = freshRepo();
    const wtPath = createAutoWorktree(repo, "M180");

    mkdirSync(join(wtPath, ".gsd", "milestones", "M180"), { recursive: true });
    writeFileSync(
      join(wtPath, ".gsd", "milestones", "M180", "SUMMARY.md"),
      "# M180 Summary\n\nThis milestone was planned but not implemented.\n",
    );
    run("git add .", wtPath);
    run('git commit -m "chore: add milestone summary"', wtPath);

    const roadmap = makeRoadmap("M180", "Metadata-only milestone", []);

    const result = mergeMilestoneToMain(repo, "M180", roadmap);
    assert.strictEqual(result.codeFilesChanged, false,
      "#1906: codeFilesChanged must be false when only .gsd/ files were merged");
  });

  test("#1906: codeFilesChanged=true when real code is merged", () => {
    const repo = freshRepo();
    const wtPath = createAutoWorktree(repo, "M190");

    addSliceToMilestone(repo, wtPath, "M190", "S01", "Real code", [
      { file: "real-code.ts", content: "export const real = true;\n", message: "add real code" },
    ]);

    const roadmap = makeRoadmap("M190", "Code milestone", [
      { id: "S01", title: "Real code" },
    ]);

    const result = mergeMilestoneToMain(repo, "M190", roadmap);
    assert.strictEqual(result.codeFilesChanged, true,
      "#1906: codeFilesChanged must be true when real code files were merged");
    assert.ok(existsSync(join(repo, "real-code.ts")), "real-code.ts merged to main");
  });
});
