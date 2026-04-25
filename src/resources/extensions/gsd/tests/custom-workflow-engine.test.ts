/**
 * custom-workflow-engine.test.ts — Tests for CustomWorkflowEngine and CustomExecutionPolicy.
 *
 * Uses real temp directories with actual GRAPH.yaml files — no mocks.
 * Tests the full engine lifecycle: deriveState → resolveDispatch → reconcile.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";

import { CustomWorkflowEngine } from "../custom-workflow-engine.ts";
import { CustomExecutionPolicy } from "../custom-execution-policy.ts";
import { writeGraph, readGraph, type WorkflowGraph, type GraphStep } from "../graph.ts";
import { stringify } from "yaml";

// ─── Helpers ─────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "engine-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows EPERM */ }
  }
  tmpDirs.length = 0;
});

function makeStep(overrides: Partial<GraphStep> & { id: string }): GraphStep {
  return {
    title: overrides.id,
    status: "pending",
    prompt: `Do ${overrides.id}`,
    dependsOn: [],
    ...overrides,
  };
}

function makeGraph(steps: GraphStep[], name = "test-wf"): WorkflowGraph {
  return {
    steps,
    metadata: { name, createdAt: "2026-01-01T00:00:00.000Z" },
  };
}

/** Write a graph to a temp dir and return engine + dir. Also writes a minimal DEFINITION.yaml so resolveDispatch/injectContext can read it. */
function setupEngine(
  steps: GraphStep[],
  name = "test-wf",
): { engine: CustomWorkflowEngine; runDir: string } {
  const runDir = makeTmpDir();
  const graph = makeGraph(steps, name);
  writeGraph(runDir, graph);

  // Write a minimal DEFINITION.yaml matching the graph steps
  const def = {
    version: 1,
    name,
    steps: steps.map((s) => ({
      id: s.id,
      name: s.title,
      prompt: s.prompt,
      requires: s.dependsOn,
      produces: [],
    })),
  };
  writeFileSync(join(runDir, "DEFINITION.yaml"), stringify(def), "utf-8");

  return { engine: new CustomWorkflowEngine(runDir), runDir };
}

// ─── deriveState ─────────────────────────────────────────────────────────

describe("CustomWorkflowEngine.deriveState", () => {
  it("returns running phase when steps are pending", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "a" }),
      makeStep({ id: "b", dependsOn: ["a"] }),
    ]);

    const state = await engine.deriveState("/unused");

    assert.equal(state.phase, "running");
    assert.equal(state.isComplete, false);
    assert.ok(state.raw, "raw should contain the graph");
  });

  it("returns complete phase when all steps are complete", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "a", status: "complete" }),
      makeStep({ id: "b", status: "complete" }),
    ]);

    const state = await engine.deriveState("/unused");

    assert.equal(state.phase, "complete");
    assert.equal(state.isComplete, true);
  });

  it("treats expanded steps as done for completion check", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "a", status: "expanded" }),
      makeStep({ id: "a--001", status: "complete", parentStepId: "a" }),
      makeStep({ id: "b", status: "complete" }),
    ]);

    const state = await engine.deriveState("/unused");

    assert.equal(state.phase, "complete");
    assert.equal(state.isComplete, true);
  });
});

// ─── resolveDispatch ─────────────────────────────────────────────────────

describe("CustomWorkflowEngine.resolveDispatch", () => {
  it("returns dispatch for first pending step", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "step-1", prompt: "Do the first thing" }),
      makeStep({ id: "step-2", dependsOn: ["step-1"] }),
    ], "my-workflow");

    const state = await engine.deriveState("/unused");
    const dispatch = await engine.resolveDispatch(state, { basePath: "/unused" });

    assert.equal(dispatch.action, "dispatch");
    if (dispatch.action === "dispatch") {
      assert.equal(dispatch.step.unitType, "custom-step");
      assert.equal(dispatch.step.unitId, "my-workflow/step-1");
      assert.equal(dispatch.step.prompt, "Do the first thing");
    }
  });

  it("persists the dispatched step as active in GRAPH.yaml before returning", async () => {
    const { engine, runDir } = setupEngine([
      makeStep({ id: "step-1", prompt: "Do the first thing" }),
      makeStep({ id: "step-2", dependsOn: ["step-1"] }),
    ], "my-workflow");

    const state = await engine.deriveState("/unused");
    const dispatch = await engine.resolveDispatch(state, { basePath: "/unused" });

    assert.equal(dispatch.action, "dispatch");
    const graph = readGraph(runDir);
    assert.equal(graph.steps[0].status, "active");
    assert.ok(graph.steps[0].startedAt, "startedAt should be persisted before dispatch returns");
    assert.equal(graph.steps[1].status, "pending");
  });

  it("reuses an already active step on a subsequent dispatch before reconcile", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "step-1", prompt: "Do the first thing" }),
      makeStep({ id: "step-2", dependsOn: ["step-1"] }),
    ], "my-workflow");

    let state = await engine.deriveState("/unused");
    const firstDispatch = await engine.resolveDispatch(state, { basePath: "/unused" });
    assert.equal(firstDispatch.action, "dispatch");
    if (firstDispatch.action === "dispatch") {
      assert.equal(firstDispatch.step.unitId, "my-workflow/step-1");
    }

    state = await engine.deriveState("/unused");
    const secondDispatch = await engine.resolveDispatch(state, { basePath: "/unused" });
    assert.equal(secondDispatch.action, "dispatch");
    if (secondDispatch.action === "dispatch") {
      assert.equal(secondDispatch.step.unitId, "my-workflow/step-1");
      assert.equal(secondDispatch.step.prompt, "Do the first thing");
    }
  });

  it("returns stop when all steps are complete", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "a", status: "complete" }),
      makeStep({ id: "b", status: "complete" }),
    ]);

    const state = await engine.deriveState("/unused");
    const dispatch = await engine.resolveDispatch(state, { basePath: "/unused" });

    assert.equal(dispatch.action, "stop");
    if (dispatch.action === "stop") {
      assert.equal(dispatch.reason, "All steps complete");
      assert.equal(dispatch.level, "info");
    }
  });

  it("respects dependency ordering", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "a" }),
      makeStep({ id: "b", dependsOn: ["a"] }),
      makeStep({ id: "c", dependsOn: ["b"] }),
    ], "dep-wf");

    const state = await engine.deriveState("/unused");
    const dispatch = await engine.resolveDispatch(state, { basePath: "/unused" });

    // Should pick "a" (no deps), not "b" or "c"
    assert.equal(dispatch.action, "dispatch");
    if (dispatch.action === "dispatch") {
      assert.equal(dispatch.step.unitId, "dep-wf/a");
    }
  });

  it("picks next eligible step when earlier deps are complete", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "a", status: "complete" }),
      makeStep({ id: "b", dependsOn: ["a"] }),
      makeStep({ id: "c", dependsOn: ["b"] }),
    ], "dep-wf");

    const state = await engine.deriveState("/unused");
    const dispatch = await engine.resolveDispatch(state, { basePath: "/unused" });

    // "a" is done, "b" deps met, should pick "b"
    assert.equal(dispatch.action, "dispatch");
    if (dispatch.action === "dispatch") {
      assert.equal(dispatch.step.unitId, "dep-wf/b");
    }
  });
});

// ─── reconcile ───────────────────────────────────────────────────────────

describe("CustomWorkflowEngine.reconcile", () => {
  it("marks step complete in GRAPH.yaml on disk", async () => {
    const { engine, runDir } = setupEngine([
      makeStep({ id: "step-1" }),
      makeStep({ id: "step-2", dependsOn: ["step-1"] }),
    ], "wf");

    const state = await engine.deriveState("/unused");
    const result = await engine.reconcile(state, {
      unitType: "custom-step",
      unitId: "wf/step-1",
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
    });

    assert.equal(result.outcome, "continue");

    // Verify on-disk state
    const graph = readGraph(runDir);
    assert.equal(graph.steps[0].status, "complete");
    assert.ok(graph.steps[0].finishedAt, "finishedAt should be set");
    assert.equal(graph.steps[1].status, "pending");
  });

  it("returns milestone-complete when all steps done", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "only-step" }),
    ], "wf");

    const state = await engine.deriveState("/unused");
    const result = await engine.reconcile(state, {
      unitType: "custom-step",
      unitId: "wf/only-step",
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
    });

    assert.equal(result.outcome, "milestone-complete");
  });

  it("handles multi-segment unitId correctly", async () => {
    const { engine, runDir } = setupEngine([
      makeStep({ id: "deep-step" }),
    ], "nested/workflow");

    const state = await engine.deriveState("/unused");
    const result = await engine.reconcile(state, {
      unitType: "custom-step",
      unitId: "nested/workflow/deep-step",
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
    });

    assert.equal(result.outcome, "milestone-complete");
    const graph = readGraph(runDir);
    assert.equal(graph.steps[0].status, "complete");
  });

  it("re-reads GRAPH.yaml before reconcile so concurrent edits are preserved", async () => {
    const { engine, runDir } = setupEngine([
      makeStep({ id: "step-1" }),
      makeStep({ id: "step-2", dependsOn: ["step-1"] }),
    ], "wf");

    const staleState = await engine.deriveState("/unused");

    // Simulate another process appending a new step after deriveState() ran.
    writeGraph(runDir, makeGraph([
      makeStep({ id: "step-1" }),
      makeStep({ id: "step-2", dependsOn: ["step-1"] }),
      makeStep({ id: "step-3", dependsOn: ["step-2"] }),
    ], "wf"));

    const result = await engine.reconcile(staleState, {
      unitType: "custom-step",
      unitId: "wf/step-1",
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
    });

    assert.equal(result.outcome, "continue");

    const graph = readGraph(runDir);
    assert.equal(graph.steps.length, 3, "reconcile should preserve the concurrent graph edit");
    assert.equal(graph.steps[0].status, "complete");
    assert.equal(graph.steps[1].status, "pending");
    assert.equal(graph.steps[2].status, "pending");
  });

  it("reconcile completes a step that was previously persisted as active", async () => {
    const { engine, runDir } = setupEngine([
      makeStep({ id: "step-1", prompt: "Do the first thing" }),
      makeStep({ id: "step-2", dependsOn: ["step-1"] }),
    ], "wf");

    const state = await engine.deriveState("/unused");
    const dispatch = await engine.resolveDispatch(state, { basePath: "/unused" });
    assert.equal(dispatch.action, "dispatch");

    const activeState = await engine.deriveState("/unused");
    const result = await engine.reconcile(activeState, {
      unitType: "custom-step",
      unitId: "wf/step-1",
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
    });

    assert.equal(result.outcome, "continue");
    const graph = readGraph(runDir);
    assert.equal(graph.steps[0].status, "complete");
    assert.ok(graph.steps[0].startedAt, "startedAt should survive reconcile");
    assert.ok(graph.steps[0].finishedAt, "finishedAt should be persisted on completion");
  });
});

// ─── getDisplayMetadata ──────────────────────────────────────────────────

describe("CustomWorkflowEngine.getDisplayMetadata", () => {
  it("returns correct progress summary", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "a", status: "complete" }),
      makeStep({ id: "b" }),
      makeStep({ id: "c" }),
    ]);

    const state = await engine.deriveState("/unused");
    const meta = engine.getDisplayMetadata(state);

    assert.equal(meta.engineLabel, "WORKFLOW");
    assert.equal(meta.currentPhase, "running");
    assert.equal(meta.progressSummary, "Step 1/3");
    assert.deepStrictEqual(meta.stepCount, { completed: 1, total: 3 });
  });

  it("shows 0/N when no steps complete", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "a" }),
      makeStep({ id: "b" }),
    ]);

    const state = await engine.deriveState("/unused");
    const meta = engine.getDisplayMetadata(state);

    assert.equal(meta.progressSummary, "Step 0/2");
  });

  it("shows N/N when all steps complete", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "a", status: "complete" }),
      makeStep({ id: "b", status: "complete" }),
    ]);

    const state = await engine.deriveState("/unused");
    const meta = engine.getDisplayMetadata(state);

    assert.equal(meta.progressSummary, "Step 2/2");
    assert.equal(meta.currentPhase, "complete");
  });
});

// ─── CustomExecutionPolicy ───────────────────────────────────────────────

describe("CustomExecutionPolicy", () => {
  it("verify returns continue", async () => {
    // verify() reads DEFINITION.yaml from runDir to find step's verify policy
    const runDir = makeTmpDir();
    writeFileSync(join(runDir, "DEFINITION.yaml"), stringify({
      version: 1, name: "wf", description: "test",
      steps: [{ id: "step-1", name: "Step 1", prompt: "do it", produces: "step-1/output.md" }],
    }));
    const policy = new CustomExecutionPolicy(runDir);
    const result = await policy.verify("custom-step", "wf/step-1", { basePath: runDir });
    assert.equal(result, "continue");
  });

  it("selectModel returns null", async () => {
    const policy = new CustomExecutionPolicy("/tmp/run");
    const result = await policy.selectModel("custom-step", "wf/step-1", { basePath: "/tmp" });
    assert.equal(result, null);
  });

  it("recover returns retry", async () => {
    const policy = new CustomExecutionPolicy("/tmp/run");
    const result = await policy.recover("custom-step", "wf/step-1", { basePath: "/tmp" });
    assert.deepStrictEqual(result, { outcome: "retry", reason: "Default retry" });
  });

  it("closeout returns no artifacts", async () => {
    const policy = new CustomExecutionPolicy("/tmp/run");
    const result = await policy.closeout("custom-step", "wf/step-1", {
      basePath: "/tmp",
      startedAt: Date.now(),
    });
    assert.deepStrictEqual(result, { committed: false, artifacts: [] });
  });

  it("prepareWorkspace resolves without error", async () => {
    const policy = new CustomExecutionPolicy("/tmp/run");
    await policy.prepareWorkspace("/tmp", "M001"); // Should not throw
  });
});
