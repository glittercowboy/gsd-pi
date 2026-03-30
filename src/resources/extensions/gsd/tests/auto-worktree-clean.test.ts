// GSD — Test: auto-worktree clean working tree
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { ensureCleanWorkingTree } from "../auto-worktree.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function run(command: string, cwd: string): string {
  return execSync(command, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function makeBaseRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-clean-wt-test-"));
  run("git init -b main", dir);
  run('git config user.name "Test User"', dir);
  run('git config user.email "test@example.com"', dir);
  writeFileSync(join(dir, "README.md"), "# Test Project\n", "utf-8");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "STATE.md"), "version: 1\n", "utf-8");
  run("git add .", dir);
  run('git commit -m "chore: init"', dir);
  return dir;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ensureCleanWorkingTree", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = makeBaseRepo();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  // ─── Case 1: already clean ─────────────────────────────────────────────────

  test("returns { stashed: false } when working tree is already clean", () => {
    const result = ensureCleanWorkingTree(repoDir);

    assert.strictEqual(result.stashed, false, "should not stash when clean");
    assert.ok(Array.isArray(result.cleaned), "cleaned should be an array");
  });

  // ─── Case 2: only .gsd/ files are dirty ───────────────────────────────────

  test("discards .gsd/ changes and returns clean when only .gsd/ files are dirty", () => {
    // Modify a tracked .gsd/ file (not staged — just dirty working tree)
    writeFileSync(join(repoDir, ".gsd", "STATE.md"), "version: 2-dirty\n", "utf-8");

    // Confirm it's dirty before calling the function
    const before = run("git status --porcelain", repoDir);
    assert.ok(before.length > 0, "working tree should be dirty before the call");

    const result = ensureCleanWorkingTree(repoDir);

    assert.strictEqual(
      result.stashed,
      false,
      "should not stash when only .gsd/ is dirty",
    );
    assert.ok(
      result.cleaned.some((c) => c.includes(".gsd")),
      "cleaned array should mention .gsd/ discard",
    );

    // Verify the working tree is clean after the call
    const after = run("git status --porcelain", repoDir);
    assert.strictEqual(
      after,
      "",
      "working tree should be clean after discarding .gsd/ changes",
    );
  });

  // ─── Case 3: tracked dirty files (non-.gsd/) get stashed ──────────────────

  test("stashes tracked dirty files and returns { stashed: true }", () => {
    // Modify a tracked non-.gsd/ file
    writeFileSync(join(repoDir, "README.md"), "# Modified\n", "utf-8");

    const before = run("git status --porcelain", repoDir);
    assert.ok(before.length > 0, "working tree should be dirty before the call");

    const result = ensureCleanWorkingTree(repoDir);

    assert.strictEqual(
      result.stashed,
      true,
      "should stash when tracked non-.gsd/ files are dirty",
    );
    assert.ok(result.stashRef, "stashRef should be set when a stash entry is created");
    assert.ok(
      result.cleaned.some((c) => c.includes("stash")),
      "cleaned array should mention stash operation",
    );

    // Verify the working tree is now clean (stashed)
    const after = run("git status --porcelain", repoDir);
    assert.strictEqual(after, "", "working tree should be clean after stashing");

    // Verify stash contains our change
    const stashList = run("git stash list", repoDir);
    assert.ok(stashList.includes("gsd:"), "stash should contain the gsd pre-merge entry");
  });

  test("stashes untracked-only dirtiness and preserves pre-existing stash entries", () => {
    // Create a pre-existing stash entry that should remain untouched.
    writeFileSync(join(repoDir, "README.md"), "# Stashed baseline\n", "utf-8");
    run("git stash push -m \"preexisting stash\"", repoDir);

    // Leave only an untracked file dirty.
    writeFileSync(join(repoDir, "new-untracked.txt"), "hello\n", "utf-8");

    const result = ensureCleanWorkingTree(repoDir);
    assert.strictEqual(
      result.stashed,
      true,
      "untracked-only changes should produce a new stash with --include-untracked",
    );
    assert.ok(result.stashRef, "stashRef should be set for the new stash entry");

    const stashList = run("git stash list", repoDir);
    assert.ok(
      stashList.includes("gsd: pre-merge clean state"),
      "new pre-merge stash entry should be present",
    );
    assert.ok(
      stashList.includes("preexisting stash"),
      "pre-existing stash should remain in the stack",
    );
  });

  // ─── Case 4: stash fails → abort+reset path ───────────────────────────────

  test("returns { stashed: false } after abort+reset when stash fails", () => {
    // To force git stash to fail we need the index to be in a conflicted state.
    // Strategy: create two branches with conflicting content, start a merge,
    // leave it in progress (MERGE_HEAD set, UU entries in index). In this state
    // `git stash push` will fail because the index has unresolved conflicts.

    // Add a file that will conflict on both branches
    writeFileSync(join(repoDir, "conflict.txt"), "line-a\n", "utf-8");
    run("git add conflict.txt", repoDir);
    run('git commit -m "add conflict.txt on main"', repoDir);

    // Create a diverging branch
    run("git checkout -b feature-branch", repoDir);
    writeFileSync(join(repoDir, "conflict.txt"), "line-feature\n", "utf-8");
    run("git add conflict.txt", repoDir);
    run('git commit -m "feature: conflict.txt"', repoDir);

    // Return to main and make a conflicting commit
    run("git checkout main", repoDir);
    writeFileSync(join(repoDir, "conflict.txt"), "line-main\n", "utf-8");
    run("git add conflict.txt", repoDir);
    run('git commit -m "main: conflict.txt"', repoDir);

    // Start a merge that will conflict — this leaves MERGE_HEAD in place
    try {
      run("git merge feature-branch --no-ff", repoDir);
    } catch {
      // Expected: merge conflict — repo is now in conflicted state
    }

    // Verify the repo is in the conflicted state we expect
    const statusBefore = run("git status --porcelain", repoDir);
    assert.ok(
      statusBefore.includes("UU") || statusBefore.includes("AA"),
      "repo should have unmerged entries to simulate stash-fail scenario",
    );

    // ensureCleanWorkingTree should escalate to abortAndReset (step 4)
    // because stash push fails when there are unresolved conflicts in the index.
    // After abort+reset, the working tree should be clean.
    const result = ensureCleanWorkingTree(repoDir);

    assert.strictEqual(
      result.stashed,
      false,
      "stash should not be set when abort+reset path was taken",
    );
    // The cleaned array should contain entries from abortAndReset + its success marker
    assert.ok(
      result.cleaned.length > 0,
      "cleaned array should be non-empty after abort+reset",
    );
    assert.ok(
      result.cleaned.some((c) =>
        c.includes("abort") || c.includes("reset") || c.includes("merge"),
      ),
      "cleaned array should reflect abort+reset actions",
    );
  });
});
