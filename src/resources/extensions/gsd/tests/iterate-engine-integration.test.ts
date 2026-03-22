/**
 * iterate-engine-integration.test.ts — Integration tests for iterate/fan-out
 * expansion wired into CustomWorkflowEngine.
 *
 * Proves the full expansion→dispatch→reconcile cycle: the engine reads
 * iterate config from frozen DEFINITION.yaml, reads the source artifact,
 * extracts items via regex, calls expandIteration() to rewrite the graph,
 * persists it, and dispatches instance steps sequentially.
 *
 * Uses real temp directories with actual DEFINITION.yaml, GRAPH.yaml,
 * and source artifact files — no mocks.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";

import { CustomWorkflowEngine } from "../custom-workflow-engine.ts";
import {
  writeGraph,
  readGraph,
  type WorkflowGraph,
  type GraphStep,
} from "../graph.ts";
import type { WorkflowDefinition } from "../definition-loader.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iterate-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows EPERM */ }
  }
  tmpDirs.length = 0;
});

/**
 * Create a temp run directory with DEFINITION.yaml, GRAPH.yaml, and optional
 * artifact files. Returns the run dir path and engine instance.
 */
function makeTempRun(
  def: WorkflowDefinition,
  graphSteps: GraphStep[],
  files?: Record<string, string>,
): { runDir: string; engine: CustomWorkflowEngine } {
  const runDir = makeTmpDir();

  // Write frozen DEFINITION.yaml (camelCase — serialized from TS object)
  writeFileSync(join(runDir, "DEFINITION.yaml"), stringify(def), "utf-8");

  // Write GRAPH.yaml via the standard writer
  const graph: WorkflowGraph = {
    steps: graphSteps,
    metadata: { name: def.name, createdAt: "2026-01-01T00:00:00.000Z" },
  };
  writeGraph(runDir, graph);

  // Write optional artifact files
  if (files) {
    for (const [relPath, content] of Object.entries(files)) {
      const absPath = join(runDir, relPath);
      mkdirSync(join(absPath, ".."), { recursive: true });
      writeFileSync(absPath, content, "utf-8");
    }
  }

  return { runDir, engine: new CustomWorkflowEngine(runDir) };
}

/** Shorthand to build a GraphStep. */
function makeStep(overrides: Partial<GraphStep> & { id: string }): GraphStep {
  return {
    title: overrides.id,
    status: "pending",
    prompt: `Do ${overrides.id}`,
    dependsOn: [],
    ...overrides,
  };
}

/** Drive a full deriveState→resolveDispatch cycle. */
async function dispatch(engine: CustomWorkflowEngine) {
  const state = await engine.deriveState("/unused");
  return engine.resolveDispatch(state, { basePath: "/unused" });
}

/** Drive a full deriveState→reconcile cycle for a given unitId. */
async function reconcile(engine: CustomWorkflowEngine, unitId: string) {
  const state = await engine.deriveState("/unused");
  return engine.reconcile(state, {
    unitType: "custom-step",
    unitId,
    startedAt: Date.now() - 1000,
    finishedAt: Date.now(),
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("iterate expansion — basic", () => {
  it("expands an iterate step into 3 instances and dispatches the first", async () => {
    const def: WorkflowDefinition = {
      version: 1,
      name: "iter-wf",
      steps: [
        {
          id: "iter-step",
          name: "Iterate Step",
          prompt: "Process {{item}}",
          requires: [],
          produces: [],
          iterate: { source: "topics.md", pattern: "^- (.+)$" },
        },
      ],
    };

    const graphSteps = [
      makeStep({ id: "iter-step", prompt: "Process {{item}}" }),
    ];

    const { runDir, engine } = makeTempRun(def, graphSteps, {
      "topics.md": "- Alpha\n- Beta\n- Gamma\n",
    });

    const result = await dispatch(engine);

    // Should dispatch the first instance step
    assert.equal(result.action, "dispatch");
    if (result.action === "dispatch") {
      assert.equal(result.step.unitId, "iter-wf/iter-step--001");
      assert.equal(result.step.prompt, "Process Alpha");
    }

    // Verify on-disk graph state
    const graph = readGraph(runDir);
    const parent = graph.steps.find((s) => s.id === "iter-step");
    assert.ok(parent, "Parent step should exist");
    assert.equal(parent.status, "expanded");

    const instances = graph.steps.filter((s) => s.parentStepId === "iter-step");
    assert.equal(instances.length, 3);
    assert.equal(instances[0].id, "iter-step--001");
    assert.equal(instances[1].id, "iter-step--002");
    assert.equal(instances[2].id, "iter-step--003");
    assert.equal(instances[0].prompt, "Process Alpha");
    assert.equal(instances[1].prompt, "Process Beta");
    assert.equal(instances[2].prompt, "Process Gamma");
  });
});

describe("iterate expansion — full dispatch→reconcile sequence", () => {
  it("dispatches all 3 instances sequentially then stops", async () => {
    const def: WorkflowDefinition = {
      version: 1,
      name: "seq-wf",
      steps: [
        {
          id: "fan",
          name: "Fan Step",
          prompt: "Handle {{item}}",
          requires: [],
          produces: [],
          iterate: { source: "items.md", pattern: "^- (.+)$" },
        },
      ],
    };

    const graphSteps = [makeStep({ id: "fan", prompt: "Handle {{item}}" })];

    const { engine } = makeTempRun(def, graphSteps, {
      "items.md": "- One\n- Two\n- Three\n",
    });

    // First dispatch triggers expansion, returns instance 1
    let result = await dispatch(engine);
    assert.equal(result.action, "dispatch");
    if (result.action === "dispatch") {
      assert.equal(result.step.unitId, "seq-wf/fan--001");
      assert.equal(result.step.prompt, "Handle One");
    }

    // Reconcile instance 1, dispatch → instance 2
    await reconcile(engine, "seq-wf/fan--001");
    result = await dispatch(engine);
    assert.equal(result.action, "dispatch");
    if (result.action === "dispatch") {
      assert.equal(result.step.unitId, "seq-wf/fan--002");
      assert.equal(result.step.prompt, "Handle Two");
    }

    // Reconcile instance 2, dispatch → instance 3
    await reconcile(engine, "seq-wf/fan--002");
    result = await dispatch(engine);
    assert.equal(result.action, "dispatch");
    if (result.action === "dispatch") {
      assert.equal(result.step.unitId, "seq-wf/fan--003");
      assert.equal(result.step.prompt, "Handle Three");
    }

    // Reconcile instance 3, dispatch → should stop (all done)
    await reconcile(engine, "seq-wf/fan--003");
    result = await dispatch(engine);
    assert.equal(result.action, "stop");
    if (result.action === "stop") {
      assert.equal(result.reason, "All steps complete");
    }
  });
});

describe("iterate expansion — downstream blocking", () => {
  it("blocks downstream step until all instances are complete", async () => {
    const def: WorkflowDefinition = {
      version: 1,
      name: "block-wf",
      steps: [
        {
          id: "fan",
          name: "Fan Step",
          prompt: "Process {{item}}",
          requires: [],
          produces: [],
          iterate: { source: "items.md", pattern: "^- (.+)$" },
        },
        {
          id: "merge",
          name: "Merge Step",
          prompt: "Merge all results",
          requires: ["fan"],
          produces: [],
        },
      ],
    };

    const graphSteps = [
      makeStep({ id: "fan", prompt: "Process {{item}}" }),
      makeStep({ id: "merge", prompt: "Merge all results", dependsOn: ["fan"] }),
    ];

    const { runDir, engine } = makeTempRun(def, graphSteps, {
      "items.md": "- X\n- Y\n",
    });

    // First dispatch: expands and returns instance 1
    let result = await dispatch(engine);
    assert.equal(result.action, "dispatch");
    if (result.action === "dispatch") {
      assert.equal(result.step.unitId, "block-wf/fan--001");
    }

    // Verify downstream dep was rewritten: merge now depends on fan--001, fan--002
    let graph = readGraph(runDir);
    const mergeStep = graph.steps.find((s) => s.id === "merge");
    assert.ok(mergeStep);
    assert.deepStrictEqual(mergeStep.dependsOn.sort(), ["fan--001", "fan--002"]);

    // Complete instance 1 only — merge should NOT be dispatchable yet
    await reconcile(engine, "block-wf/fan--001");
    result = await dispatch(engine);
    assert.equal(result.action, "dispatch");
    if (result.action === "dispatch") {
      // Should get fan--002, not merge
      assert.equal(result.step.unitId, "block-wf/fan--002");
    }

    // Complete instance 2 — now merge should be dispatchable
    await reconcile(engine, "block-wf/fan--002");
    result = await dispatch(engine);
    assert.equal(result.action, "dispatch");
    if (result.action === "dispatch") {
      assert.equal(result.step.unitId, "block-wf/merge");
      assert.equal(result.step.prompt, "Merge all results");
    }

    // Complete merge — all done
    await reconcile(engine, "block-wf/merge");
    result = await dispatch(engine);
    assert.equal(result.action, "stop");
  });
});

describe("iterate expansion — zero matches", () => {
  it("handles zero-match expansion gracefully", async () => {
    const def: WorkflowDefinition = {
      version: 1,
      name: "zero-wf",
      steps: [
        {
          id: "fan",
          name: "Fan Step",
          prompt: "Process {{item}}",
          requires: [],
          produces: [],
          iterate: { source: "items.md", pattern: "^- (.+)$" },
        },
        {
          id: "after",
          name: "After Step",
          prompt: "Do after",
          requires: ["fan"],
          produces: [],
        },
      ],
    };

    const graphSteps = [
      makeStep({ id: "fan", prompt: "Process {{item}}" }),
      makeStep({ id: "after", prompt: "Do after", dependsOn: ["fan"] }),
    ];

    // Source file exists but has no matching lines
    const { runDir, engine } = makeTempRun(def, graphSteps, {
      "items.md": "No bullet items here\nJust plain text\n",
    });

    // Dispatch should expand with zero instances
    const result = await dispatch(engine);

    // Verify parent is expanded
    const graph = readGraph(runDir);
    const parent = graph.steps.find((s) => s.id === "fan");
    assert.ok(parent);
    assert.equal(parent.status, "expanded");

    // With zero instances, no instance deps exist.
    // expandIteration rewrites "fan" → [] in the downstream dep list,
    // so "after" now has empty dependsOn and becomes dispatchable.
    // But first dispatch after expansion finds no pending instance steps.
    // The engine should either dispatch "after" or return stop.
    // Let's check what actually happened:
    if (result.action === "dispatch") {
      // The re-query found "after" step (since its deps were rewritten to [])
      assert.equal(result.step.unitId, "zero-wf/after");
    } else {
      // The engine returned stop for zero instances
      assert.equal(result.action, "stop");
    }
  });
});

describe("iterate expansion — missing source artifact", () => {
  it("throws an error mentioning the missing file path", async () => {
    const def: WorkflowDefinition = {
      version: 1,
      name: "missing-wf",
      steps: [
        {
          id: "fan",
          name: "Fan Step",
          prompt: "Process {{item}}",
          requires: [],
          produces: [],
          iterate: { source: "nonexistent.md", pattern: "^- (.+)$" },
        },
      ],
    };

    const graphSteps = [
      makeStep({ id: "fan", prompt: "Process {{item}}" }),
    ];

    // No source file written
    const { engine } = makeTempRun(def, graphSteps);

    await assert.rejects(
      () => dispatch(engine),
      (err: Error) => {
        assert.ok(err.message.includes("nonexistent.md"), `Error should mention the filename: ${err.message}`);
        assert.ok(err.message.includes("Iterate source artifact not found"), `Error should mention it's an iterate source: ${err.message}`);
        return true;
      },
    );
  });
});

describe("iterate expansion — idempotency", () => {
  it("does not re-expand an already expanded step on subsequent dispatch", async () => {
    const def: WorkflowDefinition = {
      version: 1,
      name: "idem-wf",
      steps: [
        {
          id: "fan",
          name: "Fan Step",
          prompt: "Process {{item}}",
          requires: [],
          produces: [],
          iterate: { source: "items.md", pattern: "^- (.+)$" },
        },
      ],
    };

    const graphSteps = [makeStep({ id: "fan", prompt: "Process {{item}}" })];

    const { runDir, engine } = makeTempRun(def, graphSteps, {
      "items.md": "- Uno\n- Dos\n",
    });

    // First dispatch: triggers expansion
    let result = await dispatch(engine);
    assert.equal(result.action, "dispatch");
    if (result.action === "dispatch") {
      assert.equal(result.step.unitId, "idem-wf/fan--001");
    }

    // Second dispatch without reconciling: should return the same instance
    // (graph already expanded on disk, parent is "expanded" so getNextPendingStep
    //  skips it and returns the first pending instance step)
    result = await dispatch(engine);
    assert.equal(result.action, "dispatch");
    if (result.action === "dispatch") {
      assert.equal(result.step.unitId, "idem-wf/fan--001");
    }

    // Verify no double-expansion: still only 2 instances
    const graph = readGraph(runDir);
    const instances = graph.steps.filter((s) => s.parentStepId === "fan");
    assert.equal(instances.length, 2);
  });
});
