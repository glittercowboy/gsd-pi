import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  autoCommitCurrentBranch,
  captureIntegrationBranch,
  detectWorktreeName,
  getCurrentBranch,
  getMainBranch,
  getSliceBranchName,
  parseSliceBranch,
  resolveProjectRoot,
  setActiveMilestoneId,
  SLICE_BRANCH_RE,
  _resetServiceCache,
} from "../worktree.ts";
import { readIntegrationBranch } from "../git-service.ts";
import { _resetHasChangesCache } from "../native-git-bridge.ts";
import { _clearGsdRootCache } from "../paths.ts";
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';


/**
 * Normalize a path for reliable comparison on Windows CI runners.
 * `os.tmpdir()` may return the 8.3 short-path form (e.g. `C:\Users\RUNNER~1`)
 * while `realpathSync` and git resolve to the long form (`C:\Users\runneradmin`).
 * Apply `realpathSync` and lowercase on Windows to eliminate both discrepancies.
 */
function normalizePath(p: string): string {
  const resolved = process.platform === "win32" ? realpathSync.native(p) : realpathSync(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function run(command: string, cwd: string): string {
  return execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

const base = mkdtempSync(join(tmpdir(), "gsd-branch-test-"));
run("git init -b main", base);
run('git config user.name "Pi Test"', base);
run('git config user.email "pi@example.com"', base);
mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
writeFileSync(join(base, "README.md"), "hello\n", "utf-8");
writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), `# M001: Demo\n\n## Slices\n- [ ] **S01: Slice One** \`risk:low\` \`depends:[]\`\n  > After this: demo works\n`, "utf-8");
writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"), `# S01: Slice One\n\n**Goal:** Demo\n**Demo:** Demo\n\n## Must-Haves\n- done\n\n## Tasks\n- [ ] **T01: Implement** \`est:10m\`\n  do it\n`, "utf-8");
run("git add .", base);
run('git commit -m "chore: init"', base);

describe('worktree', async () => {

  console.log("\n=== autoCommitCurrentBranch ===");
  // Clean — should return null
  const cleanResult = autoCommitCurrentBranch(base, "execute-task", "M001/S01/T01");
  assert.deepStrictEqual(cleanResult, null, "returns null for clean repo");

  // Make dirty — reset the nativeHasChanges cache so the fresh dirt is detected
  _resetHasChangesCache();
  writeFileSync(join(base, "dirty.txt"), "uncommitted\n", "utf-8");
  const dirtyResult = autoCommitCurrentBranch(base, "execute-task", "M001/S01/T01");
  assert.ok(dirtyResult !== null, "returns commit message for dirty repo");
  assert.ok(dirtyResult!.includes("M001/S01/T01"), "commit message includes unit id");
  assert.deepStrictEqual(run("git status --short", base), "", "repo is clean after auto-commit");

  console.log("\n=== getSliceBranchName ===");
  assert.deepStrictEqual(getSliceBranchName("M001", "S01"), "gsd/M001/S01", "branch name format correct");
  assert.deepStrictEqual(getSliceBranchName("M001", "S01", null), "gsd/M001/S01", "null worktree = plain branch");
  assert.deepStrictEqual(getSliceBranchName("M001", "S01", "my-wt"), "gsd/my-wt/M001/S01", "worktree-namespaced branch");

  console.log("\n=== parseSliceBranch ===");
  const plain = parseSliceBranch("gsd/M001/S01");
  assert.ok(plain !== null, "parses plain branch");
  assert.deepStrictEqual(plain!.worktreeName, null, "plain branch has no worktree name");
  assert.deepStrictEqual(plain!.milestoneId, "M001", "plain branch milestone");
  assert.deepStrictEqual(plain!.sliceId, "S01", "plain branch slice");

  const namespaced = parseSliceBranch("gsd/feature-auth/M001/S01");
  assert.ok(namespaced !== null, "parses worktree-namespaced branch");
  assert.deepStrictEqual(namespaced!.worktreeName, "feature-auth", "worktree name extracted");
  assert.deepStrictEqual(namespaced!.milestoneId, "M001", "namespaced branch milestone");
  assert.deepStrictEqual(namespaced!.sliceId, "S01", "namespaced branch slice");

  const invalid = parseSliceBranch("main");
  assert.deepStrictEqual(invalid, null, "non-slice branch returns null");

  const worktreeBranch = parseSliceBranch("worktree/foo");
  assert.deepStrictEqual(worktreeBranch, null, "worktree/ prefix is not a slice branch");

  console.log("\n=== SLICE_BRANCH_RE ===");
  assert.ok(SLICE_BRANCH_RE.test("gsd/M001/S01"), "regex matches plain branch");
  assert.ok(SLICE_BRANCH_RE.test("gsd/my-wt/M001/S01"), "regex matches worktree branch");
  assert.ok(!SLICE_BRANCH_RE.test("main"), "regex rejects main");
  assert.ok(!SLICE_BRANCH_RE.test("gsd/"), "regex rejects bare gsd/");
  assert.ok(!SLICE_BRANCH_RE.test("worktree/foo"), "regex rejects worktree/foo");

  console.log("\n=== detectWorktreeName ===");
  assert.deepStrictEqual(detectWorktreeName("/projects/myapp"), null, "no worktree in plain path");
  assert.deepStrictEqual(detectWorktreeName("/projects/myapp/.gsd/worktrees/feature-auth"), "feature-auth", "detects worktree name");
  assert.deepStrictEqual(detectWorktreeName("/projects/myapp/.gsd/worktrees/my-wt/subdir"), "my-wt", "detects worktree with subdir");

  // ═══════════════════════════════════════════════════════════════════════
  // Integration branch — facade-level tests
  // ═══════════════════════════════════════════════════════════════════════

  // ── captureIntegrationBranch on a feature branch ──────────────────────

  console.log("\n=== captureIntegrationBranch: records current branch ===");

  {
    const repo = mkdtempSync(join(tmpdir(), "gsd-integ-facade-"));
    run("git init -b main", repo);
    run("git config user.name 'Pi Test'", repo);
    run("git config user.email 'pi@example.com'", repo);
    writeFileSync(join(repo, "README.md"), "init\n");
    run("git add -A && git commit -m init", repo);

    run("git checkout -b f-123-thing", repo);
    assert.deepStrictEqual(getCurrentBranch(repo), "f-123-thing", "on feature branch");

    const commitsBefore = run("git rev-list --count HEAD", repo);
    captureIntegrationBranch(repo, "M001");
    assert.deepStrictEqual(readIntegrationBranch(repo, "M001"), "f-123-thing",
      "captureIntegrationBranch records the current branch");

    // Metadata is stored in external state, not committed to git.
    const commitsAfter = run("git rev-list --count HEAD", repo);
    assert.deepStrictEqual(commitsAfter, commitsBefore, "captureIntegrationBranch does not create a git commit");

    rmSync(repo, { recursive: true, force: true });
  }

  // ── captureIntegrationBranch skips slice branches ─────────────────────

  console.log("\n=== captureIntegrationBranch: skips slice branches ===");

  {
    const repo = mkdtempSync(join(tmpdir(), "gsd-integ-skip-"));
    run("git init -b main", repo);
    run("git config user.name 'Pi Test'", repo);
    run("git config user.email 'pi@example.com'", repo);
    writeFileSync(join(repo, "README.md"), "init\n");
    run("git add -A && git commit -m init", repo);

    run("git checkout -b gsd/M001/S01", repo);
    captureIntegrationBranch(repo, "M001");

    assert.deepStrictEqual(readIntegrationBranch(repo, "M001"), null,
      "capture from slice branch is a no-op");

    rmSync(repo, { recursive: true, force: true });
  }

  // ── setActiveMilestoneId makes getMainBranch return integration branch ─

  console.log("\n=== setActiveMilestoneId + getMainBranch ===");

  {
    const repo = mkdtempSync(join(tmpdir(), "gsd-integ-main-"));
    run("git init -b main", repo);
    run("git config user.name 'Pi Test'", repo);
    run("git config user.email 'pi@example.com'", repo);
    writeFileSync(join(repo, "README.md"), "init\n");
    run("git add -A && git commit -m init", repo);

    run("git checkout -b my-feature", repo);
    captureIntegrationBranch(repo, "M001");

    // Isolate from user's global preferences (which may have git.main_branch set).
    // Reset caches so getService() creates a fresh instance with empty preferences.
    const originalHome = process.env.HOME;
    const fakeHome = mkdtempSync(join(tmpdir(), "gsd-fake-home-"));
    process.env.HOME = fakeHome;
    _clearGsdRootCache();
    _resetServiceCache();

    try {
      // Without milestone set, getMainBranch returns "main"
      setActiveMilestoneId(repo, null);
      assert.deepStrictEqual(getMainBranch(repo), "main",
        "getMainBranch returns main without milestone set");

      // With milestone set, getMainBranch returns feature branch
      setActiveMilestoneId(repo, "M001");
      assert.deepStrictEqual(getMainBranch(repo), "my-feature",
        "getMainBranch returns integration branch with milestone set");
    } finally {
      process.env.HOME = originalHome;
      _clearGsdRootCache();
      _resetServiceCache();
      rmSync(fakeHome, { recursive: true, force: true });
    }

    rmSync(repo, { recursive: true, force: true });
  }

  // ── detectWorktreeName: symlink-resolved paths ───────────────────────────
  console.log("\n=== detectWorktreeName (symlink-resolved paths) ===");
  assert.deepStrictEqual(
    detectWorktreeName("/Users/fran/.gsd/projects/89e1c9ad49bf/worktrees/M001"),
    "M001",
    "detects milestone in symlink-resolved path",
  );
  assert.deepStrictEqual(
    detectWorktreeName("/Users/fran/.gsd/projects/abc123/worktrees/M002/subdir"),
    "M002",
    "detects milestone with trailing subdir in symlink-resolved path",
  );
  assert.deepStrictEqual(
    detectWorktreeName("/Users/fran/.gsd/projects/abc123"),
    null,
    "returns null for project root without worktrees segment",
  );
  assert.deepStrictEqual(
    detectWorktreeName("/foo/.gsd/worktrees/M001"),
    "M001",
    "still detects direct layout path",
  );

  // ── resolveProjectRoot: symlink-resolved paths ──────────────────────────
  console.log("\n=== resolveProjectRoot (symlink-resolved paths) ===");

  // BUG FIX: symlink-resolved paths that land inside ~/.gsd should NOT
  // resolve to the home directory. When the .git file fallback can't find
  // the real project root (no git worktree metadata in these synthetic paths),
  // resolveProjectRoot returns the input unchanged rather than returning ~.
  
  // With GSD_PROJECT_ROOT env var set (layer 1 — coordinator passes it)
  process.env.GSD_PROJECT_ROOT = "/real/project";
  assert.deepStrictEqual(
    resolveProjectRoot("/Users/fran/.gsd/projects/89e1c9ad49bf/worktrees/M001"),
    "/real/project",
    "uses GSD_PROJECT_ROOT when set",
  );
  delete process.env.GSD_PROJECT_ROOT;

  // Without GSD_PROJECT_ROOT, direct layout still works (no ~/.gsd collision)
  assert.deepStrictEqual(
    resolveProjectRoot("/some/repo"),
    "/some/repo",
    "ignores GSD_PROJECT_ROOT override for non-worktree paths",
  );
  delete process.env.GSD_PROJECT_ROOT;

  // Without GSD_PROJECT_ROOT, direct layout still works (no ~/.gsd collision)
  assert.deepStrictEqual(
    resolveProjectRoot("/foo/.gsd/worktrees/M001"),
    "/foo",
    "still resolves direct layout path",
  );
  assert.deepStrictEqual(
    resolveProjectRoot("/some/repo"),
    "/some/repo",
    "returns unchanged for non-worktree path",
  );

  // Without GSD_PROJECT_ROOT, direct layout with nested subdirs
  assert.deepStrictEqual(
    resolveProjectRoot("/data/.gsd/worktrees/M003/nested"),
    "/data",
    "resolves correctly with nested subdirs after worktree name (direct layout)",
  );

  // Real symlink + git worktree scenario, with deep nested path from cwd
  {
    const fakeHome = mkdtempSync(join(tmpdir(), "gsd-home-"));
    const project = realpathSync(mkdtempSync(join(tmpdir(), "gsd-proj-")));
    const storage = join(fakeHome, ".gsd", "projects", "abc123def456");
    mkdirSync(storage, { recursive: true });
    symlinkSync(storage, join(project, ".gsd"));

    run("git init -b main", project);
    run("git config user.name 'Pi Test'", project);
    run("git config user.email 'pi@example.com'", project);
    writeFileSync(join(project, "README.md"), "init\n");
    run("git add -A && git commit -m init", project);
    run("git worktree add .gsd/worktrees/M001 -b worktree/M001", project);

    const deep = join(project, ".gsd", "worktrees", "M001", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k");
    mkdirSync(deep, { recursive: true });

    process.env.GSD_HOME = join(fakeHome, ".gsd");
    assert.deepStrictEqual(
      normalizePath(resolveProjectRoot(realpathSync(deep))),
      normalizePath(project),
      "resolves to real project root from deep symlink-resolved worktree path",
    );
    delete process.env.GSD_HOME;

    rmSync(project, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }

  rmSync(base, { recursive: true, force: true });
});
