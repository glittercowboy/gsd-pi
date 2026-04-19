/**
 * dispatch-complete-milestone-guard.test.ts — #4324
 *
 * Verify that the completing-milestone dispatch rule has a defense-in-depth
 * DB status guard. When the DB marks a milestone as closed, the rule must
 * return skip instead of dispatching a redundant complete-milestone unit.
 * This prevents silent data loss when the legacy filesystem state-derivation
 * path produces a stale completing-milestone phase.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceFile = join(__dirname, "..", "auto-dispatch.ts");

describe("completing-milestone dispatch guard (#4324)", () => {
  const source = readFileSync(sourceFile, "utf-8");

  test("imports isClosedStatus from status-guards", () => {
    assert.match(source, /import\s*\{[^}]*isClosedStatus[^}]*\}\s*from\s*["']\.\/status-guards/);
  });

  test("checks DB milestone status before dispatching complete-milestone", () => {
    assert.match(source, /isClosedStatus\(milestone\.status\)/);
  });

  test("isClosedStatus guard appears in the completing-milestone rule", () => {
    // The completing-milestone phase check and the isClosedStatus guard
    // must both appear in the same rule, with the guard before dispatch.
    const phaseCheck = source.indexOf('phase !== "completing-milestone"');
    assert.ok(phaseCheck > -1, "completing-milestone phase check should exist");

    // Find the isClosedStatus guard after the phase check
    const guardIdx = source.indexOf("isClosedStatus(milestone.status)", phaseCheck);
    assert.ok(guardIdx > -1, "isClosedStatus guard should appear after the phase check");

    // Find the skip return after the guard
    const skipIdx = source.indexOf('action: "skip"', guardIdx);
    assert.ok(skipIdx > -1, "skip action should follow the isClosedStatus guard");

    // The skip should come before the dispatch in this rule
    const dispatchIdx = source.indexOf('unitType: "complete-milestone"', skipIdx);
    assert.ok(dispatchIdx > -1, "complete-milestone dispatch should exist after the skip guard");
  });

  test("imports updateMilestoneStatus for DB reconciliation", () => {
    assert.match(source, /import\s*\{[^}]*updateMilestoneStatus[^}]*\}\s*from\s*["']\.\/gsd-db/);
  });

  test("reconciles DB when SUMMARY exists on disk but DB is out of sync", () => {
    const phaseCheck = source.indexOf('phase !== "completing-milestone"');
    // The SUMMARY-exists reconciliation guard must appear in this rule
    const summaryGuard = source.indexOf('resolveMilestoneFile(basePath, mid, "SUMMARY")', phaseCheck);
    assert.ok(summaryGuard > -1, "SUMMARY file check should exist in the completing-milestone rule");

    const reconcileCall = source.indexOf('updateMilestoneStatus(mid, "complete"', summaryGuard);
    assert.ok(reconcileCall > -1, "updateMilestoneStatus reconciliation should follow the SUMMARY check");

    // Reconciliation must happen before the dispatch action
    const dispatchIdx = source.indexOf('unitType: "complete-milestone"', reconcileCall);
    assert.ok(dispatchIdx > -1, "reconciliation should appear before the dispatch action");
  });
});
