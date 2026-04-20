/**
 * Regression test for #3461: createAutoWorktree must use git.main_branch
 * preference when META.json integration branch is absent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("auto-worktree.ts includes main_branch preference in startPoint fallback (#3461)", () => {
  const src = readFileSync(
    join(import.meta.dirname, "..", "auto-worktree.ts"),
    "utf-8",
  );
  // The fix adds gitPrefs?.main_branch to the startPoint fallback chain
  assert.ok(
    src.includes("gitPrefs?.main_branch") || src.includes("prefs.main_branch"),
    "createAutoWorktree must check git.main_branch preference before falling back to nativeDetectMainBranch",
  );
});
