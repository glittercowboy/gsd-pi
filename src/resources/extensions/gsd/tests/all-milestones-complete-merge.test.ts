/**
 * all-milestones-complete-merge.test.ts — Tests for #962 fix.
 *
 * Verifies that when the final milestone completes and there are no queued
 * follow-up milestones, the worktree is squash-merged to main before
 * stopAuto() tears it down. Without this fix, all work stays on the
 * milestone branch, unmerged to main.
 *
 * Uses both source-level checks (verifying the code path exists in auto.ts)
 * and real git integration tests (verifying merge behavior).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  realpathSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  createAutoWorktree,
  isInAutoWorktree,
  getAutoWorktreeOriginalBase,
  mergeMilestoneToMain,
} from "../auto-worktree.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function run(command: string, cwd: string): string {
  return execSync(command, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "gsd-all-complete-test-")),
  );
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  // Mirror production: .gsd/worktrees/ is gitignored so autoCommitDirtyState
  // doesn't pick up the worktrees directory as dirty state (#1127 fix).
  writeFileSync(join(dir, ".gitignore"), ".gsd/worktrees/\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);
  return dir;
}

function createMilestoneArtifacts(dir: string, mid: string): void {
  const msDir = join(dir, ".gsd", "milestones", mid);
  mkdirSync(msDir, { recursive: true });
  writeFileSync(join(msDir, "CONTEXT.md"), `# ${mid} Context\n`);
  const roadmap = [
    `# ${mid}: Test Milestone`,
    "**Vision**: testing",
    "## Success Criteria",
    "- It works",
    "## Slices",
    "- [x] S01 — First slice",
  ].join("\n");
  writeFileSync(join(msDir, `${mid}-ROADMAP.md`), roadmap);
}

// ─── Source-level: verify the merge code exists in the "all complete" path ────

test("auto-loop 'all milestones complete' path merges before stopping (#962)", () => {
  const loopSrc = readFileSync(join(__dirname, "..", "auto", "phases.ts"), "utf-8");
  const resolverSrc = readFileSync(
    join(__dirname, "..", "worktree-resolver.ts"),
    "utf-8",
  );

  // Find the "incomplete.length === 0" block
  const incompleteIdx = loopSrc.indexOf("incomplete.length === 0");
  assert.ok(
    incompleteIdx > -1,
    "auto/phases.ts should have 'incomplete.length === 0' check",
  );

  // The merge call must appear BETWEEN the incomplete check and the stopAuto call.
  const blockAfterIncomplete = loopSrc.slice(
    incompleteIdx,
    incompleteIdx + 3000,
  );

  assert.ok(
    blockAfterIncomplete.includes("deps.resolver.mergeAndExit"),
    "auto/phases.ts should call resolver.mergeAndExit in the 'all milestones complete' path",
  );

  // The merge should come before stopAuto in this block
  const mergePos = blockAfterIncomplete.indexOf("deps.resolver.mergeAndExit");
  const stopPos = blockAfterIncomplete.indexOf("stopAuto");
  assert.ok(
    mergePos < stopPos,
    "resolver.mergeAndExit should be called before stopAuto in the 'all complete' path",
  );

  const helperIdx = resolverSrc.indexOf("mergeAndExit(milestoneId");
  assert.ok(
    helperIdx > -1,
    "WorktreeResolver.mergeAndExit helper should exist",
  );
  const helperBlock = resolverSrc.slice(helperIdx, helperIdx + 2600);
  assert.ok(
    helperBlock.includes('mode === "worktree"') ||
      helperBlock.includes('mode: "worktree"'),
    "WorktreeResolver.mergeAndExit should handle worktree mode",
  );
  assert.ok(
    helperBlock.includes('mode === "branch"') ||
      helperBlock.includes('mode: "branch"'),
    "WorktreeResolver.mergeAndExit should handle branch mode",
  );
});

// ─── Integration: single milestone completes → merged to main ────────────────

test("single milestone worktree is merged to main when all complete (#962)", (t) => {
  const savedCwd = process.cwd();
  let tempDir = "";

  t.after(() => {
    process.chdir(savedCwd);
    if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
    }
  });

  tempDir = createTempRepo();

  // Set up a single milestone
  createMilestoneArtifacts(tempDir, "M001");
  run("git add .", tempDir);
  run('git commit -m "add milestone"', tempDir);

  // Create worktree and simulate work
  const wt = createAutoWorktree(tempDir, "M001");
  assert.ok(isInAutoWorktree(tempDir), "should be in auto-worktree");

  writeFileSync(join(wt, "feature.ts"), "export const feature = true;\n");
  run("git add .", wt);
  run('git commit -m "feat(M001): add feature"', wt);

  // Simulate the fix: merge before stopping (what the "all complete" path now does)
  const roadmapPath = join(
    tempDir,
    ".gsd",
    "milestones",
    "M001",
    "M001-ROADMAP.md",
  );
  const roadmapContent = readFileSync(roadmapPath, "utf-8");
  const mergeResult = mergeMilestoneToMain(tempDir, "M001", roadmapContent);

  // Verify work is on main
  assert.ok(
    existsSync(join(tempDir, "feature.ts")),
    "feature.ts should be on main after merge",
  );
  assert.equal(process.cwd(), tempDir, "cwd restored to project root");
  assert.ok(!isInAutoWorktree(tempDir), "no longer in auto-worktree");
  assert.equal(getAutoWorktreeOriginalBase(), null, "originalBase cleared");

  // Verify milestone branch was cleaned up
  const branches = run("git branch", tempDir);
  assert.ok(
    !branches.includes("milestone/M001"),
    "milestone branch should be deleted",
  );

  // Verify squash commit on main (milestone ID is in trailer, not subject)
  const log = run("git log -3", tempDir);
  assert.ok(
    log.includes("M001"),
    "squash commit on main should reference M001",
  );

  assert.ok(mergeResult.commitMessage.length > 0, "commit message returned");
});

// ─── Integration: last of multiple milestones completes → merged ─────────────

test("last milestone worktree is merged when it's the final one (#962)", (t) => {
  const savedCwd = process.cwd();
  let tempDir = "";

  t.after(() => {
    process.chdir(savedCwd);
    if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
    }
  });

  tempDir = createTempRepo();

  // Set up two milestones
  createMilestoneArtifacts(tempDir, "M001");
  createMilestoneArtifacts(tempDir, "M002");
  run("git add .", tempDir);
  run('git commit -m "add milestones"', tempDir);

  // Complete M001 first (merge it)
  const wt1 = createAutoWorktree(tempDir, "M001");
  writeFileSync(join(wt1, "m001-work.ts"), "export const m001 = true;\n");
  run("git add .", wt1);
  run('git commit -m "feat(M001): m001 work"', wt1);
  const roadmap1 = readFileSync(
    join(tempDir, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
    "utf-8",
  );
  mergeMilestoneToMain(tempDir, "M001", roadmap1);

  // Now complete M002 (the LAST milestone — this is the #962 scenario)
  const wt2 = createAutoWorktree(tempDir, "M002");
  writeFileSync(join(wt2, "m002-work.ts"), "export const m002 = true;\n");
  run("git add .", wt2);
  run('git commit -m "feat(M002): m002 work"', wt2);
  const roadmap2 = readFileSync(
    join(tempDir, ".gsd", "milestones", "M002", "M002-ROADMAP.md"),
    "utf-8",
  );
  mergeMilestoneToMain(tempDir, "M002", roadmap2);

  // Both features should now be on main
  assert.ok(existsSync(join(tempDir, "m001-work.ts")), "M001 work on main");
  assert.ok(existsSync(join(tempDir, "m002-work.ts")), "M002 work on main");
  assert.ok(!isInAutoWorktree(tempDir), "not in worktree after final merge");

  // Both milestone branches should be cleaned up
  const branches = run("git branch", tempDir);
  assert.ok(!branches.includes("milestone/M001"), "M001 branch deleted");
  assert.ok(!branches.includes("milestone/M002"), "M002 branch deleted");
});
