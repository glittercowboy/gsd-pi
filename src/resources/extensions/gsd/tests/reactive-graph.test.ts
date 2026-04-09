import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveTaskGraph,
  getReadyTasks,
  chooseNonConflictingSubset,
  isGraphAmbiguous,
  getMissingAnnotationTasks,
  detectDeadlock,
  graphMetrics,
} from "../reactive-graph.ts";
import { parseTaskPlanIO } from "../files.ts";
import type { TaskIO, DerivedTaskNode } from "../types.ts";

// ─── parseTaskPlanIO ──────────────────────────────────────────────────────

test("parseTaskPlanIO extracts backtick-wrapped file paths from Inputs and Expected Output", () => {
  const content = `---
estimated_steps: 3
estimated_files: 2
---

# T01: Setup Models

**Slice:** S01 — Core Setup
**Milestone:** M001

## Description

Create the core data models.

## Steps

1. Create types file
2. Create models file

## Must-Haves

- [ ] Type definitions complete

## Verification

- Run type checker

## Inputs

- \`src/types.ts\` — Existing type definitions from prior work
- \`src/config.json\` — Configuration schema

## Expected Output

- \`src/models.ts\` — New data model definitions
- \`src/models.test.ts\` — Unit tests for models
`;

  const io = parseTaskPlanIO(content);
  assert.deepEqual(io.inputFiles, ["src/types.ts", "src/config.json"]);
  assert.deepEqual(io.outputFiles, ["src/models.ts", "src/models.test.ts"]);
});

test("parseTaskPlanIO returns empty arrays for missing sections", () => {
  const content = `# T01: Something\n\n## Description\n\nNo IO sections here.\n`;
  const io = parseTaskPlanIO(content);
  assert.deepEqual(io.inputFiles, []);
  assert.deepEqual(io.outputFiles, []);
});

test("parseTaskPlanIO ignores non-file-path backtick tokens", () => {
  const content = `# T01: Test

## Inputs

- \`true\` — a boolean flag
- \`src/index.ts\` — main entry
- \`npm run test\` — a command, not a file

## Expected Output

- \`dist/bundle.js\` — compiled output
- \`false\` — not a file
`;

  const io = parseTaskPlanIO(content);
  assert.deepEqual(io.inputFiles, ["src/index.ts"]);
  assert.deepEqual(io.outputFiles, ["dist/bundle.js"]);
});

test("parseTaskPlanIO handles multiple backtick tokens on one line", () => {
  const content = `# T01: Multi

## Inputs

- \`src/a.ts\` and \`src/b.ts\` — both needed

## Expected Output

- \`src/c.ts\` — output
`;
  const io = parseTaskPlanIO(content);
  assert.deepEqual(io.inputFiles, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(io.outputFiles, ["src/c.ts"]);
});

test("parseTaskPlanIO strips inline descriptions from backtick-wrapped file references", () => {
  const content = `# T01: Described Paths

## Inputs

- \`src/config.ts — existing configuration\`
- \`src/flags.ts - feature flags\`

## Expected Output

- \`definitions/ac-audit.md — current state of AC CRM\`
- \`docs/runbook.md - update deployment notes\`
`;

  const io = parseTaskPlanIO(content);
  assert.deepEqual(io.inputFiles, ["src/config.ts", "src/flags.ts"]);
  assert.deepEqual(io.outputFiles, ["definitions/ac-audit.md", "docs/runbook.md"]);
});

// ─── deriveTaskGraph ──────────────────────────────────────────────────────

test("deriveTaskGraph: linear chain T01→T02→T03", () => {
  const tasks: TaskIO[] = [
    { id: "T01", title: "First", inputFiles: [], outputFiles: ["src/a.ts"], done: false },
    { id: "T02", title: "Second", inputFiles: ["src/a.ts"], outputFiles: ["src/b.ts"], done: false },
    { id: "T03", title: "Third", inputFiles: ["src/b.ts"], outputFiles: ["src/c.ts"], done: false },
  ];

  const graph = deriveTaskGraph(tasks);
  assert.deepEqual(graph[0].dependsOn, []);
  assert.deepEqual(graph[1].dependsOn, ["T01"]);
  assert.deepEqual(graph[2].dependsOn, ["T02"]);
});

test("deriveTaskGraph: diamond dependency", () => {
  const tasks: TaskIO[] = [
    { id: "T01", title: "Base", inputFiles: [], outputFiles: ["src/base.ts"], done: false },
    { id: "T02", title: "Left", inputFiles: ["src/base.ts"], outputFiles: ["src/left.ts"], done: false },
    { id: "T03", title: "Right", inputFiles: ["src/base.ts"], outputFiles: ["src/right.ts"], done: false },
    { id: "T04", title: "Merge", inputFiles: ["src/left.ts", "src/right.ts"], outputFiles: ["src/final.ts"], done: false },
  ];

  const graph = deriveTaskGraph(tasks);
  assert.deepEqual(graph[0].dependsOn, []);
  assert.deepEqual(graph[1].dependsOn, ["T01"]);
  assert.deepEqual(graph[2].dependsOn, ["T01"]);
  assert.deepEqual(graph[3].dependsOn, ["T02", "T03"]);
});

test("deriveTaskGraph: fully independent tasks", () => {
  const tasks: TaskIO[] = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: ["src/a.ts"], done: false },
    { id: "T02", title: "B", inputFiles: [], outputFiles: ["src/b.ts"], done: false },
    { id: "T03", title: "C", inputFiles: [], outputFiles: ["src/c.ts"], done: false },
  ];

  const graph = deriveTaskGraph(tasks);
  assert.deepEqual(graph[0].dependsOn, []);
  assert.deepEqual(graph[1].dependsOn, []);
  assert.deepEqual(graph[2].dependsOn, []);
});

test("deriveTaskGraph: self-referencing output→input is excluded", () => {
  const tasks: TaskIO[] = [
    { id: "T01", title: "Self", inputFiles: ["src/a.ts"], outputFiles: ["src/a.ts"], done: false },
  ];

  const graph = deriveTaskGraph(tasks);
  assert.deepEqual(graph[0].dependsOn, []);
});

// ─── getReadyTasks ────────────────────────────────────────────────────────

test("getReadyTasks: partially completed graph", () => {
  const tasks: TaskIO[] = [
    { id: "T01", title: "Base", inputFiles: [], outputFiles: ["src/a.ts"], done: true },
    { id: "T02", title: "Dep", inputFiles: ["src/a.ts"], outputFiles: ["src/b.ts"], done: false },
    { id: "T03", title: "Blocked", inputFiles: ["src/b.ts"], outputFiles: ["src/c.ts"], done: false },
  ];
  const graph = deriveTaskGraph(tasks);
  const ready = getReadyTasks(graph, new Set(["T01"]), new Set());
  assert.deepEqual(ready, ["T02"]);
});

test("getReadyTasks: nothing complete → only root tasks ready", () => {
  const tasks: TaskIO[] = [
    { id: "T01", title: "Root", inputFiles: [], outputFiles: ["src/a.ts"], done: false },
    { id: "T02", title: "Dep", inputFiles: ["src/a.ts"], outputFiles: ["src/b.ts"], done: false },
  ];
  const graph = deriveTaskGraph(tasks);
  const ready = getReadyTasks(graph, new Set(), new Set());
  assert.deepEqual(ready, ["T01"]);
});

test("getReadyTasks: all complete → empty", () => {
  const tasks: TaskIO[] = [
    { id: "T01", title: "Done", inputFiles: [], outputFiles: ["src/a.ts"], done: true },
  ];
  const graph = deriveTaskGraph(tasks);
  const ready = getReadyTasks(graph, new Set(["T01"]), new Set());
  assert.deepEqual(ready, []);
});

test("getReadyTasks: in-flight tasks excluded", () => {
  const tasks: TaskIO[] = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: ["src/a.ts"], done: false },
    { id: "T02", title: "B", inputFiles: [], outputFiles: ["src/b.ts"], done: false },
  ];
  const graph = deriveTaskGraph(tasks);
  const ready = getReadyTasks(graph, new Set(), new Set(["T01"]));
  assert.deepEqual(ready, ["T02"]);
});

// ─── chooseNonConflictingSubset ───────────────────────────────────────────

test("chooseNonConflictingSubset: output conflicts", () => {
  const tasks: TaskIO[] = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: ["src/shared.ts"], done: false },
    { id: "T02", title: "B", inputFiles: [], outputFiles: ["src/shared.ts"], done: false },
    { id: "T03", title: "C", inputFiles: [], outputFiles: ["src/other.ts"], done: false },
  ];
  const graph = deriveTaskGraph(tasks);
  const selected = chooseNonConflictingSubset(["T01", "T02", "T03"], graph, 3, new Set());
  // T01 claims shared.ts, T02 conflicts, T03 is fine
  assert.deepEqual(selected, ["T01", "T03"]);
});

test("chooseNonConflictingSubset: respects maxParallel", () => {
  const tasks: TaskIO[] = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: ["src/a.ts"], done: false },
    { id: "T02", title: "B", inputFiles: [], outputFiles: ["src/b.ts"], done: false },
    { id: "T03", title: "C", inputFiles: [], outputFiles: ["src/c.ts"], done: false },
  ];
  const graph = deriveTaskGraph(tasks);
  const selected = chooseNonConflictingSubset(["T01", "T02", "T03"], graph, 2, new Set());
  assert.deepEqual(selected, ["T01", "T02"]);
});

test("chooseNonConflictingSubset: respects inFlightOutputs", () => {
  const tasks: TaskIO[] = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: ["src/a.ts"], done: false },
    { id: "T02", title: "B", inputFiles: [], outputFiles: ["src/b.ts"], done: false },
  ];
  const graph = deriveTaskGraph(tasks);
  const selected = chooseNonConflictingSubset(["T01", "T02"], graph, 4, new Set(["src/a.ts"]));
  assert.deepEqual(selected, ["T02"]);
});

// ─── isGraphAmbiguous ─────────────────────────────────────────────────────

test("isGraphAmbiguous: task with no IO → ambiguous", () => {
  const graph: DerivedTaskNode[] = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: [], done: false, dependsOn: [] },
    { id: "T02", title: "B", inputFiles: ["src/a.ts"], outputFiles: ["src/b.ts"], done: false, dependsOn: [] },
  ];
  assert.equal(isGraphAmbiguous(graph), true);
});

test("isGraphAmbiguous: all tasks have IO → not ambiguous", () => {
  const graph: DerivedTaskNode[] = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: ["src/a.ts"], done: false, dependsOn: [] },
    { id: "T02", title: "B", inputFiles: ["src/a.ts"], outputFiles: ["src/b.ts"], done: false, dependsOn: ["T01"] },
  ];
  assert.equal(isGraphAmbiguous(graph), false);
});

test("isGraphAmbiguous: done tasks with no IO are ignored", () => {
  const graph: DerivedTaskNode[] = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: [], done: true, dependsOn: [] },
    { id: "T02", title: "B", inputFiles: [], outputFiles: ["src/b.ts"], done: false, dependsOn: [] },
  ];
  assert.equal(isGraphAmbiguous(graph), false);
});

// ─── detectDeadlock ───────────────────────────────────────────────────────

test("detectDeadlock: circular dependency detected", () => {
  // T01 depends on T02, T02 depends on T01 — deadlock
  const graph: DerivedTaskNode[] = [
    { id: "T01", title: "A", inputFiles: ["src/b.ts"], outputFiles: ["src/a.ts"], done: false, dependsOn: ["T02"] },
    { id: "T02", title: "B", inputFiles: ["src/a.ts"], outputFiles: ["src/b.ts"], done: false, dependsOn: ["T01"] },
  ];
  assert.equal(detectDeadlock(graph, new Set(), new Set()), true);
});

test("detectDeadlock: normal blocked-waiting-for-in-flight → not deadlock", () => {
  const graph: DerivedTaskNode[] = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: ["src/a.ts"], done: false, dependsOn: [] },
    { id: "T02", title: "B", inputFiles: ["src/a.ts"], outputFiles: ["src/b.ts"], done: false, dependsOn: ["T01"] },
  ];
  // T01 is in-flight, T02 is waiting → not deadlock
  assert.equal(detectDeadlock(graph, new Set(), new Set(["T01"])), false);
});

test("detectDeadlock: all complete → not deadlock", () => {
  const graph: DerivedTaskNode[] = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: ["src/a.ts"], done: true, dependsOn: [] },
  ];
  assert.equal(detectDeadlock(graph, new Set(["T01"]), new Set()), false);
});

// ─── graphMetrics ─────────────────────────────────────────────────────────

test("graphMetrics computes correct values", () => {
  const tasks: TaskIO[] = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: ["src/a.ts"], done: true },
    { id: "T02", title: "B", inputFiles: ["src/a.ts"], outputFiles: ["src/b.ts"], done: false },
    { id: "T03", title: "C", inputFiles: [], outputFiles: ["src/c.ts"], done: false },
  ];
  const graph = deriveTaskGraph(tasks);
  const metrics = graphMetrics(graph);
  assert.equal(metrics.taskCount, 3);
  assert.equal(metrics.edgeCount, 1); // T02 depends on T01
  assert.equal(metrics.readySetSize, 2); // T02 (T01 done) and T03 (no deps)
  assert.equal(metrics.ambiguous, false);
});

// ─── getMissingAnnotationTasks ─────────────────────────────────────────────

test("getMissingAnnotationTasks: returns empty array when all tasks have annotations", () => {
  const graph: DerivedTaskNode[] = [
    { id: "T01", title: "A", inputFiles: ["src/a.ts"], outputFiles: ["src/b.ts"], done: false, dependsOn: [] },
    { id: "T02", title: "B", inputFiles: [], outputFiles: ["src/c.ts"], done: false, dependsOn: [] },
  ];
  assert.deepEqual(getMissingAnnotationTasks(graph), []);
});

test("getMissingAnnotationTasks: returns tasks with missing annotations", () => {
  const graph: DerivedTaskNode[] = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: [], done: false, dependsOn: [] },
    { id: "T02", title: "B", inputFiles: ["src/a.ts"], outputFiles: ["src/b.ts"], done: false, dependsOn: [] },
    { id: "T03", title: "C", inputFiles: [], outputFiles: [], done: false, dependsOn: [] },
  ];
  assert.deepEqual(getMissingAnnotationTasks(graph), [
    { id: "T01", title: "A" },
    { id: "T03", title: "C" },
  ]);
});

test("getMissingAnnotationTasks: skips done tasks", () => {
  const graph: DerivedTaskNode[] = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: [], done: true, dependsOn: [] },
    { id: "T02", title: "B", inputFiles: [], outputFiles: [], done: false, dependsOn: [] },
  ];
  assert.deepEqual(getMissingAnnotationTasks(graph), [
    { id: "T02", title: "B" },
  ]);
});

test("getMissingAnnotationTasks: returns only tasks missing BOTH inputFiles and outputFiles", () => {
  const graph: DerivedTaskNode[] = [
    { id: "T01", title: "InputOnly", inputFiles: ["src/a.ts"], outputFiles: [], done: false, dependsOn: [] },
    { id: "T02", title: "OutputOnly", inputFiles: [], outputFiles: ["src/b.ts"], done: false, dependsOn: [] },
    { id: "T03", title: "Neither", inputFiles: [], outputFiles: [], done: false, dependsOn: [] },
    { id: "T04", title: "Both", inputFiles: ["src/c.ts"], outputFiles: ["src/d.ts"], done: false, dependsOn: [] },
  ];
  assert.deepEqual(getMissingAnnotationTasks(graph), [
    { id: "T03", title: "Neither" },
  ]);
});
