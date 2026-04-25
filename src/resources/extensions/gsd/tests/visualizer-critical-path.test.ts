// Tests for critical path algorithm.
// Tests computeCriticalPath with known DAG structures.

import { computeCriticalPath } from "../visualizer-data.js";
import type { VisualizerMilestone } from "../visualizer-data.js";
import { test } from "node:test";
import assert from "node:assert/strict";

function makeMs(id: string, status: "complete" | "active" | "pending", dependsOn: string[], slices: any[] = []): VisualizerMilestone {
  return { id, title: id, status, dependsOn, slices };
}

function makeSlice(id: string, done: boolean, depends: string[] = []) {
  return { id, title: id, done, active: false, risk: "low", depends, tasks: [] };
}

test("critical path: linear chain M001 → M002 → M003", () => {
  const milestones = [
    makeMs("M001", "complete", []),
    makeMs("M002", "active", ["M001"], [
      makeSlice("S01", true),
      makeSlice("S02", false, ["S01"]),
    ]),
    makeMs("M003", "pending", ["M002"]),
  ];

  const cp = computeCriticalPath(milestones);
  assert.ok(cp.milestonePath.length > 0, "linear chain has critical path");
  assert.ok(cp.milestonePath.includes("M002"), "M002 is on critical path");
  assert.ok(cp.milestonePath.includes("M003"), "M003 is on critical path");
  assert.equal(cp.milestoneSlack.get("M002"), 0, "M002 has zero slack");
  assert.equal(cp.milestoneSlack.get("M003"), 0, "M003 has zero slack");
});

test("critical path: diamond DAG picks heavier branch", () => {
  // M001 -> M002 -> M004
  // M001 -> M003 -> M004
  // M002 has 3 incomplete slices, M003 has 1 incomplete slice
  const milestones = [
    makeMs("M001", "complete", []),
    makeMs("M002", "active", ["M001"], [
      makeSlice("S01", false),
      makeSlice("S02", false),
      makeSlice("S03", false),
    ]),
    makeMs("M003", "pending", ["M001"], [
      makeSlice("S01", false),
    ]),
    makeMs("M004", "pending", ["M002", "M003"]),
  ];

  const cp = computeCriticalPath(milestones);
  assert.ok(cp.milestonePath.length >= 2, "diamond DAG has critical path");
  assert.ok(cp.milestonePath.includes("M002"), "M002 (heavier) is on critical path");

  const m003Slack = cp.milestoneSlack.get("M003") ?? -1;
  assert.ok(m003Slack > 0, "M003 has positive slack (lighter branch)");
});

test("critical path: independent branches selects longest", () => {
  const milestones = [
    makeMs("M001", "active", [], [makeSlice("S01", false)]),
    makeMs("M002", "pending", [], [makeSlice("S01", false), makeSlice("S02", false)]),
    makeMs("M003", "pending", [], [makeSlice("S01", false)]),
  ];

  const cp = computeCriticalPath(milestones);
  assert.ok(cp.milestonePath.length >= 1, "independent branches have at least one critical node");
  assert.ok(cp.milestonePath.includes("M002"), "M002 (longest) is on critical path");
});

test("critical path: slice-level path within an active milestone", () => {
  // Active milestone with slice dependencies: S01 -> S02 -> S04, S01 -> S03
  const milestones = [
    makeMs("M001", "active", [], [
      makeSlice("S01", true),
      makeSlice("S02", false, ["S01"]),
      makeSlice("S03", false, ["S01"]),
      makeSlice("S04", false, ["S02"]),
    ]),
  ];

  const cp = computeCriticalPath(milestones);
  assert.ok(cp.slicePath.length > 0, "has slice-level critical path");
  assert.ok(cp.slicePath.includes("S02"), "S02 is on slice critical path");
  assert.ok(cp.slicePath.includes("S04"), "S04 is on slice critical path");

  const s03Slack = cp.sliceSlack.get("S03") ?? -1;
  assert.ok(s03Slack > 0, "S03 has positive slack (shorter branch)");
});

test("critical path: empty milestones produce empty paths", () => {
  const cp = computeCriticalPath([]);
  assert.equal(cp.milestonePath.length, 0, "empty milestones produce empty path");
  assert.equal(cp.slicePath.length, 0, "empty milestones produce empty slice path");
});

test("critical path: single milestone is its own critical path", () => {
  const milestones = [
    makeMs("M001", "active", [], [
      makeSlice("S01", false),
      makeSlice("S02", false),
    ]),
  ];

  const cp = computeCriticalPath(milestones);
  assert.equal(cp.milestonePath.length, 1, "single milestone is its own critical path");
  assert.equal(cp.milestonePath[0], "M001", "M001 is the critical node");
});
