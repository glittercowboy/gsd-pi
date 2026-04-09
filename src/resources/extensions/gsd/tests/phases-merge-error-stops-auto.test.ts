/**
 * phases-merge-error-stops-auto.test.ts — Regression test for #2766.
 *
 * When mergeAndExit throws a non-MergeConflictError, the auto loop must
 * stop instead of continuing with unmerged work. This test verifies that
 * all catch blocks in auto/phases.ts that handle mergeAndExit errors
 * call stopAuto and return { action: "break" } for non-conflict errors.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestContext } from "./test-helpers.ts";

const { assertTrue, report } = createTestContext();

const phasesPath = join(import.meta.dirname, "..", "auto", "phases.ts");
const phasesSrc = readFileSync(phasesPath, "utf-8");

console.log("\n=== #2766: Non-MergeConflictError stops auto mode ===");

// ── Test 1: phases.ts calls logError for non-conflict merge errors ──────

assertTrue(
  phasesPath.length > 0 && phasesPath.endsWith("phases.ts"),
  "phases.ts file exists and is readable",
);

// Count all mergeAndExit catch blocks by finding "} catch (mergeErr)" patterns
const mergeErrCatches = [...phasesPath.matchAll(/\} catch \(mergeErr\)/g)];
// Use the source itself for matching
const mergeErrCatchCount = [...phasesSrc.matchAll(/\} catch \(mergeErr\)/g)].length;
assertTrue(
  mergeErrCatchCount >= 3,
  `all mergeAndExit call sites have catch (mergeErr) blocks (found ${mergeErrCatchCount}, expected >= 3)`,
);

// ── Test 2: Every mergeErr catch block handles non-MergeConflictError ───

// Find each catch block and verify it has the non-conflict error handling pattern
const catchPattern = /\} catch \(mergeErr\) \{/g;
let match;
let blocksWithNonConflictHandling = 0;
let blocksTotal = 0;

while ((match = catchPattern.exec(phasesSrc)) !== null) {
  blocksTotal++;
  // Look at the ~800 chars after the catch to find both the MergeConflictError
  // instanceof check AND the non-conflict handling
  const afterCatch = phasesSrc.slice(match.index, match.index + 1200);

  const hasInstanceofCheck = afterCatch.includes("instanceof MergeConflictError");
  const hasNonConflictStop = afterCatch.includes('reason: "merge-failed"');
  const hasStopAuto = afterCatch.includes("stopAuto");
  const hasLogError = afterCatch.includes("logError");

  if (hasInstanceofCheck && hasNonConflictStop && hasStopAuto && hasLogError) {
    blocksWithNonConflictHandling++;
  }
}

assertTrue(
  blocksWithNonConflictHandling === blocksTotal && blocksTotal >= 3,
  `all ${blocksTotal} mergeAndExit catch blocks stop auto on non-conflict errors (${blocksWithNonConflictHandling}/${blocksTotal})`,
);

// ── Test 3: Non-conflict handler returns break (does not continue) ──────

// Verify the pattern: after the MergeConflictError instanceof block,
// the non-conflict path returns { action: "break", reason: "merge-failed" }
const mergeFailedReasons = [...phasesSrc.matchAll(/reason: "merge-failed"/g)].length;
assertTrue(
  mergeFailedReasons >= 3,
  `all catch blocks return reason: "merge-failed" (found ${mergeFailedReasons}, expected >= 3)`,
);

// ── Test 4: Non-conflict handler notifies user ──────────────────────────

// Each non-conflict block should call ctx.ui.notify with error severity
const notifyErrorPattern = /Merge failed:.*Resolve and run \/gsd auto to resume/g;
const notifyCount = [...phasesSrc.matchAll(notifyErrorPattern)].length;
assertTrue(
  notifyCount >= 3,
  `all catch blocks notify user about merge failure (found ${notifyCount}, expected >= 3)`,
);

// ── Test 5: logError replaces logWarning for non-conflict merge errors ──

// The old code used logWarning — verify logError is used instead
const logWarningMergePattern = /logWarning\(.*Milestone merge failed with non-conflict error/g;
const logWarningCount = [...phasesSrc.matchAll(logWarningMergePattern)].length;
assertTrue(
  logWarningCount === 0,
  "logWarning is no longer used for non-conflict merge errors (replaced by logError)",
);

const logErrorMergePattern = /logError\(.*Milestone merge failed with non-conflict error/g;
const logErrorCount = [...phasesSrc.matchAll(logErrorMergePattern)].length;
assertTrue(
  logErrorCount >= 3,
  `logError is used for non-conflict merge errors (found ${logErrorCount}, expected >= 3)`,
);

report();
