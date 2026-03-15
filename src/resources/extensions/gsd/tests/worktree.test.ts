import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  setActiveMilestoneId,
  SLICE_BRANCH_RE,
} from "../worktree.ts";
import { readIntegrationBranch } from "../git-service.ts";
import { createTestContext } from './test-helpers.ts';

const { assertEq, assertTrue, report } = createTestContext();
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

async function main(): Promise<void> {

  console.log("\n=== autoCommitCurrentBranch ===");
  // Clean — should return null
  const cleanResult = autoCommitCurrentBranch(base, "execute-task", "M001/S01/T01");
  assertEq(cleanResult, null, "returns null for clean repo");

  // Make dirty
  writeFileSync(join(base, "dirty.txt"), "uncommitted\n", "utf-8");
  const dirtyResult = autoCommitCurrentBranch(base, "execute-task", "M001/S01/T01");
  assertTrue(dirtyResult !== null, "returns commit message for dirty repo");
  assertTrue(dirtyResult!.includes("M001/S01/T01"), "commit message includes unit id");
  assertEq(run("git status --short", base), "", "repo is clean after auto-commit");

  console.log("\n=== getSliceBranchName ===");
  assertEq(getSliceBranchName("M001", "S01"), "gsd/M001/S01", "branch name format correct");
  assertEq(getSliceBranchName("M001", "S01", null), "gsd/M001/S01", "null worktree = plain branch");
  assertEq(getSliceBranchName("M001", "S01", "my-wt"), "gsd/my-wt/M001/S01", "worktree-namespaced branch");

  console.log("\n=== parseSliceBranch ===");
  const plain = parseSliceBranch("gsd/M001/S01");
  assertTrue(plain !== null, "parses plain branch");
  assertEq(plain!.worktreeName, null, "plain branch has no worktree name");
  assertEq(plain!.milestoneId, "M001", "plain branch milestone");
  assertEq(plain!.sliceId, "S01", "plain branch slice");

  const namespaced = parseSliceBranch("gsd/feature-auth/M001/S01");
  assertTrue(namespaced !== null, "parses worktree-namespaced branch");
  assertEq(namespaced!.worktreeName, "feature-auth", "worktree name extracted");
  assertEq(namespaced!.milestoneId, "M001", "namespaced branch milestone");
  assertEq(namespaced!.sliceId, "S01", "namespaced branch slice");

  const invalid = parseSliceBranch("main");
  assertEq(invalid, null, "non-slice branch returns null");

  const worktreeBranch = parseSliceBranch("worktree/foo");
  assertEq(worktreeBranch, null, "worktree/ prefix is not a slice branch");

  console.log("\n=== SLICE_BRANCH_RE ===");
  assertTrue(SLICE_BRANCH_RE.test("gsd/M001/S01"), "regex matches plain branch");
  assertTrue(SLICE_BRANCH_RE.test("gsd/my-wt/M001/S01"), "regex matches worktree branch");
  assertTrue(!SLICE_BRANCH_RE.test("main"), "regex rejects main");
  assertTrue(!SLICE_BRANCH_RE.test("gsd/"), "regex rejects bare gsd/");
  assertTrue(!SLICE_BRANCH_RE.test("worktree/foo"), "regex rejects worktree/foo");

  console.log("\n=== detectWorktreeName ===");
  assertEq(detectWorktreeName("/projects/myapp"), null, "no worktree in plain path");
  assertEq(detectWorktreeName("/projects/myapp/.gsd/worktrees/feature-auth"), "feature-auth", "detects worktree name");
  assertEq(detectWorktreeName("/projects/myapp/.gsd/worktrees/my-wt/subdir"), "my-wt", "detects worktree with subdir");

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
    assertEq(getCurrentBranch(repo), "f-123-thing", "on feature branch");

    captureIntegrationBranch(repo, "M001");
    assertEq(readIntegrationBranch(repo, "M001"), "f-123-thing",
      "captureIntegrationBranch records the current branch");

    // Verify it was committed (not just written to disk)
    const logOut = run("git log --oneline -1", repo);
    assertTrue(logOut.includes("integration branch"), "metadata committed to git");

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

    assertEq(readIntegrationBranch(repo, "M001"), null,
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

    // Without milestone set, getMainBranch returns "main"
    setActiveMilestoneId(repo, null);
    assertEq(getMainBranch(repo), "main",
      "getMainBranch returns main without milestone set");

    // With milestone set, getMainBranch returns feature branch
    setActiveMilestoneId(repo, "M001");
    assertEq(getMainBranch(repo), "my-feature",
      "getMainBranch returns integration branch with milestone set");

    rmSync(repo, { recursive: true, force: true });
  }

  rmSync(base, { recursive: true, force: true });
  report();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
