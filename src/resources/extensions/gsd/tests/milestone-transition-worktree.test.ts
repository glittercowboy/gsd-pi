/**
 * milestone-transition-worktree.test.ts — Tests for #616 fix.
 *
 * Verifies that when auto-mode transitions between milestones, the
 * worktree lifecycle is handled: old worktree merged, new worktree created.
 *
 * Uses source-level checks since the full auto-mode dispatch loop
 * requires the @gsd/pi-coding-agent runtime.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, realpathSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAutoWorktree,
  teardownAutoWorktree,
  isInAutoWorktree,
  getAutoWorktreeOriginalBase,
  mergeMilestoneToMain,
} from "../auto-worktree.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function run(command: string, cwd: string): string {
  return execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-mt-wt-test-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
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

// ─── Milestone transition: worktree swap ─────────────────────────────────────

test("worktree swap on milestone transition: merge old, create new", () => {
  const savedCwd = process.cwd();
  let tempDir = "";

  try {
    tempDir = createTempRepo();

    // Set up M001 and M002 milestone artifacts
    createMilestoneArtifacts(tempDir, "M001");
    createMilestoneArtifacts(tempDir, "M002");
    run("git add .", tempDir);
    run("git commit -m \"add milestones\"", tempDir);

    // Phase 1: Create worktree for M001 (simulates auto-mode start)
    const wt1 = createAutoWorktree(tempDir, "M001");
    assert.equal(process.cwd(), wt1, "cwd should be in M001 worktree");
    assert.ok(isInAutoWorktree(tempDir), "should be in auto-worktree");
    assert.equal(getAutoWorktreeOriginalBase(), tempDir, "original base preserved");

    // Add a commit in M001 worktree to simulate work
    writeFileSync(join(wt1, "feature-m001.txt"), "M001 work\n");
    run("git add .", wt1);
    run("git commit -m \"feat(M001): add feature\"", wt1);

    // Phase 2: Simulate milestone transition — merge M001, exit worktree
    const roadmapPath = join(tempDir, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
    const roadmapContent = readFileSync(roadmapPath, "utf-8");
    mergeMilestoneToMain(tempDir, "M001", roadmapContent);

    // After merge: cwd should be back at project root
    assert.equal(process.cwd(), tempDir, "cwd restored to project root after merge");
    assert.ok(!isInAutoWorktree(tempDir), "no longer in auto-worktree after merge");

    // Verify M001 work was merged to main (milestone ID is in trailer, not subject)
    const mainLog = run("git log -3", tempDir);
    assert.ok(mainLog.includes("M001"), "M001 squash commit should be on main");

    // Phase 3: Create new worktree for M002 (simulates new milestone)
    const wt2 = createAutoWorktree(tempDir, "M002");
    assert.equal(process.cwd(), wt2, "cwd should be in M002 worktree");
    assert.ok(isInAutoWorktree(tempDir), "should be in M002 auto-worktree");

    // The new worktree should have the M001 feature file (merged to main)
    assert.ok(existsSync(join(wt2, "feature-m001.txt")), "M002 worktree inherits M001 merged work");

    // Verify branch is correct
    const branch = run("git branch --show-current", wt2);
    assert.equal(branch, "milestone/M002", "M002 worktree on correct branch");

    // Cleanup
    teardownAutoWorktree(tempDir, "M002");
  } finally {
    process.chdir(savedCwd);
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

// ─── Verify the transition code path exists in auto.ts ──────────────────────

test("auto/phases.ts milestone transition block contains worktree lifecycle", () => {
  const phasesSrc = readFileSync(
    join(__dirname, "..", "auto", "phases.ts"),
    "utf-8",
  );

  // The resolver handles worktree merge + enter inside the milestone transition block
  assert.ok(
    phasesSrc.includes("Worktree lifecycle on milestone transition"),
    "auto/phases.ts should contain the worktree lifecycle comment marker",
  );
  assert.ok(
    phasesSrc.includes("resolver.mergeAndExit") && phasesSrc.includes("mid !== s.currentMilestoneId"),
    "auto/phases.ts should call resolver.mergeAndExit during milestone transition",
  );
  assert.ok(
    phasesSrc.includes("resolver.enterMilestone"),
    "auto/phases.ts should call resolver.enterMilestone for incoming milestone",
  );
});

// ─── Verify worktree-resolver mergeAndExit preserves branch on missing roadmap (#1573) ──

test("worktree-resolver mergeAndExit preserves branch when roadmap is missing (#1573)", () => {
  const resolverSrc = readFileSync(
    join(__dirname, "..", "worktree-resolver.ts"),
    "utf-8",
  );

  // The fallback teardown must pass preserveBranch: true to prevent orphaning commits
  assert.ok(
    resolverSrc.includes("preserveBranch: true"),
    "worktree-resolver.ts should pass preserveBranch: true in the no-roadmap fallback",
  );

  // The worktree path should be tried as a fallback for roadmap resolution
  assert.ok(
    resolverSrc.includes("this.s.basePath !== originalBase") ||
      resolverSrc.includes("roadmap-fallback"),
    "worktree-resolver.ts should try resolving roadmap from worktree path as fallback",
  );
});
