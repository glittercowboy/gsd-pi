import test from "node:test";
import assert from "node:assert/strict";
import type { SidecarItem } from "../auto/session.ts";
import {
  selectConflictFreeBatch,
  selectReactiveDispatchBatch,
  buildSidecarQueueNodes,
  scheduleSidecarQueue,
} from "../uok/execution-graph.ts";

test("uok execution graph selects deterministic conflict-free IDs", () => {
  const selected = selectConflictFreeBatch({
    orderedIds: ["S01", "S02", "S03", "S04"],
    maxParallel: 4,
    hasConflict: (candidate, existing) =>
      (candidate === "S02" && existing === "S01") ||
      (candidate === "S01" && existing === "S02"),
  });

  assert.deepEqual(selected, ["S01", "S03", "S04"]);
});

test("uok execution graph reactive batch honors file conflicts and in-flight writes", () => {
  const result = selectReactiveDispatchBatch({
    graph: [
      { id: "T01", dependsOn: [], outputFiles: ["src/a.ts"] },
      { id: "T02", dependsOn: [], outputFiles: ["src/a.ts"] },
      { id: "T03", dependsOn: [], outputFiles: ["src/b.ts"] },
      { id: "T04", dependsOn: ["T03"], outputFiles: ["src/c.ts"] },
    ],
    readyIds: ["T01", "T02", "T03", "T04"],
    maxParallel: 3,
    inFlightOutputs: new Set(["src/c.ts"]),
  });

  assert.deepEqual(result.selected, ["T01", "T03"]);
  assert.ok(
    result.conflicts.some((c) => c.nodeA === "T01" && c.nodeB === "T02" && c.file === "src/a.ts"),
    "conflict list should include overlapping outputs",
  );
});

test("uok execution graph sidecar nodes map queue kinds to supported DAG kinds", () => {
  const queue: SidecarItem[] = [
    { kind: "hook", unitType: "execute-task", unitId: "M001/S01/T01", prompt: "hook" },
    { kind: "triage", unitType: "triage", unitId: "M001/S01", prompt: "triage" },
    { kind: "quick-task", unitType: "quick-task", unitId: "M001/S01/Q01", prompt: "quick" },
  ];

  const nodes = buildSidecarQueueNodes(queue);
  assert.equal(nodes[0]?.kind, "hook");
  assert.equal(nodes[1]?.kind, "verification");
  assert.equal(nodes[2]?.kind, "team-worker");
  assert.equal(nodes[1]?.dependsOn.length, 1);
});

test("uok execution graph sidecar scheduler preserves deterministic queue order", async () => {
  const queue: SidecarItem[] = [
    { kind: "quick-task", unitType: "quick-task", unitId: "M001/S01/Q01", prompt: "q1" },
    { kind: "hook", unitType: "hook", unitId: "M001/S01/H01", prompt: "h1" },
    { kind: "triage", unitType: "triage", unitId: "M001/S01/TR1", prompt: "t1" },
  ];

  const scheduled = await scheduleSidecarQueue(queue);
  assert.deepEqual(
    scheduled.map((item) => item.unitId),
    queue.map((item) => item.unitId),
  );
});
