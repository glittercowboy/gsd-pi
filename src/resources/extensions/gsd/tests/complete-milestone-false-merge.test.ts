/**
 * complete-milestone-false-merge.test.ts — Regression test for #4175.
 *
 * Before the fix, a failed complete-milestone unit could leave a stub
 * SUMMARY blocker placeholder on disk. stopAuto's SUMMARY-presence check
 * then treated the milestone as complete and merged the worktree branch
 * into main — emitting a misleading metadata-only merge warning for a
 * milestone that was never legitimately finished.
 *
 * The fix has three cooperating parts:
 *   1. stopAuto uses DB status (authoritative) instead of SUMMARY presence
 *      when the project DB is available.
 *   2. postUnitPreVerification pauses auto-mode for complete-milestone
 *      after retries are exhausted instead of writing a blocker placeholder.
 *   3. recoverTimedOutUnit pauses for complete-milestone instead of
 *      writing a blocker placeholder.
 *
 * This test guards all three via source inspection so a future refactor
 * cannot silently reintroduce the false-merge path.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const gsdDir = join(import.meta.dirname, "..");
const autoSrc = readFileSync(join(gsdDir, "auto.ts"), "utf-8");
const postUnitSrc = readFileSync(join(gsdDir, "auto-post-unit.ts"), "utf-8");
const timeoutSrc = readFileSync(join(gsdDir, "auto-timeout-recovery.ts"), "utf-8");

test("#4175: stopAuto uses DB status as the authoritative milestone-complete signal", () => {
  const step4Idx = autoSrc.indexOf("Step 4: Auto-worktree exit");
  assert.ok(step4Idx !== -1, "Step 4 comment exists in stopAuto");
  const step5Idx = autoSrc.indexOf("Step 5:", step4Idx);
  const step4Block = autoSrc.slice(step4Idx, step5Idx);

  assert.ok(
    step4Block.includes("isDbAvailable()"),
    "Step 4 should branch on isDbAvailable() so DB is consulted when present",
  );
  assert.ok(
    step4Block.includes("getMilestone(s.currentMilestoneId)"),
    "Step 4 should read authoritative milestone status via getMilestone()",
  );
  assert.ok(
    /status\s*===\s*"complete"/.test(step4Block),
    'Step 4 should compare the DB row status to "complete"',
  );
});

test("#4175: stopAuto imports getMilestone from gsd-db", () => {
  assert.ok(
    /import\s*\{[^}]*\bgetMilestone\b[^}]*\}\s*from\s*"\.\/gsd-db\.js"/.test(autoSrc),
    "auto.ts should import getMilestone from ./gsd-db.js",
  );
});

test("#4175: stopAuto still falls back to SUMMARY presence when DB is unavailable", () => {
  const step4Idx = autoSrc.indexOf("Step 4: Auto-worktree exit");
  const step5Idx = autoSrc.indexOf("Step 5:", step4Idx);
  const step4Block = autoSrc.slice(step4Idx, step5Idx);

  assert.ok(
    step4Block.includes("resolveMilestoneFile"),
    "Step 4 should keep SUMMARY-file resolution for DB-unavailable projects",
  );
  assert.ok(
    step4Block.includes("preserveBranch"),
    "Step 4 should still preserve branch for incomplete milestones (fallback path)",
  );
});

test("#4175: postUnitPreVerification pauses complete-milestone after retries exhausted", () => {
  // The pause branch must live inside the retries-exhausted block, above the
  // writeBlockerPlaceholder call — otherwise the stub SUMMARY is still written.
  const retriesExhaustedIdx = postUnitSrc.indexOf(
    "if (attempt > MAX_VERIFICATION_RETRIES)",
  );
  assert.ok(
    retriesExhaustedIdx !== -1,
    "retries-exhausted guard exists in postUnitPreVerification",
  );

  const blockerCallIdx = postUnitSrc.indexOf("writeBlockerPlaceholder", retriesExhaustedIdx);
  assert.ok(
    blockerCallIdx !== -1,
    "blocker placeholder call still exists for non-milestone units",
  );

  const exhaustedBlock = postUnitSrc.slice(retriesExhaustedIdx, blockerCallIdx);

  assert.ok(
    /s\.currentUnit\.type\s*===\s*"complete-milestone"/.test(exhaustedBlock),
    "retries-exhausted block should specifically handle complete-milestone",
  );
  assert.ok(
    /pauseAuto\s*\(\s*ctx\s*,\s*pi\s*\)/.test(exhaustedBlock),
    "complete-milestone path should call pauseAuto instead of falling through",
  );
  // The pause branch must return so execution never reaches writeBlockerPlaceholder.
  assert.ok(
    /return\s+"dispatched"\s*;/.test(exhaustedBlock),
    "complete-milestone pause branch should return before the placeholder call",
  );
});

test("#4175: recoverTimedOutUnit pauses complete-milestone instead of writing a blocker placeholder", () => {
  // The complete-milestone pause branch must sit immediately above the
  // "retries exhausted" writeBlockerPlaceholder call so a failed
  // complete-milestone never produces a stub SUMMARY. Anchor on the
  // comment that precedes that specific placeholder call rather than the
  // function's earlier writeBlockerPlaceholder use sites or its import.
  // Use lastIndexOf so we find the final retries-exhausted block in
  // recoverTimedOutUnit, not an earlier helper with the same comment.
  const exhaustedAnchor = "Retries exhausted — write a blocker placeholder";
  const exhaustedIdx = timeoutSrc.lastIndexOf(exhaustedAnchor);
  assert.ok(
    exhaustedIdx !== -1,
    "retries-exhausted blocker-placeholder path still exists for non-milestone units",
  );

  const guardIdx = timeoutSrc.lastIndexOf(
    'unitType === "complete-milestone"',
    exhaustedIdx,
  );
  assert.ok(
    guardIdx !== -1,
    "complete-milestone guard should appear above the retries-exhausted placeholder call",
  );

  const guardBlock = timeoutSrc.slice(guardIdx, exhaustedIdx);
  assert.ok(
    /return\s+"paused"\s*;/.test(guardBlock),
    "complete-milestone guard should return 'paused' before the placeholder call",
  );
  // The guard itself must not call writeBlockerPlaceholder.
  assert.ok(
    !guardBlock.includes("writeBlockerPlaceholder"),
    "complete-milestone guard must not write a blocker placeholder",
  );
});
