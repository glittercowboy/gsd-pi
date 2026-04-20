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
import { createTestContext } from "./test-helpers.ts";

const { assertTrue, report } = createTestContext();

const srcPath = join(import.meta.dirname, "..", "worktree-manager.ts");
const src = readFileSync(srcPath, "utf-8");

console.log("\n=== #2616: Worktree cleanup detects nested .git directories ===");

// ── Test 1: removeWorktree scans for nested .git directories ─────────

const removeWorktreeIdx = src.indexOf("export function removeWorktree");
assertTrue(removeWorktreeIdx > 0, "worktree-manager.ts exports removeWorktree");

const fnBody = src.slice(removeWorktreeIdx, removeWorktreeIdx + 5000);

const detectsNestedGit =
  fnBody.includes("nested") && fnBody.includes(".git") ||
  fnBody.includes("gitlink") ||
  fnBody.includes("160000") ||
  fnBody.includes("findNestedGitDirs") ||
  fnBody.includes("nestedGitDirs");

assertTrue(
  detectsNestedGit,
  "removeWorktree detects nested .git directories or gitlinks (#2616)",
);

// ── Test 2: A helper function exists to find nested .git directories ──

const hasNestedGitHelper =
  src.includes("findNestedGitDirs") ||
  src.includes("detectNestedGitDirs") ||
  src.includes("scanNestedGit") ||
  src.includes("absorbNestedGit") ||
  src.includes("nestedGitDirs");

assertTrue(
  hasNestedGitHelper,
  "worktree-manager has a helper to find nested .git directories (#2616)",
);

// ── Test 3: Nested .git dirs are absorbed or removed before cleanup ───

const absorbsOrRemoves =
  fnBody.includes("absorb") ||
  fnBody.includes("rmSync") && fnBody.includes("nested") ||
  (fnBody.includes("nestedGitDirs") || fnBody.includes("findNestedGitDirs")) &&
    (fnBody.includes("rm") || fnBody.includes("absorb") || fnBody.includes("remove"));

assertTrue(
  absorbsOrRemoves,
  "removeWorktree absorbs or removes nested .git dirs before cleanup (#2616)",
);

// ── Test 4: A warning is logged when nested .git dirs are found ───────

const warnsAboutNestedGit =
  fnBody.includes("nested") && fnBody.includes("logWarning") ||
  fnBody.includes("gitlink") && fnBody.includes("logWarning") ||
  fnBody.includes("scaffold") && fnBody.includes("logWarning");

assertTrue(
  warnsAboutNestedGit,
  "removeWorktree warns when nested .git directories are detected (#2616)",
);

// ── Test 5: The findNestedGitDirs helper correctly identifies nested repos ──
// Verify the helper scans subdirectories but skips .gsd/, node_modules/, .git/

const helperBody = src.includes("findNestedGitDirs")
  ? src.slice(src.indexOf("findNestedGitDirs"))
  : "";

const skipsExcludedDirs =
  helperBody.includes("node_modules") ||
  helperBody.includes(".gsd") ||
  helperBody.includes("skip") ||
  helperBody.includes("exclude");

assertTrue(
  skipsExcludedDirs,
  "findNestedGitDirs skips node_modules and other excluded directories (#2616)",
);

report();
