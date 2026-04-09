/**
 * merge-conflict-stops-loop.test.ts — #2330
 *
 * When a squash merge has real code conflicts (not just .gsd/ files),
 * the merge retries forever because MergeConflictError is caught
 * silently in mergeAndExit. This test verifies that:
 * 1. worktree-resolver re-throws MergeConflictError for code conflicts
 * 2. auto/phases.ts wraps mergeAndExit calls to stop the loop on conflict
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestContext } from "./test-helpers.ts";

const { assertTrue, report } = createTestContext();

const resolverPath = join(import.meta.dirname, "..", "worktree-resolver.ts");
const resolverSrc = readFileSync(resolverPath, "utf-8");

const phasesPath = join(import.meta.dirname, "..", "auto", "phases.ts");
const phasesSrc = readFileSync(phasesPath, "utf-8");

console.log("\n=== #2330: Merge conflict stops auto loop ===");

// ── Test 1: worktree-resolver re-throws MergeConflictError ──────────────

const methodStart = resolverSrc.indexOf("Worktree-mode merge:");
assertTrue(methodStart > 0, "worktree-resolver has _mergeWorktreeMode method");

const methodBody = resolverSrc.slice(methodStart, methodStart + 6000);
const rethrowsConflict =
  methodBody.includes("MergeConflictError") &&
  methodBody.includes("throw err");

assertTrue(
  rethrowsConflict,
  "worktree-resolver._mergeWorktreeMode re-throws MergeConflictError (#2330)",
);

// ── Test 2: auto/phases.ts imports and uses MergeConflictError ──────────

assertTrue(
  phasesSrc.includes("MergeConflictError") && phasesSrc.includes("mergeAndExit"),
  "auto/phases.ts handles MergeConflictError from mergeAndExit (#2330)",
);

// ── Test 3: The handler stops the loop (doesn't just warn) ──────────────

// Find the instanceof MergeConflictError check (not the import line)
const instanceofIdx = phasesSrc.indexOf("instanceof MergeConflictError");
assertTrue(instanceofIdx > 0, "auto/phases.ts has instanceof MergeConflictError check");

if (instanceofIdx > 0) {
  const afterHandler = phasesSrc.slice(instanceofIdx, instanceofIdx + 500);
  const stopsLoop =
    afterHandler.includes("stopAuto") ||
    afterHandler.includes('action: "break"') ||
    afterHandler.includes("reason: \"merge-conflict\"");

  assertTrue(
    stopsLoop,
    "auto/phases.ts stops the loop when merge conflict is detected (#2330)",
  );
}

report();
