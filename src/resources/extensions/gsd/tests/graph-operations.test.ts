/**
 * graph-operations.test.ts — Comprehensive tests for graph.ts DAG operations.
 *
 * Covers: YAML I/O round-trips, DAG queries (getNextPendingStep),
 * immutable step completion, iteration expansion with downstream dep
 * rewriting, initializeGraph conversion, and atomic write safety.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readGraph,
  writeGraph,
  getNextPendingStep,
  markStepComplete,
  expandIteration,
  initializeGraph,
  graphFromDefinition,
  type WorkflowGraph,
  type GraphStep,
} from "../graph.ts";
import type { WorkflowDefinition } from "../definition-loader.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "graph-test-"));
}

function cleanupDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows EPERM */ }
}

/** Minimal valid graph for testing. */
function makeGraph(steps: GraphStep[], name = "test-workflow"): WorkflowGraph {
  return {
    steps,
    metadata: { name, createdAt: "2026-01-01T00:00:00.000Z" },
  };
}

function makeStep(overrides: Partial<GraphStep> & { id: string }): GraphStep {
  return {
    title: overrides.id,
    status: "pending",
    prompt: `Do ${overrides.id}`,
    dependsOn: [],
    ...overrides,
  };
}

// ─── writeGraph + readGraph round-trip ───────────────────────────────────

describe("writeGraph + readGraph round-trip", () => {
  it("preserves all fields including parentStepId and dependsOn", (t) => {
    const dir = makeTmpDir();
    try {
      const graph = makeGraph([
        makeStep({ id: "step-1", title: "First Step", dependsOn: [] }),
        makeStep({
          id: "step-2",
          title: "Second Step",
          dependsOn: ["step-1"],
          parentStepId: "parent-iter",
        }),
      ]);

      writeGraph(dir, graph);
      const loaded = readGraph(dir);

      assert.equal(loaded.steps.length, 2);
      assert.equal(loaded.steps[0].id, "step-1");
      assert.equal(loaded.steps[0].title, "First Step");
      assert.equal(loaded.steps[0].status, "pending");
      assert.deepStrictEqual(loaded.steps[0].dependsOn, []);

      assert.equal(loaded.steps[1].id, "step-2");
      assert.deepStrictEqual(loaded.steps[1].dependsOn, ["step-1"]);
      assert.equal(loaded.steps[1].parentStepId, "parent-iter");

      assert.equal(loaded.metadata.name, "test-workflow");
      assert.equal(loaded.metadata.createdAt, "2026-01-01T00:00:00.000Z");
    } finally {
      cleanupDir(dir);
    }
  });

  it("preserves startedAt and finishedAt fields", (t) => {
    const dir = makeTmpDir();
    try {
      const graph = makeGraph([
        makeStep({
          id: "s1",
          status: "complete",
          startedAt: "2026-01-01T01:00:00.000Z",
          finishedAt: "2026-01-01T01:05:00.000Z",
        }),
      ]);
      writeGraph(dir, graph);
      const loaded = readGraph(dir);

      assert.equal(loaded.steps[0].startedAt, "2026-01-01T01:00:00.000Z");
      assert.equal(loaded.steps[0].finishedAt, "2026-01-01T01:05:00.000Z");
    } finally {
      cleanupDir(dir);
    }
  });

  it("creates directory if it does not exist", (t) => {
    const base = makeTmpDir();
    const nested = join(base, "sub", "dir");
    try {
      const graph = makeGraph([makeStep({ id: "s1" })]);
      writeGraph(nested, graph);
      assert.ok(existsSync(join(nested, "GRAPH.yaml")));

      const loaded = readGraph(nested);
      assert.equal(loaded.steps[0].id, "s1");
    } finally {
      cleanupDir(base);
    }
  });
});

// ─── readGraph error paths ───────────────────────────────────────────────

describe("readGraph error paths", () => {
  it("throws with descriptive error when file is missing", (t) => {
    const dir = makeTmpDir();
    t.after(() => { cleanupDir(dir); });

    assert.throws(
      () => readGraph(dir),
      (err: Error) => {
        assert.ok(err.message.includes("GRAPH.yaml not found"));
        assert.ok(err.message.includes(dir));
        return true;
      },
    );
  });

  it("throws with descriptive error when YAML is malformed (missing steps)", (t) => {
    const dir = makeTmpDir();
    t.after(() => { cleanupDir(dir); });

    writeFileSync(join(dir, "GRAPH.yaml"), "metadata:\n  name: bad\n", "utf-8");
    assert.throws(
      () => readGraph(dir),
      (err: Error) => {
        assert.ok(err.message.includes("missing or invalid 'steps' array"));
        return true;
      },
    );
  });

  it("throws when steps is not an array", (t) => {
    const dir = makeTmpDir();
    t.after(() => { cleanupDir(dir); });

    writeFileSync(join(dir, "GRAPH.yaml"), "steps: not-an-array\nmetadata:\n  name: bad\n", "utf-8");
    assert.throws(
      () => readGraph(dir),
      (err: Error) => {
        assert.ok(err.message.includes("missing or invalid 'steps' array"));
        return true;
      },
    );
  });
});

// ─── getNextPendingStep ──────────────────────────────────────────────────

describe("getNextPendingStep", () => {
  it("returns first step with all deps complete", (t) => {
    const graph = makeGraph([
      makeStep({ id: "a", status: "complete" }),
      makeStep({ id: "b", dependsOn: ["a"] }),
      makeStep({ id: "c", dependsOn: ["b"] }),
    ]);

    const next = getNextPendingStep(graph);
    assert.equal(next?.id, "b");
  });

  it("skips steps with incomplete deps", (t) => {
    const graph = makeGraph([
      makeStep({ id: "a" }),
      makeStep({ id: "b", dependsOn: ["a"] }),
    ]);

    // 'a' is still pending, so 'b' is blocked, but 'a' has no deps → returns 'a'
    const next = getNextPendingStep(graph);
    assert.equal(next?.id, "a");
  });

  it("returns null when all steps are complete", (t) => {
    const graph = makeGraph([
      makeStep({ id: "a", status: "complete" }),
      makeStep({ id: "b", status: "complete" }),
    ]);

    assert.equal(getNextPendingStep(graph), null);
  });

  it("returns null when all pending steps are blocked", (t) => {
    const graph = makeGraph([
      makeStep({ id: "a", status: "active" }), // not complete
      makeStep({ id: "b", dependsOn: ["a"] }),  // blocked
    ]);

    assert.equal(getNextPendingStep(graph), null);
  });

  it("returns first pending step with no deps when root steps exist", (t) => {
    const graph = makeGraph([
      makeStep({ id: "a" }),
      makeStep({ id: "b" }),
    ]);

    const next = getNextPendingStep(graph);
    assert.equal(next?.id, "a");
  });

  it("skips expanded steps", (t) => {
    const graph = makeGraph([
      makeStep({ id: "a", status: "expanded" }),
      makeStep({ id: "b" }),
    ]);

    const next = getNextPendingStep(graph);
    assert.equal(next?.id, "b");
  });
});

// ─── markStepComplete ────────────────────────────────────────────────────

describe("markStepComplete", () => {
  it("returns new graph with step status 'complete' (original unchanged)", (t) => {
    const original = makeGraph([
      makeStep({ id: "a" }),
      makeStep({ id: "b" }),
    ]);

    const updated = markStepComplete(original, "a");

    // Original is untouched
    assert.equal(original.steps[0].status, "pending");

    // New graph has the step complete
    assert.equal(updated.steps[0].status, "complete");
    assert.equal(updated.steps[0].id, "a");

    // Other steps unchanged
    assert.equal(updated.steps[1].status, "pending");
  });

  it("sets finishedAt timestamp", (t) => {
    const graph = makeGraph([makeStep({ id: "a" })]);
    const updated = markStepComplete(graph, "a");
    assert.ok(updated.steps[0].finishedAt);
    // Should be a valid ISO string
    assert.ok(!isNaN(Date.parse(updated.steps[0].finishedAt!)));
  });

  it("throws for unknown step ID", (t) => {
    const graph = makeGraph([makeStep({ id: "a" })]);
    assert.throws(
      () => markStepComplete(graph, "nonexistent"),
      (err: Error) => {
        assert.ok(err.message.includes("Step not found"));
        assert.ok(err.message.includes("nonexistent"));
        return true;
      },
    );
  });

  it("preserves metadata in returned graph", (t) => {
    const graph = makeGraph([makeStep({ id: "a" })], "my-workflow");
    const updated = markStepComplete(graph, "a");
    assert.equal(updated.metadata.name, "my-workflow");
    assert.equal(updated.metadata.createdAt, "2026-01-01T00:00:00.000Z");
  });
});

// ─── expandIteration ─────────────────────────────────────────────────────

describe("expandIteration", () => {
  it("creates instance steps with correct IDs (stepId--001, stepId--002)", (t) => {
    const graph = makeGraph([
      makeStep({ id: "iter-step", title: "Process items" }),
      makeStep({ id: "final", dependsOn: ["iter-step"] }),
    ]);

    const expanded = expandIteration(
      graph,
      "iter-step",
      ["apple", "banana", "cherry"],
      "Process {{item}}",
    );

    // Parent + 3 instances + final = 5 steps
    assert.equal(expanded.steps.length, 5);

    // Instances are correctly named
    assert.equal(expanded.steps[1].id, "iter-step--001");
    assert.equal(expanded.steps[2].id, "iter-step--002");
    assert.equal(expanded.steps[3].id, "iter-step--003");
  });

  it("marks parent step as 'expanded'", (t) => {
    const graph = makeGraph([
      makeStep({ id: "iter", title: "Iterate" }),
    ]);

    const expanded = expandIteration(graph, "iter", ["a"], "Do {{item}}");
    assert.equal(expanded.steps[0].status, "expanded");
  });

  it("instance steps have correct titles, prompts, parentStepId, and deps", (t) => {
    const graph = makeGraph([
      makeStep({ id: "pre", status: "complete" }),
      makeStep({ id: "iter", title: "Process", dependsOn: ["pre"] }),
    ]);

    const expanded = expandIteration(
      graph,
      "iter",
      ["foo", "bar"],
      "Handle {{item}} carefully",
    );

    const inst1 = expanded.steps[2]; // after pre and expanded parent
    assert.equal(inst1.title, "Process: foo");
    assert.equal(inst1.prompt, "Handle foo carefully");
    assert.equal(inst1.parentStepId, "iter");
    assert.deepStrictEqual(inst1.dependsOn, ["pre"]);
    assert.equal(inst1.status, "pending");

    const inst2 = expanded.steps[3];
    assert.equal(inst2.title, "Process: bar");
    assert.equal(inst2.prompt, "Handle bar carefully");
    assert.equal(inst2.parentStepId, "iter");
  });

  it("rewrites downstream deps from parent ID to all instance IDs", (t) => {
    const graph = makeGraph([
      makeStep({ id: "iter", title: "Iterate" }),
      makeStep({ id: "after", dependsOn: ["iter"] }),
    ]);

    const expanded = expandIteration(
      graph,
      "iter",
      ["x", "y"],
      "Do {{item}}",
    );

    // 'after' should now depend on iter--001 and iter--002
    const afterStep = expanded.steps.find((s) => s.id === "after")!;
    assert.deepStrictEqual(afterStep.dependsOn, ["iter--001", "iter--002"]);
  });

  it("preserves steps that don't depend on the parent", (t) => {
    const graph = makeGraph([
      makeStep({ id: "unrelated" }),
      makeStep({ id: "iter", title: "Iterate" }),
      makeStep({ id: "after", dependsOn: ["iter"] }),
    ]);

    const expanded = expandIteration(graph, "iter", ["a"], "{{item}}");
    const unrelated = expanded.steps.find((s) => s.id === "unrelated")!;
    assert.deepStrictEqual(unrelated.dependsOn, []);
  });

  it("throws for non-pending parent step", (t) => {
    const graph = makeGraph([
      makeStep({ id: "iter", status: "complete" }),
    ]);

    assert.throws(
      () => expandIteration(graph, "iter", ["a"], "{{item}}"),
      (err: Error) => {
        assert.ok(err.message.includes("complete"));
        assert.ok(err.message.includes("expected \"pending\""));
        return true;
      },
    );
  });

  it("throws for unknown step ID", (t) => {
    const graph = makeGraph([makeStep({ id: "a" })]);
    assert.throws(
      () => expandIteration(graph, "nonexistent", ["a"], "{{item}}"),
      (err: Error) => {
        assert.ok(err.message.includes("step not found"));
        assert.ok(err.message.includes("nonexistent"));
        return true;
      },
    );
  });

  it("does not mutate the input graph", (t) => {
    const graph = makeGraph([
      makeStep({ id: "iter", title: "Iterate" }),
      makeStep({ id: "after", dependsOn: ["iter"] }),
    ]);

    const originalStepsLength = graph.steps.length;
    const originalAfterDeps = [...graph.steps[1].dependsOn];

    expandIteration(graph, "iter", ["a", "b"], "{{item}}");

    // Original unchanged
    assert.equal(graph.steps.length, originalStepsLength);
    assert.equal(graph.steps[0].status, "pending");
    assert.deepStrictEqual(graph.steps[1].dependsOn, originalAfterDeps);
  });
});

// ─── initializeGraph ─────────────────────────────────────────────────────

describe("initializeGraph", () => {
  it("converts a valid 3-step definition to graph with all pending steps", (t) => {
    const def: WorkflowDefinition = {
      version: 1,
      name: "test-workflow",
      steps: [
        { id: "s1", name: "Step One", prompt: "Do step one", requires: [], produces: ["out.md"] },
        { id: "s2", name: "Step Two", prompt: "Do step two", requires: ["s1"], produces: [] },
        { id: "s3", name: "Step Three", prompt: "Do step three", requires: ["s1", "s2"], produces: [] },
      ],
    };

    const graph = initializeGraph(def);

    assert.equal(graph.steps.length, 3);
    assert.equal(graph.metadata.name, "test-workflow");
    assert.ok(graph.metadata.createdAt); // ISO string

    // All pending
    for (const step of graph.steps) {
      assert.equal(step.status, "pending");
    }

    // Correct mapping
    assert.equal(graph.steps[0].id, "s1");
    assert.equal(graph.steps[0].title, "Step One");
    assert.equal(graph.steps[0].prompt, "Do step one");
    assert.deepStrictEqual(graph.steps[0].dependsOn, []);

    assert.equal(graph.steps[1].id, "s2");
    assert.deepStrictEqual(graph.steps[1].dependsOn, ["s1"]);

    assert.equal(graph.steps[2].id, "s3");
    assert.deepStrictEqual(graph.steps[2].dependsOn, ["s1", "s2"]);
  });

  it("is also exported as graphFromDefinition (backward compat)", (t) => {
    assert.equal(graphFromDefinition, initializeGraph);
  });
});

// ─── Atomic write safety ─────────────────────────────────────────────────

describe("atomic write safety", () => {
  it("final file exists and .tmp file does not exist after write", (t) => {
    const dir = makeTmpDir();
    try {
      const graph = makeGraph([makeStep({ id: "s1" })]);
      writeGraph(dir, graph);

      assert.ok(existsSync(join(dir, "GRAPH.yaml")));
      assert.ok(!existsSync(join(dir, "GRAPH.yaml.tmp")));
    } finally {
      cleanupDir(dir);
    }
  });

  it("YAML content is valid and parseable", (t) => {
    const dir = makeTmpDir();
    try {
      const graph = makeGraph([makeStep({ id: "s1" })]);
      writeGraph(dir, graph);

      const content = readFileSync(join(dir, "GRAPH.yaml"), "utf-8");
      // Should contain snake_case keys
      assert.ok(content.includes("created_at"));
      // Should not contain camelCase keys
      assert.ok(!content.includes("createdAt"));
      assert.ok(!content.includes("dependsOn"));
    } finally {
      cleanupDir(dir);
    }
  });
});

// ─── YAML snake_case / camelCase boundary ────────────────────────────────

describe("YAML snake_case / camelCase boundary", () => {
  it("writes snake_case to disk and reads back as camelCase", (t) => {
    const dir = makeTmpDir();
    try {
      const graph = makeGraph([
        makeStep({
          id: "s1",
          dependsOn: ["s0"],
          parentStepId: "parent",
          startedAt: "2026-01-01T00:00:00Z",
          finishedAt: "2026-01-01T00:01:00Z",
        }),
      ]);

      writeGraph(dir, graph);

      // Verify raw YAML uses snake_case
      const raw = readFileSync(join(dir, "GRAPH.yaml"), "utf-8");
      assert.ok(raw.includes("depends_on"));
      assert.ok(raw.includes("parent_step_id"));
      assert.ok(raw.includes("started_at"));
      assert.ok(raw.includes("finished_at"));
      assert.ok(raw.includes("created_at"));

      // Verify read returns camelCase
      const loaded = readGraph(dir);
      assert.deepStrictEqual(loaded.steps[0].dependsOn, ["s0"]);
      assert.equal(loaded.steps[0].parentStepId, "parent");
      assert.equal(loaded.steps[0].startedAt, "2026-01-01T00:00:00Z");
      assert.equal(loaded.steps[0].finishedAt, "2026-01-01T00:01:00Z");
    } finally {
      cleanupDir(dir);
    }
  });

  it("omits optional fields from YAML when undefined", (t) => {
    const dir = makeTmpDir();
    try {
      const graph = makeGraph([
        makeStep({ id: "s1" }),
      ]);

      writeGraph(dir, graph);
      const raw = readFileSync(join(dir, "GRAPH.yaml"), "utf-8");

      // No depends_on, parent_step_id, started_at, finished_at when undefined/empty
      assert.ok(!raw.includes("depends_on"));
      assert.ok(!raw.includes("parent_step_id"));
      assert.ok(!raw.includes("started_at"));
      assert.ok(!raw.includes("finished_at"));
    } finally {
      cleanupDir(dir);
    }
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles empty items array in expandIteration", (t) => {
    const graph = makeGraph([
      makeStep({ id: "iter" }),
    ]);

    const expanded = expandIteration(graph, "iter", [], "{{item}}");
    // Parent marked expanded, no instances created
    assert.equal(expanded.steps.length, 1);
    assert.equal(expanded.steps[0].status, "expanded");
  });

  it("handles graph with single step", (t) => {
    const graph = makeGraph([makeStep({ id: "only" })]);
    const next = getNextPendingStep(graph);
    assert.equal(next?.id, "only");

    const completed = markStepComplete(graph, "only");
    assert.equal(getNextPendingStep(completed), null);
  });

  it("initializeGraph handles steps with empty requires", (t) => {
    const def: WorkflowDefinition = {
      version: 1,
      name: "empty-requires",
      steps: [
        { id: "s1", name: "Step", prompt: "Go", requires: [], produces: [] },
      ],
    };
    const graph = initializeGraph(def);
    assert.deepStrictEqual(graph.steps[0].dependsOn, []);
  });
});
