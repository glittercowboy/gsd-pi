/**
 * stop-auto-merge-back.test.ts — Regression test for #2317.
 *
 * When auto-mode stops after a milestone is complete, stopAuto should trigger
 * merge-back (mergeAndExit) instead of just exiting the worktree with
 * preserveBranch: true. Otherwise milestone code stays stranded on the
 * worktree branch and never reaches main.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Source analysis: stopAuto calls mergeAndExit for complete milestones ────

const autoSrcPath = join(import.meta.dirname, "..", "auto.ts");
const autoSrc = readFileSync(autoSrcPath, "utf-8");

test("#2317: stopAuto should check milestone completion status before choosing exit strategy", () => {
  // stopAuto Step 4 should NOT unconditionally call exitMilestone(preserveBranch: true).
  // It should check if the milestone is complete and call mergeAndExit instead.

  // Find the Step 4 section
  const step4Idx = autoSrc.indexOf("Step 4: Auto-worktree exit");
  assert.ok(step4Idx !== -1, "Step 4 comment exists in stopAuto");

  // Extract a reasonable window around Step 4 (up to Step 5)
  const step5Idx = autoSrc.indexOf("Step 5:", step4Idx);
  const step4Block = autoSrc.slice(step4Idx, step5Idx);

  // The fix: Step 4 should call mergeAndExit when milestone is complete
  assert.ok(
    step4Block.includes("mergeAndExit"),
    "Step 4 should call mergeAndExit for completed milestones",
  );
});

test("#2317: stopAuto should detect milestone completion via SUMMARY file or DB", () => {
  const step4Idx = autoSrc.indexOf("Step 4: Auto-worktree exit");
  const step5Idx = autoSrc.indexOf("Step 5:", step4Idx);
  const step4Block = autoSrc.slice(step4Idx, step5Idx);

  // Should check completion status — either via SUMMARY file, DB getMilestone, or phase
  const checksCompletion =
    step4Block.includes("SUMMARY") ||
    step4Block.includes("getMilestone") ||
    step4Block.includes("complete") ||
    step4Block.includes("isMilestoneComplete");

  assert.ok(
    checksCompletion,
    "Step 4 should check if milestone is complete before deciding exit strategy",
  );
});

test("#2317: stopAuto still preserves branch for incomplete milestones", () => {
  const step4Idx = autoSrc.indexOf("Step 4: Auto-worktree exit");
  const step5Idx = autoSrc.indexOf("Step 5:", step4Idx);
  const step4Block = autoSrc.slice(step4Idx, step5Idx);

  // preserveBranch should still be used as fallback for non-complete milestones
  assert.ok(
    step4Block.includes("preserveBranch"),
    "Step 4 should still preserve branch for incomplete milestones (fallback path)",
  );
});
