import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  resolveAgentEnd,
  runUnit,
  autoLoop,
  _resetPendingResolve,
  _setActiveSession,
  isSessionSwitchInFlight,
  type UnitResult,
  type AgentEndEvent,
  type LoopDeps,
} from "../auto-loop.js";
import type { SessionLockStatus } from "../session-lock.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(
  messages: unknown[] = [{ role: "assistant" }],
): AgentEndEvent {
  return { messages };
}

/**
 * Build a minimal mock AutoSession with controllable newSession behavior.
 */
function makeMockSession(opts?: {
  newSessionResult?: { cancelled: boolean };
  newSessionThrows?: string;
  newSessionDelayMs?: number;
  onNewSessionStart?: (session: any) => void;
  onNewSessionSettle?: (session: any) => void;
}) {
  const session = {
    active: true,
    verbose: false,
    sessionSwitchInFlight: false,
    pendingResolve: null,
    pendingAgentEndQueue: [],
    cmdCtx: {
      newSession: () => {
        opts?.onNewSessionStart?.(session);
        if (opts?.newSessionThrows) {
          return Promise.reject(new Error(opts.newSessionThrows));
        }
        const result = opts?.newSessionResult ?? { cancelled: false };
        const delay = opts?.newSessionDelayMs ?? 0;
        if (delay > 0) {
          return new Promise<{ cancelled: boolean }>((res) =>
            setTimeout(() => {
              opts?.onNewSessionSettle?.(session);
              res(result);
            }, delay),
          );
        }
        opts?.onNewSessionSettle?.(session);
        return Promise.resolve(result);
      },
    },
    clearTimers: () => {},
  } as any;
  return session;
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
    sendMessage: (...args: unknown[]) => {
      calls.push(args);
    },
    calls,
  } as any;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("resolveAgentEnd resolves a pending runUnit promise", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession();
  _setActiveSession(s);
  const event = makeEvent();

  // Start runUnit — it will create the promise and send a message,
  // then block awaiting agent_end
  const resultPromise = runUnit(
    ctx,
    pi,
    s,
    "task",
    "T01",
    "do stuff",
    undefined,
  );

  // Give the microtask queue a tick so runUnit reaches the await
  await new Promise((r) => setTimeout(r, 10));

  // Now resolve the agent_end
  resolveAgentEnd(event);

  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.deepEqual(result.event, event);
});

test("resolveAgentEnd queues event when no promise is pending", () => {
  _resetPendingResolve();
  const s = makeMockSession();
  _setActiveSession(s);

  // Should not throw — queues the event for the next runUnit
  assert.doesNotThrow(() => {
    resolveAgentEnd(makeEvent());
  });
  assert.equal(s.pendingAgentEndQueue.length, 1, "event should be queued");
});

test("double resolveAgentEnd only resolves once (second is queued)", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession();
  _setActiveSession(s);
  const event1 = makeEvent([{ id: 1 }]);
  const event2 = makeEvent([{ id: 2 }]);

  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt", undefined);

  await new Promise((r) => setTimeout(r, 10));

  // First resolve — should work
  resolveAgentEnd(event1);

  // Second resolve — should be queued (no pending promise)
  assert.doesNotThrow(() => {
    resolveAgentEnd(event2);
  });
  assert.equal(
    s.pendingAgentEndQueue.length,
    1,
    "second event should be queued",
  );

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

test("runUnit only arms pendingResolve after newSession completes", async () => {
  _resetPendingResolve();

  let sawSwitchFlag = false;
  let sawPendingResolve: unknown = "unset";

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession({
    newSessionDelayMs: 20,
    onNewSessionStart: (session) => {
      sawSwitchFlag = session.sessionSwitchInFlight;
      sawPendingResolve = session.pendingResolve;
    },
  });
  _setActiveSession(s);

  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt", undefined);

  await new Promise((r) => setTimeout(r, 30));

  assert.equal(sawSwitchFlag, true, "session switch guard should be active during newSession");
  assert.equal(sawPendingResolve, null, "pendingResolve should not be armed before newSession completes");
  assert.equal(isSessionSwitchInFlight(), false, "session switch guard should clear after newSession settles");

  resolveAgentEnd(makeEvent());

  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.equal(pi.calls.length, 1);
});

// ─── Structural assertions ───────────────────────────────────────────────────

test("auto-loop.ts exports autoLoop, runUnit, resolveAgentEnd", async () => {
  const mod = await import("../auto-loop.js");
  assert.equal(
    typeof mod.autoLoop,
    "function",
    "autoLoop should be exported as a function",
  );
  assert.equal(
    typeof mod.runUnit,
    "function",
    "runUnit should be exported as a function",
  );
  assert.equal(
    typeof mod.resolveAgentEnd,
    "function",
    "resolveAgentEnd should be exported as a function",
  );
});

test("auto-loop.ts contains a while keyword", () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "auto-loop.ts"),
    "utf-8",
  );
  assert.ok(
    src.includes("while"),
    "auto-loop.ts should contain a while keyword (loop or placeholder)",
  );
});

test("auto-loop.ts one-shot pattern: pendingResolve is nulled before calling resolver", () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "auto-loop.ts"),
    "utf-8",
  );
  // The one-shot pattern requires: save ref, null the variable, then call
  // Look for the pattern: s.pendingResolve = null appearing before r(
  const resolveBlock = src.slice(
    src.indexOf("export function resolveAgentEnd"),
    src.indexOf("export function resolveAgentEnd") + 600,
  );
  const nullIdx = resolveBlock.indexOf("pendingResolve = null");
  const callIdx = resolveBlock.indexOf("r({");
  assert.ok(nullIdx > 0, "should null pendingResolve in resolveAgentEnd");
  assert.ok(callIdx > 0, "should call resolver in resolveAgentEnd");
  assert.ok(
    nullIdx < callIdx,
    "pendingResolve should be nulled before calling the resolver (one-shot)",
  );
});

// ─── autoLoop tests (T02) ─────────────────────────────────────────────────

/**
 * Build a mock LoopDeps that tracks call order and allows controlling
 * behavior via overrides.
 */
function makeMockDeps(
  overrides?: Partial<LoopDeps>,
): LoopDeps & { callLog: string[] } {
  const callLog: string[] = [];

  const baseDeps: LoopDeps = {
    lockBase: () => "/tmp/test-lock",
    buildSnapshotOpts: () => ({}),
    stopAuto: async () => {
      callLog.push("stopAuto");
    },
    pauseAuto: async () => {
      callLog.push("pauseAuto");
    },
    clearUnitTimeout: () => {},
    updateProgressWidget: () => {},
    syncCmuxSidebar: () => {},
    logCmuxEvent: () => {},
    invalidateAllCaches: () => {
      callLog.push("invalidateAllCaches");
    },
    deriveState: async () => {
      callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: {
          id: "M001",
          title: "Test Milestone",
          status: "active",
        },
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
    validateSessionLock: () => ({ valid: true } as SessionLockStatus),
    updateSessionLock: () => {
      callLog.push("updateSessionLock");
    },
    handleLostSessionLock: () => {
      callLog.push("handleLostSessionLock");
    },
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
    closeoutUnit: async () => {},
    verifyExpectedArtifact: () => true,
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
    resolver: {
      get workPath() {
        return "/tmp/project";
      },
      get projectRoot() {
        return "/tmp/project";
      },
      get lockPath() {
        return "/tmp/project";
      },
      enterMilestone: () => {},
      exitMilestone: () => {},
      mergeAndExit: () => {},
      mergeAndEnterNext: () => {},
    } as any,
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
    resourceVersionOnStart: null,
    lastPromptCharCount: undefined,
    lastBaselineCharCount: undefined,
    lastBudgetAlertLevel: 0,
    pendingVerificationRetry: null,
    pendingCrashRecovery: null,
    pendingQuickTasks: [],
    sidecarQueue: [],
    autoModeStartModel: null,
    pendingResolve: null,
    pendingAgentEndQueue: [],
    unitDispatchCount: new Map<string, number>(),
    unitLifetimeDispatches: new Map<string, number>(),
    unitRecoveryCount: new Map<string, number>(),
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
  assert.ok(
    !deps.callLog.includes("deriveState"),
    "loop should not have iterated",
  );
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
  assert.ok(
    deps.callLog.includes("stopAuto"),
    "should have called stopAuto for complete state",
  );
  // Should NOT have dispatched a unit
  assert.ok(
    !deps.callLog.includes("resolveDispatch"),
    "should not dispatch when complete",
  );
});

test("autoLoop passes structured session-lock failure details to the handler", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();
  let observedLockStatus: SessionLockStatus | undefined;

  const deps = makeMockDeps({
    validateSessionLock: () =>
      ({
        valid: false,
        failureReason: "compromised",
        expectedPid: process.pid,
      }) as SessionLockStatus,
    handleLostSessionLock: (_ctx, lockStatus) => {
      observedLockStatus = lockStatus;
      deps.callLog.push("handleLostSessionLock");
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.deepEqual(observedLockStatus, {
    valid: false,
    failureReason: "compromised",
    expectedPid: process.pid,
  });
  assert.ok(
    !deps.callLog.includes("resolveDispatch"),
    "should stop before dispatch after lock validation fails",
  );
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
  assert.ok(
    deps.callLog.includes("stopAuto"),
    "should have called stopAuto for blocked state",
  );
  assert.ok(
    !deps.callLog.includes("resolveDispatch"),
    "should not dispatch when blocked",
  );
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
  await new Promise((r) => setTimeout(r, 50));

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
  assert.ok(
    dispatchIdx > deriveIdx,
    "resolveDispatch should come after deriveState",
  );
  assert.ok(
    preVerIdx > dispatchIdx,
    "postUnitPreVerification should come after resolveDispatch",
  );
  assert.ok(
    verIdx > preVerIdx,
    "runPostUnitVerification should come after pre-verification",
  );
  assert.ok(
    postVerIdx > verIdx,
    "postUnitPostVerification should come after verification",
  );
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
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd(makeEvent()); // resolve first unit

  // Second iteration: runUnit → verification returns "continue"
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd(makeEvent()); // resolve retry unit

  await loopPromise;

  // Verify deriveState was called twice (two iterations)
  const deriveCount = deps.callLog.filter((c) => c === "deriveState").length;
  assert.ok(
    deriveCount >= 2,
    `deriveState should be called at least 2 times (got ${deriveCount})`,
  );

  // Verify verification was called twice
  assert.equal(
    verifyCallCount,
    2,
    "verification should have been called twice (once retry, once pass)",
  );
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

  assert.ok(
    deps.callLog.includes("resolveDispatch"),
    "should have called resolveDispatch",
  );
  assert.ok(
    deps.callLog.includes("stopAuto"),
    "should have stopped on dispatch stop action",
  );
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
      return {
        action: "stop" as const,
        reason: "done",
        level: "info" as const,
      };
    },
  });

  await autoLoop(ctx, pi, s, deps);

  // Should have called resolveDispatch twice (skip → re-derive → stop)
  const dispatchCalls = deps.callLog.filter((c) => c === "resolveDispatch");
  assert.equal(
    dispatchCalls.length,
    2,
    "resolveDispatch should be called twice (skip then stop)",
  );
  const deriveCalls = deps.callLog.filter((c) => c === "deriveState");
  assert.ok(
    deriveCalls.length >= 2,
    "deriveState should be called at least twice (one per iteration)",
  );
});

test("autoLoop drains sidecar queue after postUnitPostVerification enqueues items", async (t) => {
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
        // First call (main unit): enqueue a sidecar item
        s.sidecarQueue.push({
          kind: "hook" as const,
          unitType: "hook/review",
          unitId: "M001/S01/T01/review",
          prompt: "review the code",
        });
        return "continue" as const;
      }
      // Second call (sidecar unit completed): done
      s.active = false;
      return "continue" as const;
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);

  // Wait for main unit's runUnit to be awaiting
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd(makeEvent()); // resolve main unit

  // Wait for the sidecar unit's runUnit to be awaiting
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd(makeEvent()); // resolve sidecar unit

  await loopPromise;

  // postUnitPostVerification should have been called twice (main + sidecar)
  assert.equal(
    postVerCallCount,
    2,
    "postUnitPostVerification should be called twice (main + sidecar)",
  );
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

  assert.ok(
    deps.callLog.includes("stopAuto"),
    "should stop when no milestone and all complete",
  );
});

test("autoLoop exports LoopDeps type", async () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "auto-loop.ts"),
    "utf-8",
  );
  assert.ok(
    src.includes("export interface LoopDeps"),
    "auto-loop.ts should export LoopDeps interface",
  );
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

// ── T03: End-to-end wiring structural assertions ─────────────────────────────

test("auto-loop.ts exports autoLoop, runUnit, and resolveAgentEnd", () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "auto-loop.ts"),
    "utf-8",
  );
  assert.ok(
    src.includes("export async function autoLoop"),
    "must export autoLoop",
  );
  assert.ok(
    src.includes("export async function runUnit"),
    "must export runUnit",
  );
  assert.ok(
    src.includes("export function resolveAgentEnd"),
    "must export resolveAgentEnd",
  );
});

test("auto.ts startAuto calls autoLoop (not dispatchNextUnit as first dispatch)", () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "auto.ts"),
    "utf-8",
  );
  // Find the startAuto function body
  const fnIdx = src.indexOf("export async function startAuto");
  assert.ok(fnIdx > -1, "startAuto must exist in auto.ts");
  const fnEnd = src.indexOf("\n// ─── ", fnIdx + 100);
  const fnBlock =
    fnEnd > -1 ? src.slice(fnIdx, fnEnd) : src.slice(fnIdx, fnIdx + 5000);
  assert.ok(
    fnBlock.includes("autoLoop("),
    "startAuto must call autoLoop() instead of dispatchNextUnit()",
  );
});

test("index.ts agent_end handler calls resolveAgentEnd (not handleAgentEnd)", () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "index.ts"),
    "utf-8",
  );
  // Find the agent_end handler success path
  const handlerIdx = src.indexOf('pi.on("agent_end"');
  assert.ok(handlerIdx > -1, "index.ts must have an agent_end handler");
  const handlerBlock = src.slice(handlerIdx, handlerIdx + 10000);
  assert.ok(
    handlerBlock.includes("resolveAgentEnd(event)"),
    "agent_end success path must call resolveAgentEnd(event) instead of handleAgentEnd(ctx, pi)",
  );
  assert.ok(
    handlerBlock.includes("isSessionSwitchInFlight()"),
    "agent_end handler must ignore session-switch agent_end events from cmdCtx.newSession()",
  );
});

test("auto-verification.ts runPostUnitVerification does not take dispatchNextUnit callback", () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "auto-verification.ts"),
    "utf-8",
  );
  const fnIdx = src.indexOf("export async function runPostUnitVerification");
  assert.ok(fnIdx > -1, "runPostUnitVerification must exist");
  const sigEnd = src.indexOf("): Promise<VerificationResult>", fnIdx);
  const signature = src.slice(fnIdx, sigEnd);
  assert.ok(
    !signature.includes("dispatchNextUnit"),
    "runPostUnitVerification must not take a dispatchNextUnit callback parameter",
  );
  assert.ok(
    !signature.includes("startDispatchGapWatchdog"),
    "runPostUnitVerification must not take a startDispatchGapWatchdog callback parameter",
  );
});

test("auto-timeout-recovery.ts calls resolveAgentEnd instead of dispatchNextUnit", () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "auto-timeout-recovery.ts"),
    "utf-8",
  );
  assert.ok(
    !src.includes("await dispatchNextUnit"),
    "auto-timeout-recovery.ts must not call dispatchNextUnit",
  );
  assert.ok(
    src.includes("resolveAgentEnd("),
    "auto-timeout-recovery.ts must call resolveAgentEnd to re-iterate the loop on timeout recovery",
  );
});

test("handleAgentEnd in auto.ts is a thin wrapper calling resolveAgentEnd", () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "auto.ts"),
    "utf-8",
  );
  const fnIdx = src.indexOf("export async function handleAgentEnd");
  assert.ok(fnIdx > -1, "handleAgentEnd must exist");
  const fnEnd = src.indexOf("\n// ─── ", fnIdx + 100);
  const fnBlock =
    fnEnd > -1 ? src.slice(fnIdx, fnEnd) : src.slice(fnIdx, fnIdx + 1000);
  assert.ok(
    fnBlock.includes("resolveAgentEnd("),
    "handleAgentEnd must call resolveAgentEnd",
  );
  // The function should be short — no reentrancy guard, no verification, no dispatch
  assert.ok(
    !fnBlock.includes("dispatchNextUnit"),
    "handleAgentEnd must not call dispatchNextUnit (it's now a thin wrapper)",
  );
  assert.ok(
    !fnBlock.includes("postUnitPreVerification") &&
      !fnBlock.includes("postUnitPostVerification"),
    "handleAgentEnd must not contain verification logic (moved to autoLoop)",
  );
});

// ── Stuck counter tests ──────────────────────────────────────────────────────

test("stuck counter: stops when deriveState returns same unit 5 consecutive times", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.ui.notify = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();

  let stopReason = "";
  const deps = makeMockDeps({
    deriveState: async () =>
      ({
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      }) as any,
    resolveDispatch: async () => ({
      action: "dispatch" as const,
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "do the thing",
    }),
    stopAuto: async (_ctx?: any, _pi?: any, reason?: string) => {
      deps.callLog.push("stopAuto");
      stopReason = reason ?? "";
      s.active = false;
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);

  // The loop will dispatch the same unit each iteration. On iteration 1, sameUnitCount
  // starts at 0 and the unit key is set. On iterations 2-5, sameUnitCount increments.
  // At sameUnitCount=5 (iteration 6), stopAuto is called.
  // Each iteration requires resolving an agent_end event.
  // But the stuck counter fires BEFORE runUnit, so we only need to resolve 4 times
  // (iterations 1-4 each run a unit, iteration 5 increments to 5 and stops).

  // Actually: iteration 1 sets lastDerivedUnit (sameUnitCount=0).
  // Iteration 2: derivedKey === lastDerivedUnit → sameUnitCount=1.
  // Iteration 3: sameUnitCount=2. Iteration 4: sameUnitCount=3.
  // Iteration 5: sameUnitCount=4. Iteration 6: sameUnitCount=5 → stop.
  // So we need to resolve 5 agent_end events (iterations 1-5 each run a unit).

  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 30));
    resolveAgentEnd(makeEvent());
  }

  await loopPromise;

  assert.ok(
    deps.callLog.includes("stopAuto"),
    "stopAuto should have been called",
  );
  assert.ok(
    stopReason.includes("Stuck"),
    `stop reason should mention 'Stuck', got: ${stopReason}`,
  );
  assert.ok(
    stopReason.includes("execute-task"),
    "stop reason should include unitType",
  );
  assert.ok(
    stopReason.includes("M001/S01/T01"),
    "stop reason should include unitId",
  );
});

test("stuck counter: resets when deriveState returns a different unit", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.ui.notify = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();

  let deriveCallCount = 0;
  let stopCalled = false;

  const deps = makeMockDeps({
    deriveState: async () => {
      deriveCallCount++;
      deps.callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: deriveCallCount <= 3 ? "T01" : "T02" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      } as any;
    },
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      // Return dispatch matching the task from deriveState
      const taskId = deriveCallCount <= 3 ? "T01" : "T02";
      return {
        action: "dispatch" as const,
        unitType: "execute-task",
        unitId: `M001/S01/${taskId}`,
        prompt: "do the thing",
      };
    },
    stopAuto: async (_ctx?: any, _pi?: any, reason?: string) => {
      deps.callLog.push("stopAuto");
      stopCalled = true;
      s.active = false;
    },
    postUnitPostVerification: async () => {
      deps.callLog.push("postUnitPostVerification");
      // After 4th iteration (unit changed on iter 4), exit
      if (deriveCallCount >= 4) {
        s.active = false;
      }
      return "continue" as const;
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);

  // Resolve agent_end for iterations 1-4
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 30));
    resolveAgentEnd(makeEvent());
  }

  await loopPromise;

  // The counter should have reset when T02 was derived — no stuck stop
  assert.ok(
    !stopCalled,
    "stopAuto should NOT have been called — counter reset on unit change",
  );
  assert.ok(
    deriveCallCount >= 4,
    `deriveState should have been called at least 4 times (got ${deriveCallCount})`,
  );
});

test("stuck counter: does not increment during verification retry", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.ui.notify = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();

  let verifyCallCount = 0;
  let stopReason = "";

  const deps = makeMockDeps({
    deriveState: async () =>
      ({
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      }) as any,
    resolveDispatch: async () => ({
      action: "dispatch" as const,
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "do the thing",
    }),
    runPostUnitVerification: async () => {
      verifyCallCount++;
      deps.callLog.push("runPostUnitVerification");
      if (verifyCallCount <= 3) {
        // Set pendingVerificationRetry — should prevent stuck counter increment
        s.pendingVerificationRetry = {
          unitId: "M001/S01/T01",
          failureContext: "test failed",
          attempt: verifyCallCount,
        };
        return "retry" as const;
      }
      // After 3 retries, exit gracefully
      s.active = false;
      return "continue" as const;
    },
    stopAuto: async (_ctx?: any, _pi?: any, reason?: string) => {
      deps.callLog.push("stopAuto");
      stopReason = reason ?? "";
      s.active = false;
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);

  // Resolve agent_end for 4 iterations (1 initial + 3 retries)
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 30));
    resolveAgentEnd(makeEvent());
  }

  await loopPromise;

  // Even though same unit was derived 4 times, verification retries should
  // not count, so stuck counter should not have fired
  assert.ok(
    !stopReason.includes("Stuck"),
    `stuck counter should not fire during verification retries, got: ${stopReason}`,
  );
  assert.equal(
    verifyCallCount,
    4,
    "verification should have been called 4 times (1 initial + 3 retries)",
  );
});

test("stuck counter: logs debug output with stuck-detected phase", () => {
  // Structural test: verify the auto-loop.ts source contains both
  // stuck-detected and stuck-counter-reset debug log phases
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "auto-loop.ts"),
    "utf-8",
  );
  assert.ok(
    src.includes('"stuck-detected"'),
    "auto-loop.ts must log phase: 'stuck-detected' when stuck counter fires",
  );
  assert.ok(
    src.includes('"stuck-counter-reset"'),
    "auto-loop.ts must log phase: 'stuck-counter-reset' when counter resets on new unit",
  );
  assert.ok(
    src.includes("sameUnitCount"),
    "auto-loop.ts must track sameUnitCount for stuck detection",
  );
});

// ── Lifecycle test (S05/T02) ─────────────────────────────────────────────────

test("autoLoop lifecycle: advances through research → plan → execute → verify → complete across iterations", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.ui.notify = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  const s = makeLoopSession();

  let deriveCallCount = 0;
  let dispatchCallCount = 0;
  const dispatchedUnitTypes: string[] = [];

  // Phase sequence: each deriveState call returns a different phase.
  // On the 6th call (start of iteration 6), we deactivate to exit.
  const phases = [
    // Call 1: researching → dispatches research-slice
    {
      phase: "researching",
      activeSlice: { id: "S01", title: "Research Slice" },
      activeTask: null,
    },
    // Call 2: planning → dispatches plan-slice
    {
      phase: "planning",
      activeSlice: { id: "S01", title: "Plan Slice" },
      activeTask: null,
    },
    // Call 3: executing → dispatches execute-task
    {
      phase: "executing",
      activeSlice: { id: "S01", title: "Execute Slice" },
      activeTask: { id: "T01" },
    },
    // Call 4: verifying → dispatches verify-slice
    {
      phase: "verifying",
      activeSlice: { id: "S01", title: "Verify Slice" },
      activeTask: null,
    },
    // Call 5: completing → dispatches complete-slice
    {
      phase: "completing",
      activeSlice: { id: "S01", title: "Complete Slice" },
      activeTask: null,
    },
  ];

  const dispatches = [
    { unitType: "research-slice", unitId: "M001/S01", prompt: "research" },
    { unitType: "plan-slice", unitId: "M001/S01", prompt: "plan" },
    { unitType: "execute-task", unitId: "M001/S01/T01", prompt: "execute" },
    { unitType: "verify-slice", unitId: "M001/S01", prompt: "verify" },
    { unitType: "complete-slice", unitId: "M001/S01", prompt: "complete" },
  ];

  const deps = makeMockDeps({
    deriveState: async () => {
      deriveCallCount++;
      deps.callLog.push("deriveState");

      if (deriveCallCount > phases.length) {
        // 6th+ call: deactivate to exit the loop
        s.active = false;
        return {
          phase: "complete",
          activeMilestone: { id: "M001", title: "Test", status: "complete" },
          activeSlice: null,
          activeTask: null,
          registry: [{ id: "M001", status: "complete" }],
          blockers: [],
        } as any;
      }

      const p = phases[deriveCallCount - 1];
      return {
        phase: p.phase,
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: p.activeSlice,
        activeTask: p.activeTask,
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      } as any;
    },
    resolveDispatch: async () => {
      dispatchCallCount++;
      deps.callLog.push("resolveDispatch");

      if (dispatchCallCount > dispatches.length) {
        // Safety: shouldn't reach here, but stop if it does
        return {
          action: "stop" as const,
          reason: "done",
          level: "info" as const,
        };
      }

      const d = dispatches[dispatchCallCount - 1];
      dispatchedUnitTypes.push(d.unitType);
      return {
        action: "dispatch" as const,
        unitType: d.unitType,
        unitId: d.unitId,
        prompt: d.prompt,
      };
    },
    postUnitPostVerification: async () => {
      deps.callLog.push("postUnitPostVerification");
      return "continue" as const;
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);

  // Resolve each iteration's agent_end — 5 iterations, each dispatches a unit
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 30));
    resolveAgentEnd(makeEvent());
  }

  await loopPromise;

  // Assert deriveState was called at least 5 times (once per iteration)
  assert.ok(
    deriveCallCount >= 5,
    `deriveState should be called at least 5 times (got ${deriveCallCount})`,
  );

  // Assert the dispatched unit types cover the full lifecycle sequence
  assert.ok(
    dispatchedUnitTypes.includes("research-slice"),
    `should have dispatched research-slice, got: ${dispatchedUnitTypes.join(", ")}`,
  );
  assert.ok(
    dispatchedUnitTypes.includes("plan-slice"),
    `should have dispatched plan-slice, got: ${dispatchedUnitTypes.join(", ")}`,
  );
  assert.ok(
    dispatchedUnitTypes.includes("execute-task"),
    `should have dispatched execute-task, got: ${dispatchedUnitTypes.join(", ")}`,
  );
  assert.ok(
    dispatchedUnitTypes.includes("verify-slice"),
    `should have dispatched verify-slice, got: ${dispatchedUnitTypes.join(", ")}`,
  );
  assert.ok(
    dispatchedUnitTypes.includes("complete-slice"),
    `should have dispatched complete-slice, got: ${dispatchedUnitTypes.join(", ")}`,
  );

  // Assert call sequence: deriveState and resolveDispatch entries are interleaved
  const deriveEntries = deps.callLog.filter((c) => c === "deriveState");
  const dispatchEntries = deps.callLog.filter((c) => c === "resolveDispatch");
  assert.ok(
    deriveEntries.length >= 5,
    `callLog should have at least 5 deriveState entries (got ${deriveEntries.length})`,
  );
  assert.ok(
    dispatchEntries.length >= 5,
    `callLog should have at least 5 resolveDispatch entries (got ${dispatchEntries.length})`,
  );

  // Verify interleaving: each resolveDispatch should follow a deriveState
  let dispatchSeen = 0;
  for (const entry of deps.callLog) {
    if (entry === "resolveDispatch") {
      dispatchSeen++;
    }
    if (entry === "deriveState" && dispatchSeen > 0) {
      // A deriveState after a resolveDispatch confirms the loop advanced
      break;
    }
  }
  assert.ok(dispatchSeen > 0, "resolveDispatch should appear in callLog");

  // Assert the exact sequence of dispatched unit types
  assert.deepEqual(
    dispatchedUnitTypes,
    [
      "research-slice",
      "plan-slice",
      "execute-task",
      "verify-slice",
      "complete-slice",
    ],
    "dispatched unit types should follow the full lifecycle sequence",
  );
});
