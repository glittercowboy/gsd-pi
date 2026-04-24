/**
 * worktree-nested-git-safety.test.ts — #2616
 *
 * When scaffolding tools (create-next-app, cargo init, etc.) run inside a
 * worktree, they create nested .git directories. Git treats these as gitlinks
 * (mode 160000) without a .gitmodules entry, so the worktree cleanup destroys
 * the only copy of those object databases — causing permanent data loss.
 *
 * These tests exercise findNestedGitDirs directly against a synthetic
 * filesystem layout to verify that nested .git *directories* are detected
 * (while .git *files* — legitimate worktree pointers — are not), and that
 * non-project directories (node_modules, .gsd, target, etc.) are skipped.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { findNestedGitDirs } from "../worktree-manager.ts";

function makeRoot(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-nested-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("#2616: findNestedGitDirs detects a nested repo at the top level", (t) => {
  const root = makeRoot(t);

  // Simulate a scaffolded project at root/scaffolded with its own .git *directory*.
  const scaffolded = join(root, "scaffolded");
  mkdirSync(join(scaffolded, ".git", "objects"), { recursive: true });
  writeFileSync(join(scaffolded, "package.json"), "{}");

  const found = findNestedGitDirs(root);
  assert.ok(
    found.includes(scaffolded),
    `expected ${scaffolded} in findNestedGitDirs output, got ${JSON.stringify(found)}`,
  );
});

test("#2616: findNestedGitDirs ignores .git files (worktree pointers)", (t) => {
  const root = makeRoot(t);

  // A worktree or submodule has a .git *file*, not a directory. This is legitimate.
  const sub = join(root, "legit-worktree");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");

  const found = findNestedGitDirs(root);
  assert.ok(
    !found.includes(sub),
    `.git file (worktree pointer) must not be flagged as a nested repo; got ${JSON.stringify(found)}`,
  );
});

test("#2616: findNestedGitDirs skips excluded directories (node_modules, .gsd, target)", (t) => {
  const root = makeRoot(t);

  // All three of these contain a .git *directory*, but the scan must skip them.
  for (const excluded of ["node_modules", ".gsd", "target"]) {
    const inside = join(root, excluded, "vendored-pkg");
    mkdirSync(join(inside, ".git"), { recursive: true });
  }

  const found = findNestedGitDirs(root);
  assert.equal(
    found.length,
    0,
    `excluded directories must be skipped, got ${JSON.stringify(found)}`,
  );
});

test("#2616: findNestedGitDirs finds deeply nested repos", (t) => {
  const root = makeRoot(t);
  const deep = join(root, "a", "b", "c", "scaffolded");
  mkdirSync(join(deep, ".git"), { recursive: true });

  const found = findNestedGitDirs(root);
  assert.ok(
    found.includes(deep),
    `expected deep path ${deep} in output, got ${JSON.stringify(found)}`,
  );
});

test("#2616: findNestedGitDirs does not recurse into a found nested repo", (t) => {
  const root = makeRoot(t);

  // Outer scaffolded dir has .git; inside, a further sub-repo also has .git.
  const outer = join(root, "outer");
  mkdirSync(join(outer, ".git"), { recursive: true });
  const inner = join(outer, "inner");
  mkdirSync(join(inner, ".git"), { recursive: true });

  const found = findNestedGitDirs(root);
  assert.ok(found.includes(outer), "outer repo is detected");
  assert.ok(
    !found.includes(inner),
    "must not recurse into the outer nested repo (stops at first hit)",
  );
});
