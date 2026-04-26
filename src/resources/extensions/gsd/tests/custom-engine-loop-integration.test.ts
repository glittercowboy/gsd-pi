/**
 * custom-engine-loop-integration.test.ts — Integration test proving that
 * autoLoop dispatches a 3-step custom workflow through the real pipeline.
 *
 * Creates a real run directory with GRAPH.yaml, mocks LoopDeps minimally,
 * and verifies all 3 steps complete in dependency order.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { autoLoop, resolveAgentEnd, _hasPendingResolveForTest, _resetPendingResolve } from "../auto-loop.js";
import type { LoopDeps } from "../auto/loop-deps.js";
import type { SessionLockStatus } from "../session-lock.js";
import { writeGraph, readGraph, type WorkflowGraph, type GraphStep } from "../graph.ts";
import { writeFileSync } from "node:fs";
import { stringify } from "yaml";

// ─── Helpers ─────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loop-integ-"));
  tmpDirs.push(dir);
  return dir;
}

async function resolveNextAgentEnd(timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!_hasPendingResolveForTest()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for pending agent_end resolver");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  resolveAgentEnd({ messages: [{ role: "assistant" }] });
}

afterEach(() => {
  _resetPendingResolve();
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows EPERM — OS cleans up temp dirs */ }
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

/** Write a minimal DEFINITION.yaml that matches the graph steps (needed by resolveDispatch since S06). */
function writeDefinition(runDir: string, steps: GraphStep[], name = "test-wf"): void {
  const def = {
    version: 1,
    name,
    description: `Test workflow: ${name}`,
    steps: steps.map((s) => ({
      id: s.id,
      name: s.title ?? s.id,
      prompt: s.prompt ?? `Do ${s.id}`,
      produces: `${s.id}/output.md`,
      ...(s.dependsOn?.length ? { requires: s.dependsOn } : {}),
    })),
  };
  writeFileSync(join(runDir, "DEFINITION.yaml"), stringify(def));
}

function makeMockCtx() {
  return {
    ui: { notify: () => {}, setStatus: () => {} },
    model: { id: "test-model" },
    sessionManager: { getSessionFile: () => "/tmp/session.json" },
  } as any;
}

function makeMockPi() {
  const calls: unknown[] = [];
  return {
    sendMessage: (...args: unknown[]) => {
      calls.push(args);
    },
    calls,
  } as any;
}

function makeLoopSession(overrides?: Record<string, unknown>) {
  return {
    active: true,
    verbose: false,
    stepMode: false,
    paused: false,
    basePath: "/tmp/project",
    originalBasePath: "",
    currentMilestoneId: null,
    currentUnit: null,
    currentUnitRouting: null,
    completedUnits: [],
    resourceVersionOnStart: null,
    lastPromptCharCount: undefined,
    lastBaselineCharCount: undefined,
    lastBudgetAlertLevel: 0,
    pendingVerificationRetry: null,
    pendingCrashRecovery: null,
    pendingQuickTasks: [],
    sidecarQueue: [],
    autoModeStartModel: null,
    unitDispatchCount: new Map<string, number>(),
    unitLifetimeDispatches: new Map<string, number>(),
    unitRecoveryCount: new Map<string, number>(),
    verificationRetryCount: new Map<string, number>(),
    gitService: null,
    autoStartTime: Date.now(),
    activeEngineId: null,
    activeRunDir: null,
    rewriteAttemptCount: 0,
    cmdCtx: {
      newSession: () => Promise.resolve({ cancelled: false }),
      getContextUsage: () => ({ percent: 10, tokens: 1000, limit: 10000 }),
    },
    clearTimers: () => {},
    lockBasePath: "/tmp/project",
    ...overrides,
  } as any;
}

function makeMockDeps(overrides?: Partial<LoopDeps>): LoopDeps & { callLog: string[] } {
  const callLog: string[] = [];

  const baseDeps: LoopDeps = {
    lockBase: () => "/tmp/test-lock",
    buildSnapshotOpts: () => ({}),
    stopAuto: async (_ctx, _pi, reason) => {
      callLog.push(`stopAuto:${reason ?? "no-reason"}`);
    },
    pauseAuto: async () => {
      callLog.push("pauseAuto");
    },
    clearUnitTimeout: () => {},
    updateProgressWidget: () => {},
    syncCmuxSidebar: () => {},
    logCmuxEvent: () => {},
    invalidateAllCaches: () => {},
    deriveState: async () => {
      callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Workflow", status: "active" },
        activeSlice: null,
        activeTask: null,
        registry: [],
        blockers: [],
      } as any;
    },
    rebuildState: async () => {},
    loadEffectiveGSDPreferences: () => undefined,
    preDispatchHealthGate: async () => ({ proceed: true, fixesApplied: [] }),
    syncProjectRootToWorktree: () => {},
    checkResourcesStale: () => null,
    validateSessionLock: () => ({ valid: true } as SessionLockStatus),
    updateSessionLock: () => {},
    handleLostSessionLock: () => {},
    sendDesktopNotification: () => {},
    setActiveMilestoneId: () => {},
    pruneQueueOrder: () => {},
    isInAutoWorktree: () => false,
    shouldUseWorktreeIsolation: () => false,
    mergeMilestoneToMain: () => ({ pushed: false, codeFilesChanged: false }),
    teardownAutoWorktree: () => {},
    createAutoWorktree: () => "/tmp/wt",
    captureIntegrationBranch: () => {},
    getIsolationMode: () => "none",
    getCurrentBranch: () => "main",
    autoWorktreeBranch: () => "auto/M001",
    resolveMilestoneFile: () => null,
    reconcileMergeState: () => "clean",
    preflightCleanRoot: () => ({ stashPushed: false, summary: "" }),
    postflightPopStash: () => {},
    getLedger: () => null,
    getProjectTotals: () => ({ cost: 0 }),
    formatCost: (c: number) => `$${c.toFixed(2)}`,
    getBudgetAlertLevel: () => 0,
    getNewBudgetAlertLevel: () => 0,
    getBudgetEnforcementAction: () => "none",
    getManifestStatus: async () => null,
    collectSecretsFromManifest: async () => null,
    resolveDispatch: async () => {
      callLog.push("resolveDispatch");
      return { action: "dispatch" as const, unitType: "execute-task", unitId: "M001/S01/T01", prompt: "unused" };
    },
    runPreDispatchHooks: () => ({ firedHooks: [], action: "proceed" }),
    getPriorSliceCompletionBlocker: () => null,
    getMainBranch: () => "main",
    closeoutUnit: async () => {},
    recordOutcome: () => {},
    writeLock: () => {},
    captureAvailableSkills: () => {},
    ensurePreconditions: () => {},
    updateSliceProgressCache: () => {},
    selectAndApplyModel: async () => ({ routing: null, appliedModel: null }),
    resolveModelId: () => undefined,
    startUnitSupervision: () => {},
    getDeepDiagnostic: () => null,
    isDbAvailable: () => false,
    reorderForCaching: (p: string) => p,
    existsSync: (p: string) => existsSync(p),
    readFileSync: () => "",
    atomicWriteSync: () => {},
    GitServiceImpl: class {} as any,
    resolver: {
      get workPath() { return "/tmp/project"; },
      get projectRoot() { return "/tmp/project"; },
      get lockPath() { return "/tmp/project"; },
      enterMilestone: () => {},
      exitMilestone: () => {},
      mergeAndExit: () => {},
      mergeAndEnterNext: () => {},
    } as any,
    postUnitPreVerification: async () => "continue" as const,
    runPostUnitVerification: async () => "continue" as const,
    postUnitPostVerification: async () => "continue" as const,
    getSessionFile: () => "/tmp/session.json",
    emitJournalEvent: (entry) => {
      callLog.push(`journal:${entry.eventType}`);
    },
  };

  return { ...baseDeps, ...overrides, callLog };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("Custom engine loop integration", () => {
  it("dispatches a 3-step workflow through autoLoop and all steps complete", async () => {
    _resetPendingResolve();

    // Create a real run directory with 3 steps: a → b → c
    const runDir = makeTmpDir();
    const graph = makeGraph([
      makeStep({ id: "step-a" }),
      makeStep({ id: "step-b", dependsOn: ["step-a"] }),
      makeStep({ id: "step-c", dependsOn: ["step-b"] }),
    ], "integ-test");
    writeGraph(runDir, graph);
    writeDefinition(runDir, graph.steps, "integ-test");

    const ctx = makeMockCtx();
    const pi = makeMockPi();

    let unitCount = 0;

    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir,
    });

    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      },
    });

    // Start autoLoop — it will block inside runUnit awaiting resolveAgentEnd
    const loopPromise = autoLoop(ctx, pi, s, deps);

    // Each iteration: the custom engine path derives state → resolves dispatch →
    // runs guards → runs runUnitPhase (which calls runUnit) → we resolve →
    // engine.reconcile marks the step complete → loop continues.
    // We need to resolve resolveAgentEnd for each step.

    // Step 1: step-a
    unitCount++;
    await resolveNextAgentEnd();

    // Step 2: step-b
    unitCount++;
    await resolveNextAgentEnd();

    // Step 3: step-c
    unitCount++;
    await resolveNextAgentEnd();

    // After step-c completes, engine.reconcile marks it complete, then
    // next deriveState sees isComplete=true → stopAuto → loop exits
    await loopPromise;

    // Verify GRAPH.yaml shows all 3 steps complete
    const finalGraph = readGraph(runDir);
    assert.equal(finalGraph.steps.length, 3, "Should have 3 steps");
    for (const step of finalGraph.steps) {
      assert.equal(step.status, "complete", `Step ${step.id} should be complete, got ${step.status}`);
      assert.ok(step.finishedAt, `Step ${step.id} should have finishedAt timestamp`);
    }

    // Verify exactly 3 units were dispatched (3 pi.sendMessage calls)
    assert.equal(pi.calls.length, 3, `Should have dispatched exactly 3 units, got ${pi.calls.length}`);

    // Verify the loop stopped because the workflow completed
    const stopEntry = deps.callLog.find((e: string) => e.startsWith("stopAuto:"));
    assert.ok(stopEntry, "stopAuto should have been called");
    assert.ok(
      stopEntry!.includes("Workflow complete"),
      `stopAuto reason should include "Workflow complete", got: ${stopEntry}`,
    );

    assert.equal(
      deps.callLog.filter((e: string) => e === "deriveState").length,
      3,
      "custom engine should stop immediately after a milestone-complete reconcile",
    );

    // Verify dev path was NOT used (resolveDispatch should not appear)
    assert.ok(
      !deps.callLog.includes("resolveDispatch"),
      "Custom engine path should skip resolveDispatch (dev path not taken)",
    );
  });

  it("stops when engine reports isComplete on first derive", async () => {
    _resetPendingResolve();

    // Create a run directory where all steps are already complete
    const runDir = makeTmpDir();
    const graph = makeGraph([
      makeStep({ id: "step-a", status: "complete" }),
    ], "already-done");
    writeGraph(runDir, graph);
    writeDefinition(runDir, graph.steps, "already-done");

    const ctx = makeMockCtx();
    const pi = makeMockPi();

    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir,
    });

    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      },
    });

    await autoLoop(ctx, pi, s, deps);

    // No units should have been dispatched
    assert.equal(pi.calls.length, 0, "Should not dispatch units for complete workflow");

    // Should stop with "Workflow complete" reason
    const stopEntry = deps.callLog.find((e: string) => e.startsWith("stopAuto:"));
    assert.ok(stopEntry?.includes("Workflow complete"), "Should stop with 'Workflow complete'");
  });

  it("does not call runPreDispatch or runFinalize on the custom path", async () => {
    _resetPendingResolve();

    // Single-step workflow
    const runDir = makeTmpDir();
    const graph = makeGraph([makeStep({ id: "only" })], "single");
    writeGraph(runDir, graph);
    writeDefinition(runDir, graph.steps, "single");

    const ctx = makeMockCtx();
    const pi = makeMockPi();

    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir,
    });

    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      },
      postUnitPreVerification: async () => {
        deps.callLog.push("postUnitPreVerification");
        return "continue" as const;
      },
      postUnitPostVerification: async () => {
        deps.callLog.push("postUnitPostVerification");
        return "continue" as const;
      },
    });

    const loopPromise = autoLoop(ctx, pi, s, deps);

    await resolveNextAgentEnd();

    await loopPromise;

    // Custom path should NOT call runFinalize's post-unit phases
    assert.ok(
      !deps.callLog.includes("postUnitPreVerification"),
      "Custom path should skip postUnitPreVerification (runFinalize not called)",
    );
    assert.ok(
      !deps.callLog.includes("postUnitPostVerification"),
      "Custom path should skip postUnitPostVerification (runFinalize not called)",
    );

    // Should NOT have called resolveDispatch (dev dispatch)
    assert.ok(
      !deps.callLog.includes("resolveDispatch"),
      "Custom path should skip resolveDispatch",
    );
  });

  it("respects dependency ordering — step-b waits for step-a", async () => {
    _resetPendingResolve();

    const runDir = makeTmpDir();
    // step-b depends on step-a, both pending
    const graph = makeGraph([
      makeStep({ id: "step-a" }),
      makeStep({ id: "step-b", dependsOn: ["step-a"] }),
    ], "dep-order");
    writeGraph(runDir, graph);
    writeDefinition(runDir, graph.steps, "dep-order");

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const dispatchedUnitIds: string[] = [];

    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir,
    });

    const originalSendMessage = pi.sendMessage;
    pi.sendMessage = (...args: unknown[]) => {
      // Track dispatched prompts to verify ordering
      const promptArg = args[0] as { content?: string };
      dispatchedUnitIds.push(promptArg?.content ?? "unknown");
      return originalSendMessage(...args);
    };

    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      },
    });

    const loopPromise = autoLoop(ctx, pi, s, deps);

    // Resolve step-a
    await resolveNextAgentEnd();

    // Resolve step-b
    await resolveNextAgentEnd();

    await loopPromise;

    // Verify step-a was dispatched before step-b
    assert.equal(dispatchedUnitIds.length, 2, "Should have dispatched 2 steps");
    assert.ok(
      dispatchedUnitIds[0].includes("Do step-a"),
      `First dispatch should be step-a, got: ${dispatchedUnitIds[0]}`,
    );
    assert.ok(
      dispatchedUnitIds[1].includes("Do step-b"),
      `Second dispatch should be step-b, got: ${dispatchedUnitIds[1]}`,
    );
  });

  it("stops custom workflow after repeated verification retries", async () => {
    _resetPendingResolve();

    const runDir = makeTmpDir();
    const graph = makeGraph([makeStep({ id: "retry-step" })], "retry-exhaustion");
    writeGraph(runDir, graph);
    writeFileSync(join(runDir, "DEFINITION.yaml"), stringify({
      version: 1,
      name: "retry-exhaustion",
      steps: [{
        id: "retry-step",
        name: "retry-step",
        prompt: "Do retry-step",
        produces: "retry-step/output.md",
        verify: { policy: "shell-command", command: "exit 1" },
      }],
    }));

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir,
    });
    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      },
    });

    const resolver = setInterval(() => {
      if (_hasPendingResolveForTest()) {
        resolveAgentEnd({ messages: [{ role: "assistant" }] });
      }
    }, 25);
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        autoLoop(ctx, pi, s, deps),
        new Promise((_, reject) =>
          timeout = setTimeout(() => {
            s.active = false;
            resolveAgentEnd({ messages: [{ role: "assistant" }] });
            reject(new Error(
              `autoLoop did not stop after verification retry exhaustion; calls=${pi.calls.length}; log=${deps.callLog.join(",")}`,
            ));
          }, 3_000),
        ),
      ]);
    } finally {
      clearInterval(resolver);
      if (timeout) clearTimeout(timeout);
    }

    assert.equal(pi.calls.length, 4, "verification retry should be capped after four dispatched attempts");
    const stopEntry = deps.callLog.find((e: string) => e.startsWith("stopAuto:"));
    assert.match(stopEntry ?? "", /requested retry 4 times without passing/);
    const finalGraph = readGraph(runDir);
    assert.equal(finalGraph.steps[0]?.status, "active", "failed verification must not reconcile the step complete");
  });

  it("persists custom verification retry budget across a session restart", async () => {
    _resetPendingResolve();

    const runDir = makeTmpDir();
    const graph = makeGraph([makeStep({ id: "retry-step" })], "retry-restart");
    writeGraph(runDir, graph);
    writeFileSync(join(runDir, "DEFINITION.yaml"), stringify({
      version: 1,
      name: "retry-restart",
      steps: [{
        id: "retry-step",
        name: "retry-step",
        prompt: "Do retry-step",
        produces: "retry-step/output.md",
        verify: { policy: "shell-command", command: "exit 1" },
      }],
    }));

    const ctx1 = makeMockCtx();
    const pi1 = makeMockPi();
    const s1 = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir,
    });
    const deps1 = makeMockDeps();
    const resolver1 = setInterval(() => {
      if (_hasPendingResolveForTest()) {
        resolveAgentEnd({ messages: [{ role: "assistant" }] });
      }
      if (pi1.calls.length >= 2) {
        s1.active = false;
      }
    }, 25);
    let timeout1: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        autoLoop(ctx1, pi1, s1, deps1),
        new Promise((_, reject) =>
          timeout1 = setTimeout(() => {
            s1.active = false;
            resolveAgentEnd({ messages: [{ role: "assistant" }] });
            reject(new Error(
              `first autoLoop did not pause after two retry attempts; calls=${pi1.calls.length}; log=${deps1.callLog.join(",")}`,
            ));
          }, 3_000),
        ),
      ]);
    } finally {
      clearInterval(resolver1);
      if (timeout1) clearTimeout(timeout1);
    }
    assert.equal(pi1.calls.length, 2, "first session should consume two retry attempts");
    assert.equal(
      deps1.callLog.some((e: string) => e.startsWith("stopAuto:")),
      false,
      "first session should stop because the session deactivated, not because retry budget exhausted",
    );

    _resetPendingResolve();
    const ctx2 = makeMockCtx();
    const pi2 = makeMockPi();
    const s2 = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir,
    });
    const deps2 = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps2.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s2.active = false;
      },
    });
    const resolver2 = setInterval(() => {
      if (_hasPendingResolveForTest()) {
        resolveAgentEnd({ messages: [{ role: "assistant" }] });
      }
    }, 25);
    let timeout2: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        autoLoop(ctx2, pi2, s2, deps2),
        new Promise((_, reject) =>
          timeout2 = setTimeout(() => {
            s2.active = false;
            resolveAgentEnd({ messages: [{ role: "assistant" }] });
            reject(new Error(
              `second autoLoop did not stop after persisted retry exhaustion; calls=${pi2.calls.length}; log=${deps2.callLog.join(",")}`,
            ));
          }, 3_000),
        ),
      ]);
    } finally {
      clearInterval(resolver2);
      if (timeout2) clearTimeout(timeout2);
    }

    assert.equal(pi2.calls.length, 2, "second session should exhaust after attempts 3 and 4");
    const stopEntry = deps2.callLog.find((e: string) => e.startsWith("stopAuto:"));
    assert.match(stopEntry ?? "", /requested retry 4 times without passing/);
  });

  it("two-step workflow drives both steps to complete and stops when isComplete fires", async () => {
    // Note (#4831): renamed from "GRAPH.yaml step stays pending when session
    // deactivates before reconcile" — the assertion body never proved the
    // pending-on-deactivate claim and even comments that "the reconcile
    // will still run for step-b". The behaviour this test actually pins is:
    // both steps reconcile complete and stopAuto fires once isComplete.
    _resetPendingResolve();

    // Two-step workflow: a → b. We will complete step-a, then force a break
    // during step-b's runUnitPhase (by returning cancelled status + deactivating).
    const runDir = makeTmpDir();
    const graph = makeGraph([
      makeStep({ id: "step-a" }),
      makeStep({ id: "step-b", dependsOn: ["step-a"] }),
    ], "failure-test");
    writeGraph(runDir, graph);
    writeDefinition(runDir, graph.steps, "failure-test");

    const ctx = makeMockCtx();
    const pi = makeMockPi();

    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir,
    });

    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      },
    });

    const loopPromise = autoLoop(ctx, pi, s, deps);

    // Resolve step-a successfully
    await resolveNextAgentEnd();

    // Step-b enters runUnit — deactivate the session before resolving.
    // runUnit checks s.active after newSession and returns cancelled if false.
    // But since newSession resolves synchronously in our mock (before the
    // active check), the unit still runs. Instead, let's just cancel it.
    // Resolve as cancelled to simulate a failed session
    await resolveNextAgentEnd();

    // The reconcile will still run for step-b in this flow since
    // runUnitPhase returns "next" (not "break") for completed units.
    // After both steps complete, the engine detects isComplete and stops.
    await loopPromise;

    // Both steps reconcile complete; the renamed expectation pins that the
    // engine drives the workflow through isComplete rather than leaving any
    // step pending.
    const finalGraph = readGraph(runDir);
    const stepA = finalGraph.steps.find(s => s.id === "step-a");
    const stepB = finalGraph.steps.find(s => s.id === "step-b");
    assert.equal(stepA?.status, "complete", "Step-a should be complete");
    assert.equal(stepB?.status, "complete", "Step-b should be complete");

    // The loop must stop once isComplete fires.
    assert.ok(
      deps.callLog.some((e: string) => e.startsWith("stopAuto:")),
      "stopAuto should have been called",
    );
  });
});
