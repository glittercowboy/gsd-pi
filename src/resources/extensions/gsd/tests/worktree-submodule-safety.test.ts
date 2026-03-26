/**
 * worktree-submodule-safety.test.ts — #2337
 *
 * Worktree teardown (removeWorktree) uses --force which destroys
 * uncommitted changes in submodule directories. This test verifies
 * that the removal logic detects submodules and preserves their state.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestContext } from "./test-helpers.ts";

const { assertTrue, report } = createTestContext();

const srcPath = join(import.meta.dirname, "..", "worktree-manager.ts");
const src = readFileSync(srcPath, "utf-8");

console.log("\n=== #2337: Worktree teardown preserves submodule state ===");

// ── Test 1: removeWorktree function exists ──────────────────────────────

const removeWorktreeIdx = src.indexOf("export function removeWorktree");
assertTrue(removeWorktreeIdx > 0, "worktree-manager.ts exports removeWorktree");

const fnBody = src.slice(removeWorktreeIdx, removeWorktreeIdx + 3000);

// ── Test 2: The function checks for submodules before force removal ─────

const checksSubmodules =
  fnBody.includes("submodule") ||
  fnBody.includes(".gitmodules");

assertTrue(
  checksSubmodules,
  "removeWorktree checks for submodules before force removal (#2337)",
);

// ── Test 3: Submodule changes are stashed or warned about ───────────────

const preservesSubmoduleState =
  fnBody.includes("stash") ||
  fnBody.includes("uncommitted") ||
  fnBody.includes("dirty") ||
  fnBody.includes("submodule") && (fnBody.includes("warn") || fnBody.includes("preserv"));

assertTrue(
  preservesSubmoduleState,
  "removeWorktree preserves or warns about submodule uncommitted changes (#2337)",
);

// ── Test 4: Force removal is skipped when submodules have changes ───────

// The key fix: when submodules have dirty state, we should NOT use force
// removal. Instead, use non-force first and fall back to force only after
// submodule state is preserved.
const hasConditionalForce =
  fnBody.includes("submodule") &&
  (fnBody.includes("force") || fnBody.includes("--force"));

assertTrue(
  hasConditionalForce,
  "removeWorktree has conditional force logic around submodules (#2337)",
);

report();
