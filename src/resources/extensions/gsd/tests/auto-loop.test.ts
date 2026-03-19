import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  resolveAgentEnd,
  runUnit,
  autoLoop,
  _resetPendingResolve,
  type UnitResult,
  type AgentEndEvent,
  type LoopDeps,
} from "../auto-loop.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(messages: unknown[] = [{ role: "assistant" }]): AgentEndEvent {
  return { messages };
}

/**
 * Build a minimal mock AutoSession with controllable newSession behavior.
 */
function makeMockSession(opts?: {
  newSessionResult?: { cancelled: boolean };
  newSessionThrows?: string;
  newSessionDelayMs?: number;
}) {
  return {
    active: true,
    verbose: false,
    cmdCtx: {
      newSession: () => {
        if (opts?.newSessionThrows) {
          return Promise.reject(new Error(opts.newSessionThrows));
        }
        const result = opts?.newSessionResult ?? { cancelled: false };
        const delay = opts?.newSessionDelayMs ?? 0;
        if (delay > 0) {
          return new Promise<{ cancelled: boolean }>((res) =>
            setTimeout(() => res(result), delay),
          );
        }
        return Promise.resolve(result);
      },
    },
    clearTimers: () => {},
  } as any;
}

/**
 * Build a minimal mock ExtensionContext.
 */
function makeMockCtx() {
  return {
    ui: { notify: () => {} },
    model: { id: "test-model" },
  } as any;
}

/**
 * Build a minimal mock ExtensionAPI that records sendMessage calls.
 */
function makeMockPi() {
  const calls: unknown[] = [];
  return {
    sendMessage: (...args: unknown[]) => { calls.push(args); },
    calls,
  } as any;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("resolveAgentEnd resolves a pending runUnit promise", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession();
  const event = makeEvent();

  // Start runUnit — it will create the promise and send a message,
  // then block awaiting agent_end
  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "do stuff", undefined);

  // Give the microtask queue a tick so runUnit reaches the await
  await new Promise((r) => setTimeout(r, 10));

  // Now resolve the agent_end
  resolveAgentEnd(event);

  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.deepEqual(result.event, event);
});

test("resolveAgentEnd is safe when no promise is pending (no-op)", () => {
  _resetPendingResolve();

  // Should not throw — just logs a debug warning
  assert.doesNotThrow(() => {
    resolveAgentEnd(makeEvent());
  });
});

test("double resolveAgentEnd only resolves once", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession();
  const event1 = makeEvent([{ id: 1 }]);
  const event2 = makeEvent([{ id: 2 }]);

  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt", undefined);

  await new Promise((r) => setTimeout(r, 10));

  // First resolve — should work
  resolveAgentEnd(event1);

  // Second resolve — should be a no-op (orphan)
  assert.doesNotThrow(() => {
    resolveAgentEnd(event2);
  });

  const result = await resultPromise;
  assert.equal(result.status, "completed");
  // Should have the first event, not the second
  assert.deepEqual(result.event, event1);
});

test("runUnit returns cancelled when session creation fails", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession({ newSessionThrows: "connection refused" });

  const result = await runUnit(ctx, pi, s, "task", "T01", "prompt", undefined);

  assert.equal(result.status, "cancelled");
  assert.equal(result.event, undefined);
  // sendMessage should NOT have been called
  assert.equal(pi.calls.length, 0);
});

test("runUnit returns cancelled when session creation times out", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  // Session returns cancelled: true (simulates the timeout race outcome)
  const s = makeMockSession({ newSessionResult: { cancelled: true } });

  const result = await runUnit(ctx, pi, s, "task", "T01", "prompt", undefined);

  assert.equal(result.status, "cancelled");
  assert.equal(result.event, undefined);
  assert.equal(pi.calls.length, 0);
});

test("runUnit returns cancelled when s.active is false before sendMessage", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession();
  s.active = false;

  const result = await runUnit(ctx, pi, s, "task", "T01", "prompt", undefined);

  assert.equal(result.status, "cancelled");
  assert.equal(pi.calls.length, 0);
});

// ─── Structural assertions ───────────────────────────────────────────────────

test("auto-loop.ts exports autoLoop, runUnit, resolveAgentEnd", async () => {
  const mod = await import("../auto-loop.js");
  assert.equal(typeof mod.autoLoop, "function", "autoLoop should be exported as a function");
  assert.equal(typeof mod.runUnit, "function", "runUnit should be exported as a function");
  assert.equal(typeof mod.resolveAgentEnd, "function", "resolveAgentEnd should be exported as a function");
});

test("auto-loop.ts contains a while keyword", () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "auto-loop.ts"),
    "utf-8",
  );
  assert.ok(src.includes("while"), "auto-loop.ts should contain a while keyword (loop or placeholder)");
});

test("auto-loop.ts one-shot pattern: pendingResolve is nulled before calling resolver", () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "auto-loop.ts"),
    "utf-8",
  );
  // The one-shot pattern requires: save ref, null the variable, then call
  // Look for the pattern: pendingResolve = null appearing before r(
  const resolveBlock = src.slice(
    src.indexOf("export function resolveAgentEnd"),
    src.indexOf("export function resolveAgentEnd") + 400,
  );
  const nullIdx = resolveBlock.indexOf("pendingResolve = null");
  const callIdx = resolveBlock.indexOf('r({');
  assert.ok(nullIdx > 0, "should null pendingResolve in resolveAgentEnd");
  assert.ok(callIdx > 0, "should call resolver in resolveAgentEnd");
  assert.ok(nullIdx < callIdx, "pendingResolve should be nulled before calling the resolver (one-shot)");
});

// ─── autoLoop tests (T02) ─────────────────────────────────────────────────

/**
 * Build a mock LoopDeps that tracks call order and allows controlling
 * behavior via overrides.
 */
function makeMockDeps(overrides?: Partial<LoopDeps>): LoopDeps & { callLog: string[] } {
  const callLog: string[] = [];

  const baseDeps: LoopDeps = {
    lockBase: () => "/tmp/test-lock",
    buildSnapshotOpts: () => ({}),
    stopAuto: async () => { callLog.push("stopAuto"); },
    pauseAuto: async () => { callLog.push("pauseAuto"); },
    clearUnitTimeout: () => {},
    updateProgressWidget: () => {},
    startDispatchGapWatchdog: () => {},
    invalidateAllCaches: () => { callLog.push("invalidateAllCaches"); },
    deriveState: async () => {
      callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test Milestone", status: "active" },
        activeSlice: { id: "S01", title: "Test Slice" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      } as any;
    },
    loadEffectiveGSDPreferences: () => ({ preferences: {} }),
    preDispatchHealthGate: async () => ({ proceed: true, fixesApplied: [] }),
    syncProjectRootToWorktree: () => {},
    checkResourcesStale: () => null,
    sendDesktopNotification: () => {},
    setActiveMilestoneId: () => {},
    pruneQueueOrder: () => {},
    isInAutoWorktree: () => false,
    shouldUseWorktreeIsolation: () => false,
    mergeMilestoneToMain: () => ({ pushed: false }),
    teardownAutoWorktree: () => {},
    createAutoWorktree: () => "/tmp/wt",
    captureIntegrationBranch: () => {},
    getIsolationMode: () => "none",
    getCurrentBranch: () => "main",
    autoWorktreeBranch: () => "auto/M001",
    resolveMilestoneFile: () => null,
    completedKeysPath: () => "/tmp/completed-keys.json",
    reconcileMergeState: () => false,
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
      return {
        action: "dispatch" as const,
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        prompt: "do the thing",
      };
    },
    runPreDispatchHooks: () => ({ firedHooks: [], action: "proceed" }),
    getPriorSliceCompletionBlocker: () => null,
    getMainBranch: () => "main",
    collectObservabilityWarnings: async () => [],
    buildObservabilityRepairBlock: () => null,
    checkIdempotency: () => {
      callLog.push("checkIdempotency");
      return { action: "proceed" };
    },
    checkStuckAndRecover: async () => {
      callLog.push("checkStuckAndRecover");
      return { action: "proceed" };
    },
    closeoutUnit: async () => {},
    verifyExpectedArtifact: () => true,
    persistCompletedKey: () => {},
    clearUnitRuntimeRecord: () => {},
    writeUnitRuntimeRecord: () => {},
    recordOutcome: () => {},
    writeLock: () => {},
    captureAvailableSkills: () => {},
    ensurePreconditions: () => {},
    updateSliceProgressCache: () => {},
    selectAndApplyModel: async () => ({ routing: null }),
    startUnitSupervision: () => {},
    getDeepDiagnostic: () => null,
    isDbAvailable: () => false,
    reorderForCaching: (p: string) => p,
    existsSync: () => false,
    readFileSync: () => "",
    atomicWriteSync: () => {},
    GitServiceImpl: class {} as any,
    postUnitPreVerification: async () => {
      callLog.push("postUnitPreVerification");
      return "continue" as const;
    },
    runPostUnitVerification: async () => {
      callLog.push("runPostUnitVerification");
      return "continue" as const;
    },
    postUnitPostVerification: async () => {
      callLog.push("postUnitPostVerification");
      return "continue" as const;
    },
    getSessionFile: () => "/tmp/session.json",
  };

  const merged = { ...baseDeps, ...overrides, callLog };
  return merged;
}

/**
 * Build a mock session for autoLoop testing — needs more fields than the
 * runUnit mock (dispatch counters, milestone state, etc.).
 */
function makeLoopSession(overrides?: Partial<Record<string, unknown>>) {
  return {
    active: true,
    verbose: false,
    stepMode: false,
    paused: false,
    basePath: "/tmp/project",
    originalBasePath: "",
    currentMilestoneId: "M001",
    currentUnit: null,
    currentUnitRouting: null,
    completedUnits: [],
    completedKeySet: new Set<string>(),
    skipDepth: 0,
    resourceVersionOnStart: null,
    lastPromptCharCount: undefined,
    lastBaselineCharCount: undefined,
    lastBudgetAlertLevel: 0,
    pendingVerificationRetry: null,
    pendingCrashRecovery: null,
    pendingQuickTasks: [],
    dispatching: false,
    handlingAgentEnd: false,
    pendingAgentEndRetry: false,
    autoModeStartModel: null,
    unitDispatchCount: new Map<string, number>(),
    unitLifetimeDispatches: new Map<string, number>(),
    unitRecoveryCount: new Map<string, number>(),
    unitConsecutiveSkips: new Map<string, number>(),
    recentlyEvictedKeys: new Set<string>(),
    verificationRetryCount: new Map<string, number>(),
    gitService: null,
    autoStartTime: Date.now(),
    cmdCtx: {
      newSession: () => Promise.resolve({ cancelled: false }),
      getContextUsage: () => ({ percent: 10, tokens: 1000, limit: 10000 }),
    },
    clearTimers: () => {},
    ...overrides,
  } as any;
}

test("autoLoop exits when s.active is set to false", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession({ active: false });

  const deps = makeMockDeps();
  await autoLoop(ctx, pi, s, deps);

  // Loop body should not have executed (deriveState never called)
  assert.ok(!deps.callLog.includes("deriveState"), "loop should not have iterated");
});

test("autoLoop exits on terminal complete state", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();

  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "complete",
        activeMilestone: { id: "M001", title: "Test", status: "complete" },
        activeSlice: null,
        activeTask: null,
        registry: [{ id: "M001", status: "complete" }],
        blockers: [],
      } as any;
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.ok(deps.callLog.includes("deriveState"), "should have derived state");
  assert.ok(deps.callLog.includes("stopAuto"), "should have called stopAuto for complete state");
  // Should NOT have dispatched a unit
  assert.ok(!deps.callLog.includes("resolveDispatch"), "should not dispatch when complete");
});

test("autoLoop exits on terminal blocked state", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();

  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "blocked",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: null,
        activeTask: null,
        registry: [{ id: "M001", status: "active" }],
        blockers: ["Missing API key"],
      } as any;
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.ok(deps.callLog.includes("deriveState"), "should have derived state");
  assert.ok(deps.callLog.includes("stopAuto"), "should have called stopAuto for blocked state");
  assert.ok(!deps.callLog.includes("resolveDispatch"), "should not dispatch when blocked");
});

test("autoLoop calls deriveState → resolveDispatch → runUnit in sequence", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();

  let loopCount = 0;
  const s = makeLoopSession();

  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      } as any;
    },
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      return {
        action: "dispatch" as const,
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        prompt: "do the thing",
      };
    },
    postUnitPostVerification: async () => {
      deps.callLog.push("postUnitPostVerification");
      loopCount++;
      // After first iteration, deactivate to exit the loop
      if (loopCount >= 1) {
        s.active = false;
      }
      return "continue" as const;
    },
  });

  // Run autoLoop — it will call runUnit internally which creates a promise.
  // We need to resolve the promise from outside via resolveAgentEnd.
  const loopPromise = autoLoop(ctx, pi, s, deps);

  // Give the loop time to reach runUnit's await
  await new Promise(r => setTimeout(r, 50));

  // Resolve the first unit's agent_end
  resolveAgentEnd(makeEvent());

  await loopPromise;

  // Verify the sequence: deriveState → resolveDispatch → then finalize callbacks
  const deriveIdx = deps.callLog.indexOf("deriveState");
  const dispatchIdx = deps.callLog.indexOf("resolveDispatch");
  const preVerIdx = deps.callLog.indexOf("postUnitPreVerification");
  const verIdx = deps.callLog.indexOf("runPostUnitVerification");
  const postVerIdx = deps.callLog.indexOf("postUnitPostVerification");

  assert.ok(deriveIdx >= 0, "deriveState should have been called");
  assert.ok(dispatchIdx > deriveIdx, "resolveDispatch should come after deriveState");
  assert.ok(preVerIdx > dispatchIdx, "postUnitPreVerification should come after resolveDispatch");
  assert.ok(verIdx > preVerIdx, "runPostUnitVerification should come after pre-verification");
  assert.ok(postVerIdx > verIdx, "postUnitPostVerification should come after verification");
});

test("autoLoop handles verification retry by continuing loop", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();

  let verifyCallCount = 0;
  let deriveCallCount = 0;
  const s = makeLoopSession();

  const deps = makeMockDeps({
    deriveState: async () => {
      deriveCallCount++;
      deps.callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      } as any;
    },
    runPostUnitVerification: async () => {
      verifyCallCount++;
      deps.callLog.push("runPostUnitVerification");
      if (verifyCallCount === 1) {
        // First call: simulate retry — set pendingVerificationRetry on session
        s.pendingVerificationRetry = {
          unitId: "M001/S01/T01",
          failureContext: "test failed: expected X got Y",
          attempt: 1,
        };
        return "retry" as const;
      }
      // Second call: pass
      return "continue" as const;
    },
    postUnitPostVerification: async () => {
      deps.callLog.push("postUnitPostVerification");
      // After the retry cycle completes, deactivate
      s.active = false;
      return "continue" as const;
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);

  // First iteration: runUnit → verification returns "retry" → loop continues
  await new Promise(r => setTimeout(r, 50));
  resolveAgentEnd(makeEvent()); // resolve first unit

  // Second iteration: runUnit → verification returns "continue"
  await new Promise(r => setTimeout(r, 50));
  resolveAgentEnd(makeEvent()); // resolve retry unit

  await loopPromise;

  // Verify deriveState was called twice (two iterations)
  const deriveCount = deps.callLog.filter(c => c === "deriveState").length;
  assert.ok(deriveCount >= 2, `deriveState should be called at least 2 times (got ${deriveCount})`);

  // Verify verification was called twice
  assert.equal(verifyCallCount, 2, "verification should have been called twice (once retry, once pass)");
});

test("autoLoop handles dispatch stop action", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();

  const deps = makeMockDeps({
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      return {
        action: "stop" as const,
        reason: "test-stop-reason",
        level: "info" as const,
      };
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.ok(deps.callLog.includes("resolveDispatch"), "should have called resolveDispatch");
  assert.ok(deps.callLog.includes("stopAuto"), "should have stopped on dispatch stop action");
});

test("autoLoop handles dispatch skip action by continuing", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();

  let dispatchCallCount = 0;
  const deps = makeMockDeps({
    resolveDispatch: async () => {
      dispatchCallCount++;
      deps.callLog.push("resolveDispatch");
      if (dispatchCallCount === 1) {
        return { action: "skip" as const };
      }
      // Second time: stop to exit the loop
      return { action: "stop" as const, reason: "done", level: "info" as const };
    },
  });

  await autoLoop(ctx, pi, s, deps);

  // Should have called resolveDispatch twice (skip → re-derive → stop)
  const dispatchCalls = deps.callLog.filter(c => c === "resolveDispatch");
  assert.equal(dispatchCalls.length, 2, "resolveDispatch should be called twice (skip then stop)");
  const deriveCalls = deps.callLog.filter(c => c === "deriveState");
  assert.ok(deriveCalls.length >= 2, "deriveState should be called at least twice (one per iteration)");
});

test("autoLoop handles inline dispatch from postUnitPostVerification", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  const s = makeLoopSession();

  let postVerCallCount = 0;
  const deps = makeMockDeps({
    postUnitPostVerification: async () => {
      postVerCallCount++;
      deps.callLog.push("postUnitPostVerification");
      if (postVerCallCount === 1) {
        // First call (main unit): inline dispatch happened
        return "dispatched" as const;
      }
      // Second call (inline unit completed): done
      s.active = false;
      return "continue" as const;
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);

  // Wait for main unit's runUnit to be awaiting
  await new Promise(r => setTimeout(r, 50));
  resolveAgentEnd(makeEvent()); // resolve main unit

  // Wait for the inline dispatch's promise to be created
  await new Promise(r => setTimeout(r, 50));
  resolveAgentEnd(makeEvent()); // resolve inline unit

  await loopPromise;

  // postUnitPostVerification should have been called twice
  assert.equal(postVerCallCount, 2, "postUnitPostVerification should be called twice (main + inline)");
});

test("autoLoop exits when no active milestone found", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession({ currentMilestoneId: null });

  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: null,
        activeSlice: null,
        activeTask: null,
        registry: [],
        blockers: [],
      } as any;
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.ok(deps.callLog.includes("stopAuto"), "should stop when no milestone and all complete");
});

test("autoLoop exports LoopDeps type", async () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "auto-loop.ts"),
    "utf-8",
  );
  assert.ok(src.includes("export interface LoopDeps"), "auto-loop.ts should export LoopDeps interface");
});

test("autoLoop signature accepts deps parameter", async () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "auto-loop.ts"),
    "utf-8",
  );
  assert.ok(
    src.includes("deps: LoopDeps"),
    "autoLoop should accept a deps: LoopDeps parameter",
  );
});

test("autoLoop contains while (s.active) loop", () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "auto-loop.ts"),
    "utf-8",
  );
  assert.ok(
    src.includes("while (s.active)"),
    "autoLoop should contain a while (s.active) loop",
  );
});
