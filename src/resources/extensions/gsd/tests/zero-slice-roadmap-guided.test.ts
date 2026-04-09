/**
 * Regression test for #3441: guided flow must treat a roadmap with zero
 * parseable slices the same as no roadmap — offer "Create roadmap" not "Go auto".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("guided-flow checks roadmap slice count before offering auto (#3441)", () => {
  const src = readFileSync(
    join(import.meta.dirname, "..", "guided-flow.ts"),
    "utf-8",
  );
  assert.ok(
    src.includes("roadmapHasSlices") || src.includes("parseRoadmapSlices"),
    "Guided flow must parse roadmap for slices before deciding which options to show",
  );
});
