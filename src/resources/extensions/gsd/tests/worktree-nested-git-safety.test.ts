/**
 * worktree-nested-git-safety.test.ts — #2616
 *
 * When scaffolding tools (create-next-app, cargo init, etc.) run inside a
 * worktree, they create nested .git directories. This test verifies that
 * findNestedGitDirs detects them and that removeWorktree handles them.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
  existsSync, realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { findNestedGitDirs, createWorktree, removeWorktree } from "../worktree-manager.ts";

function createTempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `gsd-nested-git-${prefix}-`)));
}

function gitInit(dir: string): void {
  execSync("git init", { cwd: dir, stdio: "ignore" });
}

describe("#2616: findNestedGitDirs", () => {
  test("finds .git directories in subdirectories", (t) => {
    const root = createTempDir("find");
    t.after(() => rmSync(root, { recursive: true, force: true }));

    // Create a nested repo (simulating cargo init inside worktree)
    const nested = join(root, "apps", "subproject");
    mkdirSync(nested, { recursive: true });
    gitInit(nested);

    const found = findNestedGitDirs(root);
    assert.ok(found.length >= 1, "should find at least 1 nested .git");
    assert.ok(
      found.some(p => p.includes("subproject")),
      "should find the nested subproject",
    );
  });

  test("skips node_modules", (t) => {
    const root = createTempDir("skip-nm");
    t.after(() => rmSync(root, { recursive: true, force: true }));

    // .git inside node_modules should be ignored
    const nmRepo = join(root, "node_modules", "some-pkg");
    mkdirSync(nmRepo, { recursive: true });
    gitInit(nmRepo);

    const found = findNestedGitDirs(root);
    assert.deepStrictEqual(found.length, 0, "should skip node_modules");
  });

  test("returns empty for directory with no nested repos", (t) => {
    const root = createTempDir("empty");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "");

    const found = findNestedGitDirs(root);
    assert.deepStrictEqual(found.length, 0);
  });

  test("finds multiple nested repos", (t) => {
    const root = createTempDir("multi");
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const repo1 = join(root, "libs", "core");
    const repo2 = join(root, "libs", "utils");
    mkdirSync(repo1, { recursive: true });
    mkdirSync(repo2, { recursive: true });
    gitInit(repo1);
    gitInit(repo2);

    const found = findNestedGitDirs(root);
    assert.deepStrictEqual(found.length, 2, "should find both nested repos");
  });
});

describe("#2616: removeWorktree with nested .git directories", () => {
  test("removeWorktree succeeds even when worktree contains nested repos", (t) => {
    const repo = createTempDir("wt-nested");
    t.after(() => rmSync(repo, { recursive: true, force: true }));

    // Set up a real git repo
    gitInit(repo);
    execSync("git config user.email test@test.com", { cwd: repo, stdio: "ignore" });
    execSync("git config user.name Test", { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "README.md"), "# test\n");
    execSync("git add .", { cwd: repo, stdio: "ignore" });
    execSync("git commit -m init", { cwd: repo, stdio: "ignore" });
    execSync("git branch -M main", { cwd: repo, stdio: "ignore" });

    const wt = createWorktree(repo, "test-wt");
    assert.ok(existsSync(wt.path));

    // Simulate scaffolding tool creating a nested repo inside the worktree
    const scaffolded = join(wt.path, "new-app");
    mkdirSync(scaffolded, { recursive: true });
    gitInit(scaffolded);
    writeFileSync(join(scaffolded, "package.json"), "{}");

    // This should not throw
    removeWorktree(repo, "test-wt");
    assert.ok(!existsSync(wt.path), "worktree removed despite nested .git");
  });
});
