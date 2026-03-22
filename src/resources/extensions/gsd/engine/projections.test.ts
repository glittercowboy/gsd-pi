// GSD Extension — Projection Renderer Tests
// Tests for PLAN, ROADMAP, SUMMARY, STATE markdown renderers
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  renderPlanContent,
  renderRoadmapContent,
} from "../workflow-projections.js";

import type { SliceRow, TaskRow, MilestoneRow } from "../workflow-engine.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeSliceRow(overrides: Partial<SliceRow> = {}): SliceRow {
  return {
    id: "S01",
    milestone_id: "M001",
    title: "Foundation Slice",
    status: "active",
    risk: "low",
    depends_on: "[]",
    summary: "Build the foundation",
    uat_result: null,
    created_at: "2026-03-22T00:00:00Z",
    completed_at: null,
    seq: 1,
    ...overrides,
  };
}

function makeTaskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "T01",
    slice_id: "S01",
    milestone_id: "M001",
    title: "First Task",
    description: "Do the first thing",
    status: "pending",
    estimate: "30m",
    summary: null,
    files: '["file1.ts","file2.ts"]',
    verify: "npm test",
    started_at: null,
    completed_at: null,
    blocker: null,
    seq: 1,
    ...overrides,
  };
}

function makeMilestoneRow(overrides: Partial<MilestoneRow> = {}): MilestoneRow {
  return {
    id: "M001",
    title: "Engine Foundation",
    status: "active",
    created_at: "2026-03-22T00:00:00Z",
    completed_at: null,
    ...overrides,
  };
}

// ─── renderPlanContent Tests ──────────────────────────────────────────────

describe("renderPlanContent", () => {
  it("produces [x] for done tasks and [ ] for pending tasks", () => {
    const slice = makeSliceRow();
    const tasks = [
      makeTaskRow({ id: "T01", status: "done", seq: 1 }),
      makeTaskRow({ id: "T02", status: "done", title: "Second Task", seq: 2 }),
      makeTaskRow({ id: "T03", status: "pending", title: "Third Task", seq: 3 }),
    ];
    const md = renderPlanContent(slice, tasks);
    assert.ok(md.includes("- [x] **T01:**"), "T01 should be checked");
    assert.ok(md.includes("- [x] **T02:**"), "T02 should be checked");
    assert.ok(md.includes("- [ ] **T03:**"), "T03 should be unchecked");
  });

  it("includes Estimate, Files, and Verify sublines when present", () => {
    const slice = makeSliceRow();
    const tasks = [
      makeTaskRow({
        id: "T01",
        estimate: "30m",
        files: '["file1.ts","file2.ts"]',
        verify: "npm test",
      }),
    ];
    const md = renderPlanContent(slice, tasks);
    assert.ok(md.includes("  - Estimate: 30m"), "should include estimate");
    assert.ok(md.includes("  - Files: file1.ts, file2.ts"), "should include files");
    assert.ok(md.includes("  - Verify: npm test"), "should include verify");
  });

  it("omits Files subline when files is empty array", () => {
    const slice = makeSliceRow();
    const tasks = [
      makeTaskRow({ id: "T01", files: "[]", verify: null }),
    ];
    const md = renderPlanContent(slice, tasks);
    assert.ok(!md.includes("  - Files:"), "should not include Files line");
    assert.ok(!md.includes("  - Verify:"), "should not include Verify line");
  });
});

// ─── renderRoadmapContent Tests ───────────────────────────────────────────

describe("renderRoadmapContent", () => {
  it("produces table with checkmark for done and empty square for pending", () => {
    const milestone = makeMilestoneRow();
    const slices = [
      makeSliceRow({ id: "S01", status: "done", seq: 1 }),
      makeSliceRow({ id: "S02", title: "Second Slice", status: "active", seq: 2 }),
    ];
    const md = renderRoadmapContent(milestone, slices);
    // Find the S01 row - should have checkmark
    const lines = md.split("\n");
    const s01Line = lines.find((l) => l.includes("| S01 |"));
    const s02Line = lines.find((l) => l.includes("| S02 |"));
    assert.ok(s01Line, "S01 row should exist");
    assert.ok(s02Line, "S02 row should exist");
    assert.ok(s01Line!.includes("\u2705"), "S01 should have checkmark");
    assert.ok(s02Line!.includes("\u2B1C"), "S02 should have empty square");
  });

  it("includes depends column with slice IDs when depends_on has values", () => {
    const milestone = makeMilestoneRow();
    const slices = [
      makeSliceRow({ id: "S01", depends_on: "[]", seq: 1 }),
      makeSliceRow({ id: "S02", depends_on: '["S01"]', seq: 2 }),
    ];
    const md = renderRoadmapContent(milestone, slices);
    const lines = md.split("\n");
    const s02Line = lines.find((l) => l.includes("| S02 |"));
    assert.ok(s02Line, "S02 row should exist");
    assert.ok(s02Line!.includes("S01"), "S02 should show S01 dependency");
  });

  it('shows dash for depends when empty', () => {
    const milestone = makeMilestoneRow();
    const slices = [
      makeSliceRow({ id: "S01", depends_on: "[]", seq: 1 }),
    ];
    const md = renderRoadmapContent(milestone, slices);
    const lines = md.split("\n");
    const s01Line = lines.find((l) => l.includes("| S01 |"));
    assert.ok(s01Line, "S01 row should exist");
    assert.ok(s01Line!.includes("\u2014"), "S01 should show em dash for empty depends");
  });
});
