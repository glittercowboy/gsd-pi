/**
 * worktree-health-monorepo.test.ts — #2347
 *
 * Tests that checkWorktreeHealth() correctly handles monorepo layouts
 * where project files (package.json, etc.) live in parent directories.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { checkWorktreeHealth } from "../auto/worktree-health.ts";

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `gsd-health-${prefix}-`));
}

function gitInit(dir: string): void {
  execSync("git init", { cwd: dir, stdio: "ignore" });
}

describe("#2347: checkWorktreeHealth monorepo support", () => {
  test("returns ok for directory with package.json", (t) => {
    const dir = createTempDir("pkg");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    gitInit(dir);
    writeFileSync(join(dir, "package.json"), "{}");

    const result = checkWorktreeHealth(dir);
    assert.deepStrictEqual(result.status, "ok");
  });

  test("returns ok for directory with src/", (t) => {
    const dir = createTempDir("src");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    gitInit(dir);
    mkdirSync(join(dir, "src"));

    const result = checkWorktreeHealth(dir);
    assert.deepStrictEqual(result.status, "ok");
  });

  test("returns ok for directory with Cargo.toml", (t) => {
    const dir = createTempDir("cargo");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    gitInit(dir);
    writeFileSync(join(dir, "Cargo.toml"), "[package]");

    const result = checkWorktreeHealth(dir);
    assert.deepStrictEqual(result.status, "ok");
  });

  test("returns no-git for directory without .git", (t) => {
    const dir = createTempDir("nogit");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "package.json"), "{}");

    const result = checkWorktreeHealth(dir);
    assert.deepStrictEqual(result.status, "no-git");
  });

  test("returns ok when package.json is in parent directory (monorepo)", (t) => {
    // Monorepo layout: root has .git + package.json, nested package has .git file (worktree link)
    // The parent walk from packages/subpkg goes to packages/ (no .git, no pkg.json) then root.
    // root has .git dir, so the walk stops there. But root also has package.json.
    // The walk checks .git FIRST — so if root has .git, we never see its package.json.
    //
    // Real monorepo layout: .git is at repo root, but package.json is in an intermediate dir
    // that does NOT have its own .git. E.g.:
    //   repo/.git
    //   repo/packages/subpkg/.git (file — worktree pointer)
    //   repo/packages/package.json  <-- intermediate dir has pkg.json but no .git
    const root = createTempDir("monorepo");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    gitInit(root);

    const pkgsDir = join(root, "packages");
    mkdirSync(pkgsDir, { recursive: true });
    writeFileSync(join(pkgsDir, "package.json"), "{}");

    const sub = join(pkgsDir, "subpkg");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, ".git"), "gitdir: ../../.git/worktrees/subpkg");

    const result = checkWorktreeHealth(sub);
    assert.deepStrictEqual(result.status, "ok");
  });

  test("parent walk stops at .git boundary", (t) => {
    const outer = createTempDir("boundary");
    t.after(() => rmSync(outer, { recursive: true, force: true }));
    // Outer repo has package.json — should NOT be found
    writeFileSync(join(outer, "package.json"), "{}");
    gitInit(outer);

    // Inner repo has NO project files but its own .git DIRECTORY (standalone repo)
    const inner = join(outer, "inner");
    mkdirSync(inner);
    gitInit(inner);

    const result = checkWorktreeHealth(inner);
    // Should NOT find outer's package.json because inner has its own .git boundary
    assert.deepStrictEqual(result.status, "greenfield");
  });

  test("returns greenfield for empty git repo with no project files", (t) => {
    const dir = createTempDir("green");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    gitInit(dir);

    const result = checkWorktreeHealth(dir);
    assert.deepStrictEqual(result.status, "greenfield");
    assert.ok(result.message.includes("no recognized project files"));
  });
});
