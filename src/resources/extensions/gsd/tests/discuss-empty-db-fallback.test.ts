/**
 * discuss-empty-db-fallback.test.ts — Tests for #2892.
 *
 * When the DB is open but empty (e.g., after crash/truncation),
 * getMilestoneSlices() returns [] and showDiscuss() incorrectly declares
 * "All slices are complete." The fix adds a roadmap fallback: when the DB
 * returns zero slices but a ROADMAP file exists, parse slices from the
 * roadmap instead of treating zero slices as "all complete."
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseRoadmapSlices } from "../roadmap-slices.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readGuidedFlowSource(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = dirname(thisFile);
  return readFileSync(join(thisDir, "..", "guided-flow.ts"), "utf-8");
}

const SAMPLE_ROADMAP = `# M012 Roadmap

## Slices
- [ ] **S01: Core setup** \`risk:low\` \`depends:[]\`
  > After this: basic project scaffolding works
- [ ] **S02: Auth module** \`risk:medium\` \`depends:[S01]\`
  > After this: users can log in
- [ ] **S03: Dashboard** \`risk:low\` \`depends:[S02]\`
  > After this: dashboard renders
`;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("discuss-empty-db-fallback (#2892)", () => {

  test("1. parseRoadmapSlices extracts slices from a valid ROADMAP", () => {
    const slices = parseRoadmapSlices(SAMPLE_ROADMAP);
    assert.strictEqual(slices.length, 3, "should parse 3 slices from sample roadmap");
    assert.strictEqual(slices[0]!.id, "S01");
    assert.strictEqual(slices[1]!.id, "S02");
    assert.strictEqual(slices[2]!.id, "S03");
    // All slices are incomplete ([ ] not [x])
    assert.ok(slices.every(s => !s.done), "all slices should be incomplete");
  });

  test("2. guided-flow imports parseRoadmapSlices for roadmap fallback", () => {
    const source = readGuidedFlowSource();
    assert.ok(
      source.includes("parseRoadmapSlices"),
      "guided-flow must import parseRoadmapSlices to support roadmap fallback when DB is empty",
    );
  });

  test("3. guided-flow has roadmap fallback when normSlices is empty but roadmapContent exists", () => {
    const source = readGuidedFlowSource();
    // The fix must add a fallback that checks normSlices.length === 0 && roadmapContent
    // and repopulates normSlices from the roadmap before the pendingSlices guard.
    //
    // Pattern: after DB query produces normSlices, if empty + roadmap exists,
    // fall back to parseRoadmapSlices(roadmapContent).
    const fallbackPattern = /normSlices\.length\s*===\s*0\s*&&\s*roadmapContent/;
    assert.ok(
      fallbackPattern.test(source),
      "guided-flow must check normSlices.length === 0 && roadmapContent to trigger roadmap fallback",
    );
  });

  test("4. guided-flow no longer has unguarded pendingSlices === 0 exit after DB-only query", () => {
    const source = readGuidedFlowSource();
    // Extract the showDiscuss function body
    const fnMatch = source.match(
      /async function showDiscuss\s*\([^)]*\)[^{]*\{([\s\S]*?)\nfunction\s/,
    );
    assert.ok(!!fnMatch, "showDiscuss function body must be found");

    if (fnMatch) {
      const body = fnMatch[1]!;
      // After the DB query block (isDbAvailable/getMilestoneSlices), there should
      // be a roadmap fallback BEFORE the pendingSlices.length === 0 check.
      // Find the getMilestoneSlices call and the pendingSlices === 0 check
      const dbQueryIdx = body.indexOf("getMilestoneSlices");
      const fallbackIdx = body.indexOf("parseRoadmapSlices");
      const pendingGuardIdx = body.indexOf('pendingSlices.length === 0');

      assert.ok(dbQueryIdx > 0, "getMilestoneSlices call must exist");
      assert.ok(fallbackIdx > 0, "parseRoadmapSlices fallback must exist");
      assert.ok(pendingGuardIdx > 0, "pendingSlices.length === 0 guard must exist");
      assert.ok(
        fallbackIdx > dbQueryIdx && fallbackIdx < pendingGuardIdx,
        "parseRoadmapSlices fallback must appear BETWEEN DB query and pendingSlices === 0 guard",
      );
    }
  });

  test("5. roadmap-parsed slices map to NormSlice format with done=false by default", () => {
    // When falling back to roadmap, incomplete slices ([ ]) should map to done:false,
    // ensuring they appear as pending and are NOT falsely reported as complete.
    const slices = parseRoadmapSlices(SAMPLE_ROADMAP);
    const normSlices = slices.map(s => ({ id: s.id, done: s.done, title: s.title }));
    const pendingSlices = normSlices.filter(s => !s.done);
    assert.strictEqual(pendingSlices.length, 3,
      "all 3 incomplete roadmap slices should be pending — not falsely treated as complete");
  });

  test("6. roadmap with completed slices correctly reports them as done", () => {
    const completedRoadmap = `# M012 Roadmap

## Slices
- [x] **S01: Core setup** \`risk:low\` \`depends:[]\`
  > After this: basic project scaffolding works
- [ ] **S02: Auth module** \`risk:medium\` \`depends:[S01]\`
  > After this: users can log in
- [x] **S03: Dashboard** \`risk:low\` \`depends:[S02]\`
  > After this: dashboard renders
`;
    const slices = parseRoadmapSlices(completedRoadmap);
    const normSlices = slices.map(s => ({ id: s.id, done: s.done, title: s.title }));
    const pendingSlices = normSlices.filter(s => !s.done);
    assert.strictEqual(pendingSlices.length, 1, "only S02 should be pending");
    assert.strictEqual(pendingSlices[0]!.id, "S02");
  });
});
