import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
/**
 * doctor-environment-worktree.test.ts — Worktree-aware dependency checks (#2303).
 *
 * Reproduction: doctor-environment `checkDependenciesInstalled` falsely reports
 * `env_dependencies` error inside auto-worktrees because `node_modules` is
 * absent by design (worktrees symlink to the project root's node_modules and
 * the symlink may not yet exist at check time).
 *
 * Fix: when the basePath contains `.gsd/worktrees/`, resolve the project root
 * and check its node_modules instead.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

import {
  runEnvironmentChecks,
  environmentResultsToDoctorIssues,
  checkEnvironmentHealth,
} from "../../doctor-environment.ts";
/** Create a directory tree with files. */
function createDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-wt-env-"));
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return dir;
}

describe('doctor-environment-worktree', async () => {
  const cleanups: string[] = [];

  try {
    // ── Reproduction: worktree path without node_modules ───────────────
    test('worktree: missing node_modules should NOT error when project root has them', () => {
      // Simulate project root with node_modules
      const projectRoot = createDir({
        "package.json": JSON.stringify({ name: "test-project" }),
      });
      mkdirSync(join(projectRoot, "node_modules"), { recursive: true });
      cleanups.push(projectRoot);

      // Simulate a worktree inside .gsd/worktrees/<name>/
      const worktreeDir = join(projectRoot, ".gsd", "worktrees", "slice-abc");
      mkdirSync(worktreeDir, { recursive: true });
      writeFileSync(
        join(worktreeDir, "package.json"),
        JSON.stringify({ name: "test-project" }),
      );
      // node_modules intentionally absent — this is the bug scenario

      const results = runEnvironmentChecks(worktreeDir);
      const depsCheck = results.find(r => r.name === "dependencies");

      // Before fix: this would return status "error" with "node_modules missing"
      // After fix: should return "ok" because project root has node_modules
      assert.ok(
        depsCheck === undefined || depsCheck.status !== "error",
        "worktree should not report env_dependencies error when project root has node_modules",
      );
    });

    // ── Worktree with NO node_modules anywhere should still error ──────
    test('worktree: missing node_modules everywhere should still error', () => {
      const projectRoot = createDir({
        "package.json": JSON.stringify({ name: "test-project" }),
      });
      cleanups.push(projectRoot);
      // No node_modules at project root either

      const worktreeDir = join(projectRoot, ".gsd", "worktrees", "slice-xyz");
      mkdirSync(worktreeDir, { recursive: true });
      writeFileSync(
        join(worktreeDir, "package.json"),
        JSON.stringify({ name: "test-project" }),
      );

      const results = runEnvironmentChecks(worktreeDir);
      const depsCheck = results.find(r => r.name === "dependencies");
      assert.ok(depsCheck !== undefined, "dependencies check still runs in worktree");
      assert.deepStrictEqual(depsCheck!.status, "error", "reports error when node_modules missing everywhere");
    });

    // ── Worktree env_dependencies not in doctor issues ──────────────────
    test('worktree: checkEnvironmentHealth should not add env_dependencies for valid worktree', async () => {
      const projectRoot = createDir({
        "package.json": JSON.stringify({ name: "test-project" }),
      });
      mkdirSync(join(projectRoot, "node_modules"), { recursive: true });
      cleanups.push(projectRoot);

      const worktreeDir = join(projectRoot, ".gsd", "worktrees", "slice-pr");
      mkdirSync(worktreeDir, { recursive: true });
      writeFileSync(
        join(worktreeDir, "package.json"),
        JSON.stringify({ name: "test-project" }),
      );

      const issues: any[] = [];
      await checkEnvironmentHealth(worktreeDir, issues);
      const depIssue = issues.find(i => i.code === "env_dependencies");
      assert.deepStrictEqual(
        depIssue,
        undefined,
        "no env_dependencies issue for worktree with project root node_modules",
      );
    });

    // ── Non-worktree path still catches missing node_modules ───────────
    test('non-worktree: missing node_modules still detected', () => {
      const dir = createDir({
        "package.json": JSON.stringify({ name: "test" }),
      });
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const depsCheck = results.find(r => r.name === "dependencies");
      assert.ok(depsCheck !== undefined, "dependencies check runs");
      assert.deepStrictEqual(depsCheck!.status, "error", "missing node_modules is an error for non-worktree");
    });

    // ── GSD_WORKTREE env var detection ─────────────────────────────────
    test('GSD_WORKTREE env: should resolve project root node_modules', () => {
      const projectRoot = createDir({
        "package.json": JSON.stringify({ name: "test-project" }),
      });
      mkdirSync(join(projectRoot, "node_modules"), { recursive: true });
      cleanups.push(projectRoot);

      // Create a directory that doesn't have .gsd/worktrees in path but
      // has GSD_WORKTREE env pointing to project root
      const someDir = createDir({
        "package.json": JSON.stringify({ name: "test-project" }),
      });
      cleanups.push(someDir);

      const origEnv = process.env.GSD_WORKTREE;
      try {
        process.env.GSD_WORKTREE = projectRoot;
        const results = runEnvironmentChecks(someDir);
        const depsCheck = results.find(r => r.name === "dependencies");
        assert.ok(
          depsCheck === undefined || depsCheck.status !== "error",
          "GSD_WORKTREE env allows fallback to project root node_modules",
        );
      } finally {
        if (origEnv === undefined) {
          delete process.env.GSD_WORKTREE;
        } else {
          process.env.GSD_WORKTREE = origEnv;
        }
      }
    });

  } finally {
    for (const dir of cleanups) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});
