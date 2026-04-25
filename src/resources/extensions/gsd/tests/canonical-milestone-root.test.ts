/**
 * Tests for resolveCanonicalMilestoneRoot — the worktree-aware reader
 * that fixes #4761 (worktree work stranded when auto-loop exits without
 * milestone completion).
 *
 * Contract: given (basePath, milestoneId), return the worktree path if a
 * live git worktree exists for that milestone at .gsd/worktrees/<MID>/;
 * otherwise return basePath unchanged. A live worktree has a .git file
 * (not directory) — a bare directory without .git is a stale leftover.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { resolveCanonicalMilestoneRoot } from "../worktree-manager.ts";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-canon-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
}

/**
 * Create a worktree directory shape that looks live: the .gsd/worktrees/<MID>/
 * directory with a .git file containing a gitdir: pointer. We don't need a
 * real git worktree — the resolver only checks for the .git file's presence.
 */
function makeLiveWorktree(base: string, mid: string): string {
  const wtPath = join(base, ".gsd", "worktrees", mid);
  mkdirSync(wtPath, { recursive: true });
  writeFileSync(
    join(wtPath, ".git"),
    `gitdir: ${join(base, ".git", "worktrees", mid)}\n`,
  );
  return wtPath;
}

function makeStaleWorktree(base: string, mid: string): string {
  const wtPath = join(base, ".gsd", "worktrees", mid);
  mkdirSync(wtPath, { recursive: true });
  // No .git file — this is the stale-leftover shape createWorktree() sees
  // and cleans up.
  return wtPath;
}

test("returns worktree path when a live worktree exists for the milestone", () => {
  const base = makeTmpBase();
  try {
    const wtPath = makeLiveWorktree(base, "M001");
    const result = resolveCanonicalMilestoneRoot(base, "M001");
    assert.equal(result, wtPath);
  } finally {
    cleanup(base);
  }
});

test("returns basePath when no worktree directory exists", () => {
  const base = makeTmpBase();
  try {
    const result = resolveCanonicalMilestoneRoot(base, "M001");
    assert.equal(result, base);
  } finally {
    cleanup(base);
  }
});

test("returns basePath when worktree directory exists but has no .git file (stale)", () => {
  const base = makeTmpBase();
  try {
    makeStaleWorktree(base, "M001");
    const result = resolveCanonicalMilestoneRoot(base, "M001");
    assert.equal(result, base);
  } finally {
    cleanup(base);
  }
});

test("returns basePath for invalid milestoneId (path separators)", () => {
  const base = makeTmpBase();
  try {
    // Even if a worktree coincidentally exists, the guard should reject.
    assert.equal(resolveCanonicalMilestoneRoot(base, "../evil"), base);
    assert.equal(resolveCanonicalMilestoneRoot(base, "M001/subdir"), base);
    assert.equal(resolveCanonicalMilestoneRoot(base, "M001\\subdir"), base);
    assert.equal(resolveCanonicalMilestoneRoot(base, ""), base);
  } finally {
    cleanup(base);
  }
});

test("only returns the worktree for the requested milestone, not siblings", () => {
  const base = makeTmpBase();
  try {
    makeLiveWorktree(base, "M001");
    const result = resolveCanonicalMilestoneRoot(base, "M002");
    assert.equal(result, base, "M002 has no worktree → basePath");
  } finally {
    cleanup(base);
  }
});
