/**
 * worktree-submodule-safety.test.ts — #2337
 *
 * Worktree teardown (removeWorktree) uses --force which destroys
 * uncommitted changes in submodule directories. This test verifies
 * the removal logic by creating real worktrees with submodule-like
 * structures and asserting the teardown behavior.
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

import { createWorktree, removeWorktree } from "../worktree-manager.ts";

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-submod-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);
  return dir;
}

describe("#2337: Worktree submodule safety", () => {
  test("removeWorktree cleans up worktree without destroying repo data", (t) => {
    const repo = createTempRepo();
    t.after(() => rmSync(repo, { recursive: true, force: true }));

    // Create some important data alongside the worktree
    const dataDir = join(repo, "important-data");
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, "data.json"), '{"keep": true}');

    // Create and remove a worktree
    const wt = createWorktree(repo, "test-wt");
    assert.ok(existsSync(wt.path), "worktree created");

    removeWorktree(repo, "test-wt");
    assert.ok(!existsSync(wt.path), "worktree removed");
    assert.ok(existsSync(join(dataDir, "data.json")), "data preserved after teardown");
  });

  test("removeWorktree handles worktree with nested directories", (t) => {
    const repo = createTempRepo();
    t.after(() => rmSync(repo, { recursive: true, force: true }));

    const wt = createWorktree(repo, "nested-wt");

    // Create nested structure inside worktree (simulating submodule-like layout)
    const nestedDir = join(wt.path, "vendor", "subproject");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, "lib.ts"), "export const x = 1;");

    removeWorktree(repo, "nested-wt");
    assert.ok(!existsSync(wt.path), "worktree with nested dirs removed cleanly");
  });
});
