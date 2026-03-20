/**
 * Unit tests for expandIteration() and related graph.ts iteration support.
 *
 * Covers instance creation, deterministic ID generation, parent status
 * marking, downstream dependency rewriting, prompt template expansion,
 * getNextPendingStep interaction, YAML roundtrip, and error cases.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readGraph,
  writeGraph,
  getNextPendingStep,
  expandIteration,
} from "../graph.ts";
import type { WorkflowGraph, GraphStep } from "../graph.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "gsd-iter-test-"));
}

/** A 3-step graph: outline → draft-chapters (iterate candidate) → review */
function makeIterateGraph(): WorkflowGraph {
  return {
    steps: [
      {
        id: "outline",
        title: "Create outline",
        status: "complete",
        prompt: "Write an outline",
        dependsOn: [],
      },
      {
        id: "draft-chapters",
        title: "Draft chapters",
        status: "pending",
        prompt: "Draft {{item}}",
        dependsOn: ["outline"],
      },
      {
        id: "review",
        title: "Review all",
        status: "pending",
        prompt: "Review the book",
        dependsOn: ["draft-chapters"],
      },
    ],
    metadata: {
      name: "iterate-test",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

// ─── expandIteration tests ───────────────────────────────────────────────

test("expandIteration creates correct number of instances", () => {
  const graph = makeIterateGraph();
  const items = ["Chapter 1", "Chapter 2", "Chapter 3"];
  const result = expandIteration(graph, "draft-chapters", items, "Write about {{item}}");

  const instances = result.steps.filter((s) => s.parentStepId === "draft-chapters");
  assert.equal(instances.length, 3);
});

test("expandIteration instance IDs are deterministic and zero-padded", () => {
  const graph = makeIterateGraph();
  const items = ["A", "B", "C"];
  const result = expandIteration(graph, "draft-chapters", items, "p");

  const instanceIds = result.steps
    .filter((s) => s.parentStepId === "draft-chapters")
    .map((s) => s.id);

  assert.deepEqual(instanceIds, [
    "draft-chapters--001",
    "draft-chapters--002",
    "draft-chapters--003",
  ]);
});

test("expandIteration marks parent step as expanded", () => {
  const graph = makeIterateGraph();
  const result = expandIteration(graph, "draft-chapters", ["X"], "p");

  const parent = result.steps.find((s) => s.id === "draft-chapters");
  assert.equal(parent?.status, "expanded");
});

test("expandIteration rewrites downstream dependsOn", () => {
  const graph = makeIterateGraph();
  const items = ["A", "B", "C"];
  const result = expandIteration(graph, "draft-chapters", items, "p");

  const review = result.steps.find((s) => s.id === "review");
  assert.deepEqual(review?.dependsOn, [
    "draft-chapters--001",
    "draft-chapters--002",
    "draft-chapters--003",
  ]);
});

test("expandIteration copies parent dependsOn to instances", () => {
  const graph = makeIterateGraph();
  // Parent "draft-chapters" depends on "outline"
  const result = expandIteration(graph, "draft-chapters", ["A", "B"], "p");

  const instances = result.steps.filter((s) => s.parentStepId === "draft-chapters");
  for (const inst of instances) {
    assert.deepEqual(inst.dependsOn, ["outline"]);
  }
});

test("expandIteration instance prompts replace {{item}} placeholder", () => {
  const graph = makeIterateGraph();
  const result = expandIteration(
    graph,
    "draft-chapters",
    ["Chapter 1"],
    "Write about {{item}}, focusing on {{item}} details",
  );

  const instance = result.steps.find((s) => s.id === "draft-chapters--001");
  assert.equal(
    instance?.prompt,
    "Write about Chapter 1, focusing on Chapter 1 details",
  );
});

test("getNextPendingStep skips expanded steps", () => {
  const graph = makeIterateGraph();
  const expanded = expandIteration(graph, "draft-chapters", ["A", "B"], "p");

  // outline is complete, draft-chapters is expanded, instances are pending
  const next = getNextPendingStep(expanded);
  assert.equal(next?.id, "draft-chapters--001");
  // Confirm it's an instance, not the parent
  assert.equal(next?.parentStepId, "draft-chapters");
});

test("writeGraph/readGraph roundtrip preserves parentStepId and expanded status", () => {
  const dir = makeTmpDir();
  try {
    const graph = makeIterateGraph();
    const expanded = expandIteration(graph, "draft-chapters", ["A", "B"], "Write {{item}}");

    writeGraph(dir, expanded);
    const loaded = readGraph(dir);

    // Parent preserved
    const parent = loaded.steps.find((s) => s.id === "draft-chapters");
    assert.equal(parent?.status, "expanded");
    assert.equal(parent?.parentStepId, undefined);

    // Instance preserved
    const inst1 = loaded.steps.find((s) => s.id === "draft-chapters--001");
    assert.equal(inst1?.parentStepId, "draft-chapters");
    assert.equal(inst1?.status, "pending");
    assert.equal(inst1?.prompt, "Write A");

    const inst2 = loaded.steps.find((s) => s.id === "draft-chapters--002");
    assert.equal(inst2?.parentStepId, "draft-chapters");

    // Downstream deps rewritten
    const review = loaded.steps.find((s) => s.id === "review");
    assert.deepEqual(review?.dependsOn, [
      "draft-chapters--001",
      "draft-chapters--002",
    ]);

    // Steps without parentStepId don't gain one
    const outline = loaded.steps.find((s) => s.id === "outline");
    assert.equal(outline?.parentStepId, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expandIteration throws on missing stepId", () => {
  const graph = makeIterateGraph();
  assert.throws(
    () => expandIteration(graph, "nonexistent", ["A"], "p"),
    { message: /step not found: nonexistent/ },
  );
});

test("expandIteration throws on non-pending step", () => {
  const graph = makeIterateGraph();
  // "outline" is already "complete"
  assert.throws(
    () => expandIteration(graph, "outline", ["A"], "p"),
    { message: /has status "complete", expected "pending"/ },
  );
});

// ─── Immutability test ───────────────────────────────────────────────────

test("expandIteration does not mutate input graph", () => {
  const graph = makeIterateGraph();
  const originalSteps = graph.steps.map((s) => ({ ...s, dependsOn: [...s.dependsOn] }));

  expandIteration(graph, "draft-chapters", ["A", "B"], "p");

  // Original graph should be unchanged
  assert.equal(graph.steps.length, 3);
  for (let i = 0; i < graph.steps.length; i++) {
    assert.deepEqual(graph.steps[i].id, originalSteps[i].id);
    assert.deepEqual(graph.steps[i].status, originalSteps[i].status);
    assert.deepEqual(graph.steps[i].dependsOn, originalSteps[i].dependsOn);
  }
});

// ─── Integration tests: full engine dispatch with iterate ────────────────

import { stringify } from "yaml";
import { graphFromDefinition, markStepComplete } from "../graph.ts";
import { CustomWorkflowEngine } from "../custom-workflow-engine.ts";

/**
 * Helper: write DEFINITION.yaml and GRAPH.yaml for a 3-step iterate workflow.
 * outline → draft-chapter (iterate on outline.md) → review
 */
function setupIterateWorkflow(runDir: string): void {
  const definition = {
    version: 1,
    name: "book-pipeline",
    steps: [
      {
        id: "outline",
        name: "Create outline",
        prompt: "Write an outline of a book",
        produces: ["outline.md"],
      },
      {
        id: "draft-chapter",
        name: "Draft chapter",
        prompt: "Draft {{item}}",
        depends_on: ["outline"],
        iterate: {
          source: "outline.md",
          pattern: "^## (.+)",
        },
      },
      {
        id: "review",
        name: "Review all",
        prompt: "Review the complete book",
        depends_on: ["draft-chapter"],
      },
    ],
  };

  writeFileSync(join(runDir, "DEFINITION.yaml"), stringify(definition), "utf-8");

  // Build initial graph from the definition using the same conversion used by run-manager
  const typedDef = {
    version: 1,
    name: "book-pipeline",
    steps: [
      { id: "outline", name: "Create outline", prompt: "Write an outline of a book", requires: [], produces: ["outline.md"] },
      { id: "draft-chapter", name: "Draft chapter", prompt: "Draft {{item}}", requires: ["outline"], produces: [] },
      { id: "review", name: "Review all", prompt: "Review the complete book", requires: ["draft-chapter"], produces: [] },
    ],
  };
  const graph = graphFromDefinition(typedDef);
  writeGraph(runDir, graph);
}

test("integration: 3-step fan-out workflow dispatches 5 total steps", async () => {
  const dir = makeTmpDir();
  try {
    setupIterateWorkflow(dir);
    const engine = new CustomWorkflowEngine(dir);
    const dispatched: string[] = [];

    // ── Step 1: dispatch and complete "outline" ──
    const state1 = await engine.deriveState(dir);
    const d1 = await engine.resolveDispatch(state1, { basePath: dir });
    assert.equal(d1.action, "dispatch");
    if (d1.action === "dispatch") {
      assert.equal(d1.step.unitId, "outline");
      dispatched.push(d1.step.unitId);
    }

    // Write the outline artifact before reconciling
    writeFileSync(
      join(dir, "outline.md"),
      "# Book Outline\n\n## Chapter 1\n\n## Chapter 2\n\n## Chapter 3\n",
      "utf-8",
    );

    await engine.reconcile(state1, {
      unitType: "custom-step",
      unitId: "outline",
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
    });

    // ── Step 2: dispatch triggers expansion, returns first instance ──
    const state2 = await engine.deriveState(dir);
    const d2 = await engine.resolveDispatch(state2, { basePath: dir });
    assert.equal(d2.action, "dispatch");
    if (d2.action === "dispatch") {
      assert.equal(d2.step.unitId, "draft-chapter--001");
      dispatched.push(d2.step.unitId);
    }

    // Verify GRAPH.yaml after expansion
    const graphAfterExpansion = readGraph(dir);
    const stepIds = graphAfterExpansion.steps.map((s) => s.id);
    assert.deepEqual(stepIds, [
      "outline",
      "draft-chapter",
      "draft-chapter--001",
      "draft-chapter--002",
      "draft-chapter--003",
      "review",
    ]);

    // Verify statuses
    const parent = graphAfterExpansion.steps.find((s) => s.id === "draft-chapter");
    assert.equal(parent?.status, "expanded");

    const inst1 = graphAfterExpansion.steps.find((s) => s.id === "draft-chapter--001");
    assert.equal(inst1?.parentStepId, "draft-chapter");

    // Verify review now depends on all 3 instances
    const review = graphAfterExpansion.steps.find((s) => s.id === "review");
    assert.deepEqual(review?.dependsOn, [
      "draft-chapter--001",
      "draft-chapter--002",
      "draft-chapter--003",
    ]);

    // ── Steps 3-4: dispatch and complete remaining instances ──
    await engine.reconcile(state2, {
      unitType: "custom-step",
      unitId: "draft-chapter--001",
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
    });

    const state3 = await engine.deriveState(dir);
    const d3 = await engine.resolveDispatch(state3, { basePath: dir });
    assert.equal(d3.action, "dispatch");
    if (d3.action === "dispatch") {
      assert.equal(d3.step.unitId, "draft-chapter--002");
      dispatched.push(d3.step.unitId);
    }

    await engine.reconcile(state3, {
      unitType: "custom-step",
      unitId: "draft-chapter--002",
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
    });

    const state4 = await engine.deriveState(dir);
    const d4 = await engine.resolveDispatch(state4, { basePath: dir });
    assert.equal(d4.action, "dispatch");
    if (d4.action === "dispatch") {
      assert.equal(d4.step.unitId, "draft-chapter--003");
      dispatched.push(d4.step.unitId);
    }

    await engine.reconcile(state4, {
      unitType: "custom-step",
      unitId: "draft-chapter--003",
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
    });

    // ── Step 5: review is now dispatchable (all instance deps complete) ──
    const state5 = await engine.deriveState(dir);
    const d5 = await engine.resolveDispatch(state5, { basePath: dir });
    assert.equal(d5.action, "dispatch");
    if (d5.action === "dispatch") {
      assert.equal(d5.step.unitId, "review");
      dispatched.push(d5.step.unitId);
    }

    await engine.reconcile(state5, {
      unitType: "custom-step",
      unitId: "review",
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
    });

    // ── Verify: 5 dispatches total ──
    assert.deepEqual(dispatched, [
      "outline",
      "draft-chapter--001",
      "draft-chapter--002",
      "draft-chapter--003",
      "review",
    ]);

    // ── Verify: all done ──
    const finalState = await engine.deriveState(dir);
    assert.equal(finalState.isComplete, true);
    assert.equal(finalState.phase, "complete");

    const finalDispatch = await engine.resolveDispatch(finalState, { basePath: dir });
    assert.equal(finalDispatch.action, "stop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Determinism proof ───────────────────────────────────────────────────

test("determinism: identical input produces byte-identical GRAPH.yaml", () => {
  const dir1 = makeTmpDir();
  const dir2 = makeTmpDir();
  try {
    // Use a fixed timestamp so metadata.createdAt matches
    const fixedTimestamp = "2026-01-01T00:00:00.000Z";
    const graph: WorkflowGraph = {
      steps: [
        { id: "outline", title: "Create outline", status: "complete", prompt: "Write outline", dependsOn: [] },
        { id: "draft", title: "Draft", status: "pending", prompt: "Draft {{item}}", dependsOn: ["outline"] },
        { id: "review", title: "Review", status: "pending", prompt: "Review", dependsOn: ["draft"] },
      ],
      metadata: { name: "determinism-test", createdAt: fixedTimestamp },
    };

    const items = ["Chapter 1", "Chapter 2", "Chapter 3"];

    // Expand in dir1
    const expanded1 = expandIteration(graph, "draft", items, "Draft {{item}}");
    writeGraph(dir1, expanded1);

    // Expand in dir2 (identical input)
    const expanded2 = expandIteration(graph, "draft", items, "Draft {{item}}");
    writeGraph(dir2, expanded2);

    // Read both GRAPH.yaml files as raw strings
    const yaml1 = readFileSync(join(dir1, "GRAPH.yaml"), "utf-8");
    const yaml2 = readFileSync(join(dir2, "GRAPH.yaml"), "utf-8");

    assert.equal(yaml1, yaml2, "GRAPH.yaml files should be byte-identical");
  } finally {
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});

// ─── Edge case: resolveDispatch with iterate ─────────────────────────────

test("resolveDispatch: iterate with empty matches returns stop", async () => {
  const dir = makeTmpDir();
  try {
    setupIterateWorkflow(dir);
    const engine = new CustomWorkflowEngine(dir);

    // Complete outline
    const state1 = await engine.deriveState(dir);
    await engine.resolveDispatch(state1, { basePath: dir });
    await engine.reconcile(state1, {
      unitType: "custom-step",
      unitId: "outline",
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
    });

    // Write outline.md with NO matching "## " headings
    writeFileSync(join(dir, "outline.md"), "No headings here\nJust plain text\n", "utf-8");

    // Next dispatch should return stop (pattern matches nothing)
    const state2 = await engine.deriveState(dir);
    const dispatch = await engine.resolveDispatch(state2, { basePath: dir });
    assert.equal(dispatch.action, "stop");
    if (dispatch.action === "stop") {
      assert.ok(dispatch.reason?.includes("matched no items"), `Expected 'matched no items' in reason, got: ${dispatch.reason}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveDispatch: iterate idempotency — double dispatch doesn't double-expand", async () => {
  const dir = makeTmpDir();
  try {
    setupIterateWorkflow(dir);
    const engine = new CustomWorkflowEngine(dir);

    // Complete outline and write artifact
    const state1 = await engine.deriveState(dir);
    await engine.resolveDispatch(state1, { basePath: dir });
    writeFileSync(
      join(dir, "outline.md"),
      "## Chapter 1\n\n## Chapter 2\n",
      "utf-8",
    );
    await engine.reconcile(state1, {
      unitType: "custom-step",
      unitId: "outline",
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
    });

    // First dispatch triggers expansion
    const state2 = await engine.deriveState(dir);
    const d1 = await engine.resolveDispatch(state2, { basePath: dir });
    assert.equal(d1.action, "dispatch");
    if (d1.action === "dispatch") {
      assert.equal(d1.step.unitId, "draft-chapter--001");
    }

    // Count instances after first dispatch
    const graphAfter1 = readGraph(dir);
    const instanceCount1 = graphAfter1.steps.filter(
      (s) => s.parentStepId === "draft-chapter",
    ).length;
    assert.equal(instanceCount1, 2, "Should have 2 instances from 2 chapters");

    // Second dispatch WITHOUT reconciling — should skip expansion and return same instance
    const state3 = await engine.deriveState(dir);
    const d2 = await engine.resolveDispatch(state3, { basePath: dir });
    assert.equal(d2.action, "dispatch");
    if (d2.action === "dispatch") {
      assert.equal(d2.step.unitId, "draft-chapter--001");
    }

    // Instance count should be unchanged (no double expansion)
    const graphAfter2 = readGraph(dir);
    const instanceCount2 = graphAfter2.steps.filter(
      (s) => s.parentStepId === "draft-chapter",
    ).length;
    assert.equal(instanceCount2, 2, "Should still have exactly 2 instances (no double expansion)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
