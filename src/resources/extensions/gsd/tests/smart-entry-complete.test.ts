import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { deriveState } = await import("../state.js");

test("deriveState reports the last completed milestone when all milestone slices are done", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-smart-entry-complete-"));

  try {
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(milestoneDir, { recursive: true });

    writeFileSync(
      join(milestoneDir, "M001-ROADMAP.md"),
      [
        "# M001: Complete Milestone",
        "",
        "## Slices",
        "- [x] **S01: Done slice** `risk:low` `depends:[]`",
        "  > Done.",
      ].join("\n"),
    );

    writeFileSync(
      join(milestoneDir, "M001-SUMMARY.md"),
      "# M001 Summary\n\nComplete.",
    );

    const state = await deriveState(base);
    assert.equal(state.phase, "complete");
    assert.equal(state.lastCompletedMilestone?.id, "M001");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("guided-flow complete branch offers a chooser for next milestone or status", () => {
  const guidedFlowSource = readFileSync(join(import.meta.dirname, "..", "guided-flow.ts"), "utf-8");
  const branchIdx = guidedFlowSource.indexOf('state.phase === "complete"');

  assert.ok(branchIdx > -1, "guided-flow.ts should have a complete-phase smart-entry branch");

  const nextBranchIdx = guidedFlowSource.indexOf('state.phase === "needs-discussion"', branchIdx);
  const branchChunk = guidedFlowSource.slice(branchIdx, nextBranchIdx === -1 ? branchIdx + 1600 : nextBranchIdx);

  assert.match(branchChunk, /showNextAction\(/, "complete branch should present a chooser");
  assert.match(branchChunk, /findMilestoneIds\(basePath\)/, "complete branch should compute the next milestone id");
  assert.match(branchChunk, /nextMilestoneId(?:Reserved)?\(milestoneIds, uniqueMilestoneIds\)/, "complete branch should derive the next milestone id");
  assert.match(branchChunk, /dispatchWorkflow\(pi, await prepareAndBuildDiscussPrompt\(/, "complete branch should dispatch the prepared discuss prompt");
});
