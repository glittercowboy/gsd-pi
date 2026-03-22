/**
 * dev-engine-wrapper.test.ts — Contract tests for the dev engine wrapper layer (S02).
 *
 * Tests bridgeDispatchAction mapping, DevWorkflowEngine delegation,
 * DevExecutionPolicy stubs, resolver routing, kill switch, and
 * auto.ts engine ID accessors.
 */

import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── bridgeDispatchAction mapping ────────────────────────────────────────────

describe("bridgeDispatchAction", () => {
  test("maps dispatch action with step fields", async () => {
    const { bridgeDispatchAction } = await import(
      "../dev-workflow-engine.ts"
    );
    const result = bridgeDispatchAction({
      action: "dispatch",
      unitType: "execute-task",
      unitId: "T01",
      prompt: "do stuff",
      matchedRule: "foo",
    } as any);

    assert.equal(result.action, "dispatch");
    assert.ok("step" in result);
    const step = (result as any).step;
    assert.equal(step.unitType, "execute-task");
    assert.equal(step.unitId, "T01");
    assert.equal(step.prompt, "do stuff");
  });

  test("maps stop action with reason and level", async () => {
    const { bridgeDispatchAction } = await import(
      "../dev-workflow-engine.ts"
    );
    const result = bridgeDispatchAction({
      action: "stop",
      reason: "done",
      level: "info",
      matchedRule: "bar",
    } as any);

    assert.equal(result.action, "stop");
    assert.equal((result as any).reason, "done");
    assert.equal((result as any).level, "info");
  });

  test("maps skip action", async () => {
    const { bridgeDispatchAction } = await import(
      "../dev-workflow-engine.ts"
    );
    const result = bridgeDispatchAction({
      action: "skip",
      matchedRule: "baz",
    } as any);

    assert.equal(result.action, "skip");
  });
});

// ── DevWorkflowEngine ───────────────────────────────────────────────────────

describe("DevWorkflowEngine", () => {
  test("engineId is 'dev'", async () => {
    const { DevWorkflowEngine } = await import("../dev-workflow-engine.ts");
    const engine = new DevWorkflowEngine();
    assert.equal(engine.engineId, "dev");
  });

  test("deriveState returns EngineState with expected fields", async () => {
    const { DevWorkflowEngine } = await import("../dev-workflow-engine.ts");
    const engine = new DevWorkflowEngine();

    // Create a minimal temp .gsd structure for deriveState
    const tempDir = mkdtempSync(join(tmpdir(), "gsd-engine-test-"));
    mkdirSync(join(tempDir, ".gsd", "milestones"), { recursive: true });

    try {
      const state = await engine.deriveState(tempDir);

      assert.equal(typeof state.phase, "string", "phase should be a string");
      assert.ok(
        "currentMilestoneId" in state,
        "state should have currentMilestoneId",
      );
      assert.ok(
        "activeSliceId" in state,
        "state should have activeSliceId",
      );
      assert.ok(
        "activeTaskId" in state,
        "state should have activeTaskId",
      );
      assert.equal(
        typeof state.isComplete,
        "boolean",
        "isComplete should be boolean",
      );
      assert.ok("raw" in state, "state should have raw field");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("reconcile returns continue for non-complete state", async () => {
    const { DevWorkflowEngine } = await import("../dev-workflow-engine.ts");
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

    assert.equal(result.outcome, "continue");
  });

  test("reconcile returns milestone-complete for complete state", async () => {
    const { DevWorkflowEngine } = await import("../dev-workflow-engine.ts");
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

    assert.equal(result.outcome, "milestone-complete");
  });

  test("getDisplayMetadata returns expected fields", async () => {
    const { DevWorkflowEngine } = await import("../dev-workflow-engine.ts");
    const engine = new DevWorkflowEngine();

    const state = {
      phase: "executing",
      currentMilestoneId: "M001",
      activeSliceId: "S01",
      activeTaskId: "T01",
      isComplete: false,
      raw: {},
    };

    const meta = engine.getDisplayMetadata(state);

    assert.ok("engineLabel" in meta, "should have engineLabel");
    assert.ok("currentPhase" in meta, "should have currentPhase");
    assert.ok("progressSummary" in meta, "should have progressSummary");
    assert.ok("stepCount" in meta, "should have stepCount");
    assert.equal(meta.engineLabel, "GSD Dev");
  });
});

// ── DevExecutionPolicy stubs ────────────────────────────────────────────────

describe("DevExecutionPolicy", () => {
  test("verify returns 'continue'", async () => {
    const { DevExecutionPolicy } = await import(
      "../dev-execution-policy.ts"
    );
    const policy = new DevExecutionPolicy();
    const result = await policy.verify("execute-task", "T01", {
      basePath: "/tmp",
    });
    assert.equal(result, "continue");
  });

  test("selectModel returns null", async () => {
    const { DevExecutionPolicy } = await import(
      "../dev-execution-policy.ts"
    );
    const policy = new DevExecutionPolicy();
    const result = await policy.selectModel("execute-task", "T01", {
      basePath: "/tmp",
    });
    assert.equal(result, null);
  });

  test("recover returns { outcome: 'retry' }", async () => {
    const { DevExecutionPolicy } = await import(
      "../dev-execution-policy.ts"
    );
    const policy = new DevExecutionPolicy();
    const result = await policy.recover("execute-task", "T01", {
      basePath: "/tmp",
    });
    assert.deepEqual(result, { outcome: "retry" });
  });

  test("closeout returns { committed: false, artifacts: [] }", async () => {
    const { DevExecutionPolicy } = await import(
      "../dev-execution-policy.ts"
    );
    const policy = new DevExecutionPolicy();
    const result = await policy.closeout("execute-task", "T01", {
      basePath: "/tmp",
      startedAt: Date.now(),
    });
    assert.deepEqual(result, { committed: false, artifacts: [] });
  });

  test("prepareWorkspace resolves without error", async () => {
    const { DevExecutionPolicy } = await import(
      "../dev-execution-policy.ts"
    );
    const policy = new DevExecutionPolicy();
    await assert.doesNotReject(
      () => policy.prepareWorkspace("/tmp", "M001"),
      "prepareWorkspace should resolve without error",
    );
  });
});

// ── Resolver routing ────────────────────────────────────────────────────────

describe("Resolver routing", () => {
  test("resolveEngine returns dev engine for null activeEngineId", async () => {
    const { resolveEngine } = await import("../engine-resolver.ts");
    const result = resolveEngine({ activeEngineId: null });
    assert.ok(result.engine, "should return engine");
    assert.ok(result.policy, "should return policy");
    assert.equal(result.engine.engineId, "dev");
  });

  test("resolveEngine returns dev engine for 'dev' activeEngineId", async () => {
    const { resolveEngine } = await import("../engine-resolver.ts");
    const result = resolveEngine({ activeEngineId: "dev" });
    assert.ok(result.engine, "should return engine");
    assert.ok(result.policy, "should return policy");
    assert.equal(result.engine.engineId, "dev");
  });

  test("resolveEngine throws for unknown activeEngineId without activeRunDir", async () => {
    const { resolveEngine } = await import("../engine-resolver.ts");
    assert.throws(
      () => resolveEngine({ activeEngineId: "unknown" }),
      /requires activeRunDir/,
      "should throw when activeRunDir is missing for non-dev engine",
    );
  });
});

// ── Kill switch ─────────────────────────────────────────────────────────────

describe("Kill switch (GSD_ENGINE_BYPASS)", () => {
  const originalBypass = process.env.GSD_ENGINE_BYPASS;

  after(() => {
    // Restore original env var state
    if (originalBypass === undefined) {
      delete process.env.GSD_ENGINE_BYPASS;
    } else {
      process.env.GSD_ENGINE_BYPASS = originalBypass;
    }
  });

  test("GSD_ENGINE_BYPASS=1 does not affect resolveEngine (bypass checked in autoLoop)", async () => {
    const { resolveEngine } = await import("../engine-resolver.ts");
    process.env.GSD_ENGINE_BYPASS = "1";
    try {
      // resolveEngine should still resolve normally — bypass is checked in autoLoop
      const { engine } = resolveEngine({ activeEngineId: null });
      assert.ok(engine, "should return an engine even with bypass set");
    } finally {
      delete process.env.GSD_ENGINE_BYPASS;
    }
  });
});

// ── auto.ts engine ID accessors ─────────────────────────────────────────────

describe("auto.ts engine ID accessors", () => {
  test("setActiveEngineId / getActiveEngineId round-trip", async () => {
    const { setActiveEngineId, getActiveEngineId } = await import(
      "../auto.ts"
    );

    setActiveEngineId("dev");
    assert.equal(
      getActiveEngineId(),
      "dev",
      "getActiveEngineId should return 'dev' after setting",
    );

    setActiveEngineId(null);
    assert.equal(
      getActiveEngineId(),
      null,
      "getActiveEngineId should return null after setting null",
    );
  });
});
