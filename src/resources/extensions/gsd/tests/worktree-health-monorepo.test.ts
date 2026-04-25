/**
 * worktree-health-monorepo.test.ts — #2347
 *
 * The worktree health check previously rejected monorepos where the
 * project markers (package.json, Cargo.toml, etc.) live in a parent
 * directory rather than in the worktree's own checkout. The fix extracts
 * the parent-walk into `hasProjectFileInAncestor` in detection.ts; these
 * tests exercise that helper directly over a synthetic filesystem.
 *
 * Assertions cover:
 *   - a parent directory with a project marker is detected
 *   - the walk stops at a `.git` boundary so ancestors above the repo root
 *     (e.g. $HOME) cannot cause false positives
 *   - returns false when no ancestor has a marker
 *   - works for nested worktree layouts (monorepo/worktree/...)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { hasProjectFileInAncestor } from "../detection.ts";

function makeTempRoot(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-monorepo-health-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("#2347: parent directory containing package.json is detected", (t) => {
  const root = makeTempRoot(t);
  const worktree = join(root, "packages", "app");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(root, "package.json"), "{}");

  assert.equal(
    hasProjectFileInAncestor(worktree),
    true,
    "monorepo package.json in parent should be detected",
  );
});

test("#2347: parent with Cargo.toml is detected (not just JS ecosystems)", (t) => {
  const root = makeTempRoot(t);
  const worktree = join(root, "crates", "foo");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(root, "Cargo.toml"), "[workspace]\n");

  assert.equal(hasProjectFileInAncestor(worktree), true);
});

test("#2347: walk stops at .git boundary (no false positive from grandparent)", (t) => {
  const root = makeTempRoot(t);
  // Layout:
  //   root/package.json       ← must NOT trigger (above .git)
  //   root/repo/.git          ← repo boundary
  //   root/repo/worktree/     ← start dir (no markers)
  writeFileSync(join(root, "package.json"), "{}");
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const worktree = join(repo, "worktree");
  mkdirSync(worktree, { recursive: true });

  assert.equal(
    hasProjectFileInAncestor(worktree),
    false,
    "grandparent package.json above the .git boundary must be ignored",
  );
});

test("#2347: returns false when no ancestor has a marker", (t) => {
  const root = makeTempRoot(t);
  const worktree = join(root, "empty", "nested", "deep");
  mkdirSync(worktree, { recursive: true });

  assert.equal(hasProjectFileInAncestor(worktree), false);
});

test("#2347: detects marker in immediate parent of the worktree", (t) => {
  const root = makeTempRoot(t);
  const parent = join(root, "monorepo");
  const worktree = join(parent, "svc");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(parent, "go.mod"), "module x\n");

  assert.equal(hasProjectFileInAncestor(worktree), true);
});

test("#2347: existsFn injection allows deterministic testing without real FS", () => {
  // Simulate a layout: /a/b/c (start) → /a/b has pyproject.toml; nothing has .git.
  const existsFn = (p: string) =>
    p === "/a/b/pyproject.toml";

  assert.equal(hasProjectFileInAncestor("/a/b/c", existsFn), true);
});

test("#2347: existsFn injection — .git stops the walk before a marker ancestor", () => {
  // /a has package.json, but /a/b has .git — walk from /a/b/c must stop at /a/b.
  const existsFn = (p: string) =>
    p === "/a/package.json" || p === "/a/b/.git";

  assert.equal(
    hasProjectFileInAncestor("/a/b/c", existsFn),
    false,
    "walk must stop at the .git boundary before reaching /a/package.json",
  );
});
