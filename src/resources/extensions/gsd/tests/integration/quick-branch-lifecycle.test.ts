/**
 * Tests for quick-task branch lifecycle:
 * - Branch creation → merge-back → cleanup
 * - Cross-session recovery via disk-persisted state
 * - captureIntegrationBranch guard against quick-task branches
 *
 * Relates to #1269, #1293.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { captureIntegrationBranch, getCurrentBranch } from "../../worktree.ts";
import { readIntegrationBranch, QUICK_BRANCH_RE } from "../../git-service.ts";

function run(command: string, cwd: string): string {
  return execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function createTestRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "gsd-quick-lifecycle-"));
  run("git init -b main", repo);
  run(`git config user.name "GSD Test"`, repo);
  run(`git config user.email "test@gsd.dev"`, repo);
  mkdirSync(join(repo, ".gsd", "runtime"), { recursive: true });
  mkdirSync(join(repo, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "init\n");
  run("git add -A", repo);
  run(`git commit -m "init"`, repo);
  return repo;
}

  // ═══════════════════════════════════════════════════════════════════════
  // QUICK_BRANCH_RE
  // ═══════════════════════════════════════════════════════════════════════


describe('quick-branch-lifecycle', () => {
test('QUICK_BRANCH_RE: matches quick-task branches', () => {
  assert.ok(QUICK_BRANCH_RE.test("gsd/quick/1-fix-typo"), "matches standard quick branch");
});

  assert.ok(QUICK_BRANCH_RE.test("gsd/quick/42-some-long-slug-name"), "matches multi-digit quick branch");
  assert.ok(!QUICK_BRANCH_RE.test("main"), "rejects main");
  assert.ok(!QUICK_BRANCH_RE.test("gsd/M001/S01"), "rejects slice branch");
  assert.ok(!QUICK_BRANCH_RE.test("gsd/quickly-something"), "rejects non-quick prefix");
  assert.ok(!QUICK_BRANCH_RE.test("feature/gsd/quick/1"), "rejects nested prefix");
  // ═══════════════════════════════════════════════════════════════════════
  // captureIntegrationBranch: guard against quick-task branches
  // ═══════════════════════════════════════════════════════════════════════
test('captureIntegrationBranch: skips quick-task branches', () => {
    const repo = createTestRepo();

    // Create and checkout a quick-task branch
    run("git checkout -b gsd/quick/1-fix-typo", repo);
    assert.deepStrictEqual(getCurrentBranch(repo), "gsd/quick/1-fix-typo", "on quick branch");

    captureIntegrationBranch(repo, "M001");

    assert.deepStrictEqual(readIntegrationBranch(repo, "M001"), null,
      "captureIntegrationBranch is a no-op on quick-task branches");

    rmSync(repo, { recursive: true, force: true });
});

  // ─── Verify main is still recorded correctly ─────────────────────────
test('captureIntegrationBranch: records main correctly', () => {
    const repo = createTestRepo();

    // Capture from main — should work normally
    captureIntegrationBranch(repo, "M001");
    assert.deepStrictEqual(readIntegrationBranch(repo, "M001"), "main",
      "main is recorded as integration branch");

    // Switch to quick branch — capture should be no-op (doesn't overwrite main)
    run("git checkout -b gsd/quick/1-fix-typo", repo);
    captureIntegrationBranch(repo, "M001");
    assert.deepStrictEqual(readIntegrationBranch(repo, "M001"), "main",
      "quick branch does not overwrite existing integration branch");

    rmSync(repo, { recursive: true, force: true });
});

  // ─── Sequence: main → quick → back to main → capture ────────────────
test('captureIntegrationBranch: correct after quick branch round-trip', () => {
    const repo = createTestRepo();

    // Simulate quick-task lifecycle: branch off, do work, return to main
    run("git checkout -b gsd/quick/1-fix-typo", repo);
    writeFileSync(join(repo, "fix.txt"), "fixed\n");
    run("git add -A", repo);
    run(`git commit -m "quick-fix"`, repo);
    run("git checkout main", repo);
    run("git merge --squash gsd/quick/1-fix-typo", repo);
    run(`git commit -m "quick(Q1): fix-typo"`, repo);
    run("git branch -D gsd/quick/1-fix-typo", repo);

    // Now capture — should get main, not the deleted quick branch
    captureIntegrationBranch(repo, "M002");
    assert.deepStrictEqual(readIntegrationBranch(repo, "M002"), "main",
      "after quick round-trip, main is captured correctly");

    rmSync(repo, { recursive: true, force: true });
});

  // ═══════════════════════════════════════════════════════════════════════
  // cleanupQuickBranch: in-memory path (same session)
  // ═══════════════════════════════════════════════════════════════════════
test('cleanupQuickBranch: merges back and cleans up (same session)', async () => {
    const repo = createTestRepo();
    const origCwd = process.cwd();

    // Simulate what handleQuick does: create branch, set pending state
    run("git checkout -b gsd/quick/1-fix-typo", repo);
    writeFileSync(join(repo, "fix.txt"), "fixed\n");
    run("git add -A", repo);
    run(`git commit -m "quick-fix"`, repo);

    // Write the disk state (simulating handleQuick's persistPendingReturn)
    const returnState = {
      basePath: repo,
      originalBranch: "main",
      quickBranch: "gsd/quick/1-fix-typo",
      taskNum: 1,
      slug: "fix-typo",
      description: "fix typo",
    };
    const runtimeDir = join(repo, ".gsd", "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, "quick-return.json"), JSON.stringify(returnState) + "\n");

    // Switch cwd to repo so cleanupQuickBranch finds the disk state
    process.chdir(repo);

    // Import and call cleanupQuickBranch
    // Use dynamic import to get a fresh module scope — the in-memory state
    // won't be set, so it will fall through to disk recovery
    const { cleanupQuickBranch } = await import("../../quick.ts");
    const result = cleanupQuickBranch();

    assert.ok(result, "cleanupQuickBranch returns true");
    assert.deepStrictEqual(getCurrentBranch(repo), "main", "back on main after cleanup");

    // Verify merge happened — fix.txt should exist on main
    assert.ok(existsSync(join(repo, "fix.txt")), "fix.txt merged to main");

    // Verify quick branch deleted
    const branches = run("git branch", repo);
    assert.ok(!branches.includes("gsd/quick/1-fix-typo"), "quick branch deleted");

    // Verify disk state cleaned up
    assert.ok(!existsSync(join(runtimeDir, "quick-return.json")), "quick-return.json removed");

    process.chdir(origCwd);
    rmSync(repo, { recursive: true, force: true });
});

  // ═══════════════════════════════════════════════════════════════════════
  // cleanupQuickBranch: cross-session recovery from disk
  // ═══════════════════════════════════════════════════════════════════════
test('cleanupQuickBranch: recovers from disk state (cross-session)', async () => {
    const repo = createTestRepo();
    const origCwd = process.cwd();

    // Simulate a crashed session: branch exists with work, disk state persisted,
    // but in-memory state is gone (new process)
    run("git checkout -b gsd/quick/2-add-docs", repo);
    writeFileSync(join(repo, "docs.md"), "# Docs\n");
    run("git add -A", repo);
    run(`git commit -m "add-docs"`, repo);

    // Write disk state manually (simulates what handleQuick would persist)
    const runtimeDir = join(repo, ".gsd", "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, "quick-return.json"), JSON.stringify({
      basePath: repo,
      originalBranch: "main",
      quickBranch: "gsd/quick/2-add-docs",
      taskNum: 2,
      slug: "add-docs",
      description: "add docs",
    }) + "\n");

    process.chdir(repo);

    const { cleanupQuickBranch } = await import("../../quick.ts");
    const result = cleanupQuickBranch();

    assert.ok(result, "cross-session recovery returns true");
    assert.deepStrictEqual(getCurrentBranch(repo), "main", "back on main after cross-session recovery");
    assert.ok(existsSync(join(repo, "docs.md")), "docs.md merged to main");
    assert.ok(!existsSync(join(runtimeDir, "quick-return.json")), "disk state cleaned up");

    process.chdir(origCwd);
    rmSync(repo, { recursive: true, force: true });
});

  // ═══════════════════════════════════════════════════════════════════════
  // cleanupQuickBranch: no-op when no pending state
  // ═══════════════════════════════════════════════════════════════════════
test('cleanupQuickBranch: no-op without pending state', async () => {
    const repo = createTestRepo();
    const origCwd = process.cwd();
    process.chdir(repo);

    const { cleanupQuickBranch } = await import("../../quick.ts");
    const result = cleanupQuickBranch();

    assert.ok(!result, "returns false when no pending state");
    assert.deepStrictEqual(getCurrentBranch(repo), "main", "stays on main");

    process.chdir(origCwd);
    rmSync(repo, { recursive: true, force: true });
});

  // ═══════════════════════════════════════════════════════════════════════
  // End-to-end: quick branch does NOT contaminate integration branch
  // ═══════════════════════════════════════════════════════════════════════
test('E2E: quick branch does not contaminate integration branch', () => {
    const repo = createTestRepo();

    // 1. Record main as integration branch for M001
    captureIntegrationBranch(repo, "M001");
    assert.deepStrictEqual(readIntegrationBranch(repo, "M001"), "main", "M001 integration = main");

    // 2. Start a quick task (branch off)
    run("git checkout -b gsd/quick/1-fix-typo", repo);

    // 3. Try to capture integration branch for M002 while on quick branch
    captureIntegrationBranch(repo, "M002");
    assert.deepStrictEqual(readIntegrationBranch(repo, "M002"), null,
      "M002 integration NOT recorded from quick branch");

    // 4. Return to main (simulate cleanupQuickBranch)
    run("git checkout main", repo);

    // 5. Now capture M002 from main — should work
    captureIntegrationBranch(repo, "M002");
    assert.deepStrictEqual(readIntegrationBranch(repo, "M002"), "main",
      "M002 integration = main after returning from quick branch");

    // 6. Verify M001 still intact
    assert.deepStrictEqual(readIntegrationBranch(repo, "M001"), "main",
      "M001 integration unchanged");

    rmSync(repo, { recursive: true, force: true });
});

});
