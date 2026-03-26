import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AutoSession } from "../auto/session.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("double mergeAndExit guard (#2645)", () => {
  test("phases.ts sets milestoneMergedInPhases after mergeAndExit in milestone-complete path", () => {
    // Source audit: the "complete" phase path must set the guard flag
    // after calling mergeAndExit so that stopAuto skips the second merge.
    const phasesSrc = readFileSync(
      join(__dirname, "..", "auto", "phases.ts"),
      "utf-8",
    );

    // Find the "complete" phase block
    const completeIdx = phasesSrc.indexOf('state.phase === "complete"');
    assert.ok(completeIdx > 0, "phases.ts should have a 'complete' phase check");

    const afterComplete = phasesSrc.slice(completeIdx, completeIdx + 600);
    const mergeIdx = afterComplete.indexOf("deps.resolver.mergeAndExit");
    const flagIdx = afterComplete.indexOf("s.milestoneMergedInPhases = true");

    assert.ok(mergeIdx > 0, "complete path should call mergeAndExit");
    assert.ok(flagIdx > 0, "complete path should set milestoneMergedInPhases");
    assert.ok(
      flagIdx > mergeIdx,
      "milestoneMergedInPhases must be set AFTER mergeAndExit (not before)",
    );
  });

  test("phases.ts sets milestoneMergedInPhases after mergeAndExit in all-milestones-complete path", () => {
    const phasesSrc = readFileSync(
      join(__dirname, "..", "auto", "phases.ts"),
      "utf-8",
    );

    // The "all milestones complete" block checks incomplete.length === 0
    const allCompleteIdx = phasesSrc.indexOf("incomplete.length === 0");
    assert.ok(allCompleteIdx > 0, "phases.ts should have an all-milestones-complete check");

    const afterAllComplete = phasesSrc.slice(allCompleteIdx, allCompleteIdx + 600);
    const mergeIdx = afterAllComplete.indexOf("deps.resolver.mergeAndExit");
    const flagIdx = afterAllComplete.indexOf("s.milestoneMergedInPhases = true");

    assert.ok(mergeIdx > 0, "all-complete path should call mergeAndExit");
    assert.ok(flagIdx > 0, "all-complete path should set milestoneMergedInPhases");
    assert.ok(
      flagIdx > mergeIdx,
      "milestoneMergedInPhases must be set AFTER mergeAndExit (not before)",
    );
  });

  test("stopAuto checks milestoneMergedInPhases before calling mergeAndExit", () => {
    const autoSrc = readFileSync(
      join(__dirname, "..", "auto.ts"),
      "utf-8",
    );

    // The Step 4 worktree exit block must check the guard flag
    const step4Idx = autoSrc.indexOf("Step 4: Auto-worktree exit");
    assert.ok(step4Idx > 0, "auto.ts should have Step 4 worktree exit");

    const step4Block = autoSrc.slice(step4Idx, step4Idx + 600);
    assert.ok(
      step4Block.includes("milestoneMergedInPhases"),
      "stopAuto Step 4 must check milestoneMergedInPhases before merging",
    );
    assert.ok(
      step4Block.includes("!s.milestoneMergedInPhases"),
      "stopAuto should skip merge when milestoneMergedInPhases is true",
    );
  });

  test("AutoSession.milestoneMergedInPhases defaults to false", () => {
    const session = new AutoSession();
    assert.equal(
      session.milestoneMergedInPhases,
      false,
      "new session should have milestoneMergedInPhases = false",
    );
  });

  test("AutoSession.reset() clears milestoneMergedInPhases", () => {
    const session = new AutoSession();
    session.milestoneMergedInPhases = true;
    session.reset();
    assert.equal(
      session.milestoneMergedInPhases,
      false,
      "reset() should clear milestoneMergedInPhases back to false",
    );
  });
});
