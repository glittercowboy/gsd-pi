// GSD Extension — Projection Renderer Tests
// Tests for PLAN, ROADMAP, SUMMARY, STATE markdown renderers
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  renderPlanContent,
  renderRoadmapContent,
  renderSummaryContent,
  renderStateContent,
} from "../workflow-projections.ts";

import type { SliceRow, TaskRow, MilestoneRow } from "../workflow-engine.ts";
import type { GSDState, MilestoneRegistryEntry } from "../types.ts";

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

// ─── renderSummaryContent Tests ───────────────────────────────────────────

describe("renderSummaryContent", () => {
  it("produces frontmatter with id, parent, milestone fields", () => {
    const task = makeTaskRow({
      id: "T01",
      slice_id: "S01",
      milestone_id: "M001",
      title: "First Task",
      completed_at: "2026-03-22T12:00:00Z",
    });
    const md = renderSummaryContent(task, "S01", "M001");
    assert.ok(md.includes("id: T01"), "should have id field");
    assert.ok(md.includes("parent: S01"), "should have parent field");
    assert.ok(md.includes("milestone: M001"), "should have milestone field");
    assert.ok(md.startsWith("---"), "should start with frontmatter delimiter");
  });

  it('includes "## What Happened" section with summary text', () => {
    const task = makeTaskRow({
      id: "T01",
      summary: "Implemented the core feature with full test coverage.",
      completed_at: "2026-03-22T12:00:00Z",
    });
    const md = renderSummaryContent(task, "S01", "M001");
    assert.ok(md.includes("## What Happened"), "should have What Happened section");
    assert.ok(
      md.includes("Implemented the core feature with full test coverage."),
      "should include summary text",
    );
  });

  it('shows "No summary recorded." when summary is null', () => {
    const task = makeTaskRow({ id: "T01", summary: null });
    const md = renderSummaryContent(task, "S01", "M001");
    assert.ok(md.includes("No summary recorded."), "should show default summary");
  });
});

// ─── renderStateContent Tests ─────────────────────────────────────────────

function makeGSDState(overrides: Partial<GSDState> = {}): GSDState {
  return {
    activeMilestone: { id: "M001", title: "Engine Foundation" },
    activeSlice: { id: "S01", title: "Foundation Slice" },
    activeTask: { id: "T01", title: "First Task" },
    phase: "executing",
    recentDecisions: ["D-01: Use SQLite"],
    blockers: [],
    nextAction: "Execute task T01: First Task",
    registry: [
      { id: "M001", title: "Engine Foundation", status: "active" },
    ],
    progress: {
      milestones: { done: 0, total: 1 },
      slices: { done: 0, total: 3 },
      tasks: { done: 1, total: 5 },
    },
    ...overrides,
  };
}

describe("renderStateContent", () => {
  it("produces STATE.md format with active milestone and slice", () => {
    const state = makeGSDState();
    const md = renderStateContent(state);
    assert.ok(md.includes("# GSD State"), "should have title");
    assert.ok(md.includes("**Active Milestone:** M001: Engine Foundation"), "should have active milestone");
    assert.ok(md.includes("**Active Slice:** S01: Foundation Slice"), "should have active slice");
    assert.ok(md.includes("**Phase:** executing"), "should have phase");
    assert.ok(md.includes("## Milestone Registry"), "should have registry section");
  });

  it('produces "None" for active milestone/slice when empty DB', () => {
    const state = makeGSDState({
      activeMilestone: null,
      activeSlice: null,
      activeTask: null,
      phase: "pre-planning",
      recentDecisions: [],
      blockers: [],
      nextAction: "None",
      registry: [],
    });
    const md = renderStateContent(state);
    assert.ok(md.includes("**Active Milestone:** None"), "should show None for milestone");
    assert.ok(md.includes("**Active Slice:** None"), "should show None for slice");
    assert.ok(md.includes("- None recorded"), "should show no decisions");
    assert.ok(md.includes("- None"), "should show no blockers");
  });

  it("includes milestone registry with correct status glyphs", () => {
    const state = makeGSDState({
      registry: [
        { id: "M001", title: "Active Milestone", status: "active" },
        { id: "M002", title: "Done Milestone", status: "complete" },
        { id: "M003", title: "Pending Milestone", status: "pending" },
        { id: "M004", title: "Parked Milestone", status: "parked" },
      ],
    });
    const md = renderStateContent(state);
    assert.ok(md.includes("\uD83D\uDD04 **M001:**"), "active should have refresh glyph");
    assert.ok(md.includes("\u2705 **M002:**"), "complete should have checkmark");
    assert.ok(md.includes("\u2B1C **M003:**"), "pending should have empty square");
    assert.ok(md.includes("\u23F8\uFE0F **M004:**"), "parked should have pause glyph");
  });
});
