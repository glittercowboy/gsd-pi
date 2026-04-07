/**
 * worktree-teardown-safety.test.ts — Regression test for #2365.
 *
 * Ensures that removeWorktree() and teardownAutoWorktree() never delete
 * directories outside .gsd/worktrees/.  The bug: removeWorktree overrides
 * the computed worktree path with whatever `git worktree list` reports.
 * When .gsd/ was (or is) a symlink, git resolves the symlink at creation
 * time, so its registered path can point to an external directory.  If that
 * external path happens to be a project data directory, teardown destroys it.
 *
 * The fix adds path validation so rmSync / nativeWorktreeRemove only operate
 * on paths that are actually under .gsd/worktrees/.
 */

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  realpathSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { createWorktree, removeWorktree, worktreePath, isInsideWorktreesDir } from "../worktree-manager.ts";

function run(command: string, cwd: string): string {
  return execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-safety-test-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);
  return dir;
}

describe("worktree-teardown-safety", () => {
  const dirs: string[] = [];

  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("removeWorktree does not delete sibling data directories", () => {
    const tempDir = createTempRepo();
    dirs.push(tempDir);

    const dataDir = join(tempDir, "project-data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "important.db"), "precious data");

    const wt = createWorktree(tempDir, "test-wt");
    assert.ok(existsSync(wt.path));

    removeWorktree(tempDir, "test-wt");

    assert.ok(!existsSync(wt.path), "worktree directory removed");
    assert.ok(existsSync(dataDir), "project data directory survives teardown");
    assert.ok(existsSync(join(dataDir, "important.db")), "project data files survive");
  });

  test("path validation rejects paths outside .gsd/worktrees/", () => {
    const tempDir = createTempRepo();
    dirs.push(tempDir);

    const externalDir = join(tempDir, "external-state");
    mkdirSync(externalDir, { recursive: true });
    writeFileSync(join(externalDir, "state.json"), '{"critical": true}');

    const wt2 = createWorktree(tempDir, "safe-wt");
    assert.ok(existsSync(wt2.path));

    removeWorktree(tempDir, "safe-wt");
    assert.ok(!existsSync(wt2.path), "second worktree removed cleanly");

    assert.ok(existsSync(externalDir), "external directory survives teardown");
    assert.deepStrictEqual(
      readFileSync(join(externalDir, "state.json"), "utf-8"),
      '{"critical": true}',
    );
  });

  test("worktreePath always returns paths under .gsd/worktrees/", () => {
    const tempDir = createTempRepo();
    dirs.push(tempDir);

    const wtPathResult = worktreePath(tempDir, "anything");
    assert.ok(wtPathResult.startsWith(join(tempDir, ".gsd", "worktrees")));
  });

  test("isInsideWorktreesDir rejects path traversal attempts", () => {
    const tempDir = createTempRepo();
    dirs.push(tempDir);

    assert.ok(isInsideWorktreesDir(tempDir, join(tempDir, ".gsd", "worktrees", "my-wt")));
    assert.ok(!isInsideWorktreesDir(tempDir, join(tempDir, "project-data")));
    assert.ok(!isInsideWorktreesDir(tempDir, join(tempDir, ".gsd", "worktrees", "..", "..", "project-data")));
    assert.ok(!isInsideWorktreesDir(tempDir, "/tmp/some-other-dir"));
  });
});
