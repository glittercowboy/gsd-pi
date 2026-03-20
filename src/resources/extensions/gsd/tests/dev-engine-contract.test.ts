/**
 * Contract tests for DevWorkflowEngine, DevExecutionPolicy, and engine-resolver.
 *
 * Validates:
 * - Interface shape satisfaction (all required methods/properties exist)
 * - Engine ID correctness
 * - Resolver routing logic (null → "dev", "dev" → "dev", unknown → throws)
 * - DispatchAction → EngineDispatchAction bridge correctness
 * - Policy stub return values
 */

import test from "node:test";
import assert from "node:assert/strict";

import { DevWorkflowEngine, bridgeDispatchAction } from "../dev-workflow-engine.ts";
import { DevExecutionPolicy } from "../dev-execution-policy.ts";
import { resolveEngine } from "../engine-resolver.ts";

// ─── DevWorkflowEngine shape ─────────────────────────────────────────────

test("DevWorkflowEngine has all WorkflowEngine properties", () => {
  const engine = new DevWorkflowEngine();
  assert.equal(typeof engine.engineId, "string");
  assert.equal(typeof engine.deriveState, "function");
  assert.equal(typeof engine.resolveDispatch, "function");
  assert.equal(typeof engine.reconcile, "function");
  assert.equal(typeof engine.getDisplayMetadata, "function");
});

test("DevWorkflowEngine.engineId is 'dev'", () => {
  const engine = new DevWorkflowEngine();
  assert.equal(engine.engineId, "dev");
});

// ─── DevExecutionPolicy shape ────────────────────────────────────────────

test("DevExecutionPolicy has all ExecutionPolicy properties", () => {
  const policy = new DevExecutionPolicy();
  assert.equal(typeof policy.prepareWorkspace, "function");
  assert.equal(typeof policy.selectModel, "function");
  assert.equal(typeof policy.verify, "function");
  assert.equal(typeof policy.recover, "function");
  assert.equal(typeof policy.closeout, "function");
});

// ─── Policy stub return values ───────────────────────────────────────────

test("DevExecutionPolicy.prepareWorkspace resolves void", async () => {
  const policy = new DevExecutionPolicy();
  const result = await policy.prepareWorkspace("/tmp", "M001");
  assert.equal(result, undefined);
});

test("DevExecutionPolicy.selectModel returns null", async () => {
  const policy = new DevExecutionPolicy();
  const result = await policy.selectModel("execute-task", "T01", { basePath: "/tmp" });
  assert.equal(result, null);
});

test("DevExecutionPolicy.verify returns 'continue'", async () => {
  const policy = new DevExecutionPolicy();
  const result = await policy.verify("execute-task", "T01", { basePath: "/tmp" });
  assert.equal(result, "continue");
});

test("DevExecutionPolicy.recover returns { outcome: 'retry' }", async () => {
  const policy = new DevExecutionPolicy();
  const result = await policy.recover("execute-task", "T01", { basePath: "/tmp" });
  assert.deepEqual(result, { outcome: "retry" });
});

test("DevExecutionPolicy.closeout returns { committed: false, artifacts: [] }", async () => {
  const policy = new DevExecutionPolicy();
  const result = await policy.closeout("execute-task", "T01", { basePath: "/tmp", startedAt: Date.now() });
  assert.deepEqual(result, { committed: false, artifacts: [] });
});

// ─── Engine Resolver ─────────────────────────────────────────────────────

test("resolveEngine with null activeEngineId returns dev engine", () => {
  const { engine, policy } = resolveEngine({ activeEngineId: null });
  assert.equal(engine.engineId, "dev");
  assert.ok(engine instanceof DevWorkflowEngine);
  assert.ok(policy instanceof DevExecutionPolicy);
});

test("resolveEngine with 'dev' activeEngineId returns dev engine", () => {
  const { engine, policy } = resolveEngine({ activeEngineId: "dev" });
  assert.equal(engine.engineId, "dev");
  assert.ok(engine instanceof DevWorkflowEngine);
  assert.ok(policy instanceof DevExecutionPolicy);
});

test("resolveEngine with unknown activeEngineId throws", () => {
  assert.throws(
    () => resolveEngine({ activeEngineId: "custom" }),
    { message: "Unknown engine: custom" },
  );
});

// ─── DispatchAction → EngineDispatchAction bridge ────────────────────────

test("bridgeDispatchAction converts 'dispatch' action", () => {
  const result = bridgeDispatchAction({
    action: "dispatch",
    unitType: "execute-task",
    unitId: "M001:S01:T01",
    prompt: "Do the thing",
  });
  assert.deepEqual(result, {
    action: "dispatch",
    step: {
      unitType: "execute-task",
      unitId: "M001:S01:T01",
      prompt: "Do the thing",
    },
  });
});

test("bridgeDispatchAction converts 'stop' action", () => {
  const result = bridgeDispatchAction({
    action: "stop",
    reason: "All done",
    level: "info",
  });
  assert.deepEqual(result, {
    action: "stop",
    reason: "All done",
    level: "info",
  });
});

test("bridgeDispatchAction converts 'skip' action", () => {
  const result = bridgeDispatchAction({ action: "skip" });
  assert.deepEqual(result, { action: "skip" });
});

// ─── Reconcile pass-through ──────────────────────────────────────────────

test("reconcile returns 'continue' when not complete", async () => {
  const engine = new DevWorkflowEngine();
  const state = {
    phase: "executing",
    currentMilestoneId: "M001",
    activeSliceId: "S01",
    activeTaskId: "T01",
    isComplete: false,
    raw: {},
  };
  const result = await engine.reconcile(state, {
    unitType: "execute-task",
    unitId: "T01",
    startedAt: Date.now() - 1000,
    finishedAt: Date.now(),
  });
  assert.deepEqual(result, { outcome: "continue" });
});

test("reconcile returns 'milestone-complete' when isComplete", async () => {
  const engine = new DevWorkflowEngine();
  const state = {
    phase: "complete",
    currentMilestoneId: "M001",
    activeSliceId: null,
    activeTaskId: null,
    isComplete: true,
    raw: {},
  };
  const result = await engine.reconcile(state, {
    unitType: "execute-task",
    unitId: "T01",
    startedAt: Date.now() - 1000,
    finishedAt: Date.now(),
  });
  assert.deepEqual(result, { outcome: "milestone-complete" });
});

// ─── getDisplayMetadata ──────────────────────────────────────────────────

test("getDisplayMetadata builds correct metadata from GSDState", () => {
  const engine = new DevWorkflowEngine();
  const gsdState = {
    phase: "executing",
    activeMilestone: { id: "M001", title: "Milestone One" },
    activeSlice: { id: "S02", title: "Slice Two" },
    activeTask: { id: "T01", title: "Task One" },
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [],
    progress: {
      milestones: { done: 0, total: 1 },
      slices: { done: 1, total: 3 },
      tasks: { done: 2, total: 5 },
    },
  };
  const state = {
    phase: "executing",
    currentMilestoneId: "M001",
    activeSliceId: "S02",
    activeTaskId: "T01",
    isComplete: false,
    raw: gsdState,
  };
  const meta = engine.getDisplayMetadata(state);
  assert.equal(meta.engineLabel, "GSD Dev");
  assert.equal(meta.currentPhase, "executing");
  assert.equal(meta.progressSummary, "M001 → S02 → T01");
  assert.deepEqual(meta.stepCount, { completed: 2, total: 5 });
});

test("getDisplayMetadata returns null stepCount when no progress.tasks", () => {
  const engine = new DevWorkflowEngine();
  const gsdState = {
    phase: "pre-planning",
    activeMilestone: null,
    activeSlice: null,
    activeTask: null,
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [],
  };
  const state = {
    phase: "pre-planning",
    currentMilestoneId: null,
    activeSliceId: null,
    activeTaskId: null,
    isComplete: false,
    raw: gsdState,
  };
  const meta = engine.getDisplayMetadata(state);
  assert.equal(meta.progressSummary, "No active milestone");
  assert.equal(meta.stepCount, null);
});
