/**
 * auto-worktree.test.ts — Tests for auto-worktree lifecycle.
 *
 * Covers: create → detect → teardown, re-entry, path helpers.
 * Runs in a real temp git repo.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  createAutoWorktree,
  teardownAutoWorktree,
  isInAutoWorktree,
  getAutoWorktreePath,
  enterAutoWorktree,
  getAutoWorktreeOriginalBase,
} from "../auto-worktree.ts";

import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, report } = createTestContext();

function run(command: string, cwd: string): string {
  return execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "auto-wt-test-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  // Create initial commit on main
  writeFileSync(join(dir, "README.md"), "# test\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  // Ensure branch is called main
  run("git branch -M main", dir);
  return dir;
}

async function main(): Promise<void> {
  const savedCwd = process.cwd();
  let tempDir = "";

  try {
    tempDir = createTempRepo();

    // Create .gsd/milestones/M003 with a dummy file (simulates planning artifacts)
    const msDir = join(tempDir, ".gsd", "milestones", "M003");
    mkdirSync(msDir, { recursive: true });
    writeFileSync(join(msDir, "CONTEXT.md"), "# M003 Context\n");
    run("git add .", tempDir);
    run("git commit -m \"add milestone\"", tempDir);

    console.log("\n=== auto-worktree lifecycle ===");

    // ─── createAutoWorktree ──────────────────────────────────────────
    const wtPath = createAutoWorktree(tempDir, "M003");

    assertTrue(existsSync(wtPath), "worktree directory exists after create");
    assertEq(process.cwd(), wtPath, "process.cwd() is worktree path after create");

    const branch = run("git branch --show-current", wtPath);
    assertEq(branch, "milestone/M003", "git branch is milestone/M003");

    assertTrue(
      existsSync(join(wtPath, ".gsd", "milestones", "M003", "CONTEXT.md")),
      "planning files inherited in worktree",
    );

    // ─── isInAutoWorktree ────────────────────────────────────────────
    assertTrue(isInAutoWorktree(tempDir), "isInAutoWorktree returns true when inside");

    // ─── getAutoWorktreeOriginalBase ─────────────────────────────────
    assertEq(getAutoWorktreeOriginalBase(), tempDir, "originalBase returns temp dir");

    // ─── getAutoWorktreePath ─────────────────────────────────────────
    assertEq(getAutoWorktreePath(tempDir, "M003"), wtPath, "getAutoWorktreePath returns correct path");
    assertEq(getAutoWorktreePath(tempDir, "M999"), null, "getAutoWorktreePath returns null for nonexistent");

    // ─── teardownAutoWorktree ────────────────────────────────────────
    teardownAutoWorktree(tempDir, "M003");

    assertEq(process.cwd(), tempDir, "process.cwd() back to original after teardown");
    assertTrue(!existsSync(wtPath), "worktree directory removed after teardown");
    assertTrue(!isInAutoWorktree(tempDir), "isInAutoWorktree returns false after teardown");
    assertEq(getAutoWorktreeOriginalBase(), null, "originalBase is null after teardown");

    // ─── Re-entry: create again, exit without teardown, re-enter ─────
    console.log("\n=== re-entry ===");

    const wtPath2 = createAutoWorktree(tempDir, "M003");
    assertTrue(existsSync(wtPath2), "worktree re-created");

    // Manually chdir out (simulates pause/crash)
    process.chdir(tempDir);

    // enterAutoWorktree should re-enter
    const entered = enterAutoWorktree(tempDir, "M003");
    assertEq(process.cwd(), entered, "re-entered worktree via enterAutoWorktree");
    assertEq(getAutoWorktreeOriginalBase(), tempDir, "originalBase restored on re-entry");
    assertTrue(isInAutoWorktree(tempDir), "isInAutoWorktree true after re-entry");

    // Cleanup
    teardownAutoWorktree(tempDir, "M003");

    // ─── Coexistence with manual worktree ─────────────────────────────
    console.log("\n=== coexistence ===");

    // Import createWorktree directly for manual worktree
    const { createWorktree } = await import("../worktree-manager.ts");

    // Create manual worktree (uses worktree/<name> branch)
    const manualWt = createWorktree(tempDir, "feature-x");
    assertTrue(existsSync(manualWt.path), "manual worktree exists");
    assertEq(manualWt.branch, "worktree/feature-x", "manual worktree uses worktree/ prefix");

    // Create auto-worktree alongside
    const autoWtPath = createAutoWorktree(tempDir, "M003");
    assertTrue(existsSync(autoWtPath), "auto-worktree coexists with manual");
    assertTrue(existsSync(manualWt.path), "manual worktree still exists");

    // Cleanup both
    teardownAutoWorktree(tempDir, "M003");
    const { removeWorktree } = await import("../worktree-manager.ts");
    removeWorktree(tempDir, "feature-x");

    // ─── Failure: split-brain prevention ──────────────────────────────
    console.log("\n=== split-brain prevention ===");
    // After teardown, originalBase should be null
    assertEq(getAutoWorktreeOriginalBase(), null, "no split-brain: originalBase cleared");

  } finally {
    // Always restore cwd and clean up
    process.chdir(savedCwd);
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  report("auto-worktree");
}

main();
