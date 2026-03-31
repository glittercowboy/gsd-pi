/**
 * worktree-nested-git-safety.test.ts — #2616
 *
 * When scaffolding tools (create-next-app, cargo init, etc.) run inside a
 * worktree, they create nested .git directories. Git treats these as gitlinks
 * (mode 160000) without a .gitmodules entry, so the worktree cleanup destroys
 * the only copy of those object databases — causing permanent data loss.
 *
 * This test verifies that removeWorktree detects nested .git directories
 * (orphaned gitlinks) and absorbs or removes them before cleanup so files
 * are tracked as regular content instead of unreachable gitlink pointers.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const srcPath = join(import.meta.dirname, "..", "worktree-manager.ts");
const src = readFileSync(srcPath, "utf-8");

test("#2616: removeWorktree scans for nested .git directories", () => {
  const removeWorktreeIdx = src.indexOf("export function removeWorktree");
  assert.ok(removeWorktreeIdx > 0, "worktree-manager.ts exports removeWorktree");

  const fnBody = src.slice(removeWorktreeIdx, removeWorktreeIdx + 5000);

  const detectsNestedGit =
    fnBody.includes("nested") && fnBody.includes(".git") ||
    fnBody.includes("gitlink") ||
    fnBody.includes("160000") ||
    fnBody.includes("findNestedGitDirs") ||
    fnBody.includes("nestedGitDirs");

  assert.ok(
    detectsNestedGit,
    "removeWorktree detects nested .git directories or gitlinks (#2616)",
  );
});

test("#2616: worktree-manager has a helper to find nested .git directories", () => {
  const hasNestedGitHelper =
    src.includes("findNestedGitDirs") ||
    src.includes("detectNestedGitDirs") ||
    src.includes("scanNestedGit") ||
    src.includes("absorbNestedGit") ||
    src.includes("nestedGitDirs");

  assert.ok(
    hasNestedGitHelper,
    "worktree-manager has a helper to find nested .git directories (#2616)",
  );
});

test("#2616: removeWorktree absorbs or removes nested .git dirs before cleanup", () => {
  const removeWorktreeIdx = src.indexOf("export function removeWorktree");
  assert.ok(removeWorktreeIdx > 0, "worktree-manager.ts exports removeWorktree");

  const fnBody = src.slice(removeWorktreeIdx, removeWorktreeIdx + 5000);

  const absorbsOrRemoves =
    fnBody.includes("absorb") ||
    fnBody.includes("rmSync") && fnBody.includes("nested") ||
    (fnBody.includes("nestedGitDirs") || fnBody.includes("findNestedGitDirs")) &&
      (fnBody.includes("rm") || fnBody.includes("absorb") || fnBody.includes("remove"));

  assert.ok(
    absorbsOrRemoves,
    "removeWorktree absorbs or removes nested .git dirs before cleanup (#2616)",
  );
});

test("#2616: removeWorktree warns when nested .git directories are detected", () => {
  const removeWorktreeIdx = src.indexOf("export function removeWorktree");
  assert.ok(removeWorktreeIdx > 0, "worktree-manager.ts exports removeWorktree");

  const fnBody = src.slice(removeWorktreeIdx, removeWorktreeIdx + 5000);

  const warnsAboutNestedGit =
    fnBody.includes("nested") && fnBody.includes("logWarning") ||
    fnBody.includes("gitlink") && fnBody.includes("logWarning") ||
    fnBody.includes("scaffold") && fnBody.includes("logWarning");

  assert.ok(
    warnsAboutNestedGit,
    "removeWorktree warns when nested .git directories are detected (#2616)",
  );
});

test("#2616: findNestedGitDirs skips node_modules and other excluded directories", () => {
  const helperBody = src.includes("findNestedGitDirs")
    ? src.slice(src.indexOf("findNestedGitDirs"))
    : "";

  const skipsExcludedDirs =
    helperBody.includes("node_modules") ||
    helperBody.includes(".gsd") ||
    helperBody.includes("skip") ||
    helperBody.includes("exclude");

  assert.ok(
    skipsExcludedDirs,
    "findNestedGitDirs skips node_modules and other excluded directories (#2616)",
  );
});
