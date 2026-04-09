/**
 * Regression test for #1852: removeWorktree targets wrong path when .gsd/ is a symlink.
 *
 * When .gsd/ is a symlink to an external state directory, git registers
 * the worktree at the resolved (real) path. But removeWorktree recomputes
 * the path via worktreePath() which uses the unresolved symlink, causing
 * a mismatch — the removal silently fails.
 *
 * Fix: removeWorktree should query `git worktree list` to find the actual
 * registered path when the computed path doesn't match.
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  createWorktree,
  removeWorktree,
  listWorktrees,
  worktreePath,
} from "../worktree-manager.ts";
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';


function run(command: string, cwd: string): string {
  return execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

// Set up a test repo with .gsd/ as a symlink to an external directory,
// mimicking the external state directory layout (~/.gsd/projects/<hash>/).
// Resolve tmpdir to handle macOS /tmp -> /private/var/... symlink.
const realTmp = realpathSync(tmpdir());
const base = mkdtempSync(join(realTmp, "gsd-wt-symlink-test-"));
const externalState = mkdtempSync(join(realTmp, "gsd-wt-symlink-ext-"));

run("git init -b main", base);
run('git config user.name "Test"', base);
run('git config user.email "test@example.com"', base);

// Create external state directory structure
mkdirSync(join(externalState, "worktrees"), { recursive: true });

// Create .gsd as a symlink to the external state directory
symlinkSync(externalState, join(base, ".gsd"));

// Verify the symlink is in place
assert.ok(existsSync(join(base, ".gsd")), ".gsd symlink exists");
assert.ok(
  realpathSync(join(base, ".gsd")) === externalState,
  ".gsd resolves to external state dir",
);

// Create initial commit so we have a valid repo
writeFileSync(join(base, "README.md"), "# Test\n", "utf-8");
run("git add .", base);
run('git commit -m "init"', base);

describe('worktree-symlink-removal', async () => {
  console.log("\n=== #1852: removeWorktree with symlinked .gsd/ ===");

  // Create a worktree — git will resolve the symlink and register
  // the worktree at the external path
  const info = createWorktree(base, "M002", { branch: "milestone/M002" });
  assert.ok(info.exists, "worktree created");

  // Verify worktree was created at the resolved (external) path
  const realWtPath = realpathSync(info.path);
  assert.ok(
    realWtPath.startsWith(externalState),
    `worktree real path (${realWtPath}) is under external state dir`,
  );

  // Verify git registered the worktree
  const gitList = run("git worktree list", base);
  assert.ok(gitList.includes("M002"), "git worktree list shows M002");

  // The computed path via worktreePath uses the symlink path
  const computedPath = worktreePath(base, "M002");
  assert.ok(existsSync(computedPath), "computed path exists (via symlink)");

  // Simulate what syncStateToProjectRoot does: replace the .gsd symlink with
  // a real directory containing stale worktree data. This causes worktreePath()
  // to compute a LOCAL path that differs from git's REGISTERED path (the
  // resolved external path). The stale local dir passes existsSync but is not
  // a real git worktree, so nativeWorktreeRemove fails silently.
  unlinkSync(join(base, ".gsd"));  // remove the symlink
  mkdirSync(join(base, ".gsd", "worktrees", "M002"), { recursive: true });
  // Write a dummy file so the stale directory is non-empty
  writeFileSync(join(base, ".gsd", "worktrees", "M002", "stale.txt"), "stale sync artifact", "utf-8");

  // Now worktreePath(base, "M002") points to the LOCAL stale dir, not the
  // external path where git actually registered the worktree.
  const stalePath = worktreePath(base, "M002");
  assert.ok(existsSync(stalePath), "stale local worktree dir exists");
  assert.ok(
    stalePath !== realWtPath,
    `computed path (${stalePath}) differs from git-registered path (${realWtPath})`,
  );

  // THE ACTUAL TEST: removeWorktree must find the git-registered path and
  // remove the real worktree, not just operate on the stale local directory.
  removeWorktree(base, "M002", { branch: "milestone/M002", deleteBranch: true });

  // After removal, the worktree should be gone from git's list
  const gitListAfter = run("git worktree list", base);
  assert.ok(
    !gitListAfter.includes("M002"),
    "worktree removed from git worktree list after removeWorktree",
  );

  // The branch should be deleted
  const branches = run("git branch", base);
  assert.ok(
    !branches.includes("milestone/M002"),
    "milestone/M002 branch deleted after removeWorktree",
  );

  // The worktree directory should be gone
  assert.ok(
    !existsSync(realWtPath),
    "worktree directory removed from disk",
  );

  // List should be empty
  const listed = listWorktrees(base);
  assert.deepStrictEqual(listed.length, 0, "no worktrees listed after removal");

  // Cleanup
  rmSync(base, { recursive: true, force: true });
  rmSync(externalState, { recursive: true, force: true });
});
