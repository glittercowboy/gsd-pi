/**
 * Bug #2807: Web roadmap derives milestone status from slice heuristics
 * instead of authoritative GSD milestone state.
 *
 * getMilestoneStatus() should prefer the authoritative `status` field on
 * WorkspaceMilestoneTarget (populated from the engine registry) rather
 * than inferring status from slice completion flags.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { getMilestoneStatus } from "../../../../../web/lib/workspace-status.ts";

// Inline type to avoid importing .tsx (not compiled to .js by test pipeline)
interface TestMilestone {
  id: string;
  title: string;
  roadmapPath?: string;
  status?: "complete" | "active" | "pending" | "parked";
  validationVerdict?: "pass" | "needs-attention" | "needs-remediation";
  slices: Array<{ id: string; title: string; done: boolean; tasks: Array<{ id: string; title: string; done: boolean }> }>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMilestone(overrides: Partial<TestMilestone> & { id: string }): TestMilestone {
  return {
    title: overrides.id,
    roadmapPath: undefined,
    slices: [],
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

test("getMilestoneStatus returns authoritative 'complete' even when slices are not all done", () => {
  const milestone = makeMilestone({
    id: "M001",
    status: "complete",
    slices: [
      { id: "S01", title: "Slice 1", done: true, tasks: [] },
      { id: "S02", title: "Slice 2", done: false, tasks: [] }, // not done
    ],
  });
  // Before the fix, this would return "in-progress" because not all slices are done.
  // After the fix, it should return "done" because authoritative status is "complete".
  assert.equal(getMilestoneStatus(milestone, {}), "done");
});

test("getMilestoneStatus returns authoritative 'active' regardless of slice state", () => {
  const milestone = makeMilestone({
    id: "M002",
    status: "active",
    slices: [
      { id: "S01", title: "Slice 1", done: true, tasks: [] },
      { id: "S02", title: "Slice 2", done: true, tasks: [] },
    ],
  });
  // Before the fix, this would return "done" because all slices are done.
  // After the fix, it should return "in-progress" because authoritative status is "active".
  assert.equal(getMilestoneStatus(milestone, {}), "in-progress");
});

test("getMilestoneStatus returns 'pending' for authoritative 'pending' even when some slices done", () => {
  const milestone = makeMilestone({
    id: "M003",
    status: "pending",
    slices: [
      { id: "S01", title: "Slice 1", done: true, tasks: [] },
      { id: "S02", title: "Slice 2", done: false, tasks: [] },
    ],
  });
  // Before the fix, this would return "in-progress" because some slices are done.
  // After the fix, it should return "pending".
  assert.equal(getMilestoneStatus(milestone, {}), "pending");
});

test("getMilestoneStatus preserves authoritative 'parked' item status", () => {
  const milestone = makeMilestone({
    id: "M004",
    status: "parked",
    slices: [
      { id: "S01", title: "Slice 1", done: true, tasks: [] },
    ],
  });
  // Parked milestones should retain a distinct parked status in the UI
  assert.equal(getMilestoneStatus(milestone, {}), "parked");
});

test("getMilestoneStatus falls back to heuristic when no authoritative status", () => {
  // Backward compatibility: milestones without the status field should
  // still work using the old slice-based heuristic.
  const milestone = makeMilestone({
    id: "M005",
    slices: [
      { id: "S01", title: "Slice 1", done: true, tasks: [] },
      { id: "S02", title: "Slice 2", done: true, tasks: [] },
    ],
  });
  assert.equal(getMilestoneStatus(milestone, {}), "done");
});

test("getMilestoneStatus exposes validationVerdict on milestone target", () => {
  const milestone = makeMilestone({
    id: "M006",
    status: "complete",
    validationVerdict: "needs-attention",
    slices: [
      { id: "S01", title: "Slice 1", done: true, tasks: [] },
    ],
  });
  // The milestone should have the validationVerdict field available
  assert.equal(milestone.validationVerdict, "needs-attention");
  // And status should still be "done"
  assert.equal(getMilestoneStatus(milestone, {}), "done");
});
