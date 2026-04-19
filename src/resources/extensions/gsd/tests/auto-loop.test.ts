import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  resolveAgentEnd,
  resolveAgentEndCancelled,
  runUnit,
  autoLoop,
  detectStuck,
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
  const setModelCalls: unknown[] = [];
  return {
    sendMessage: (...args: unknown[]) => {
      calls.push(args);
    },
    setModel: async (...args: unknown[]) => {
      setModelCalls.push(args);
      return true;
    },
    calls,
    setModelCalls,
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
  const resultPromise = runUnit(
    ctx,
    pi,
    s,
    "task",
    "T01",
    "do stuff",
  );

  // Give the microtask queue a tick so runUnit reaches the await
  await new Promise((r) => setTimeout(r, 10));

  // Now resolve the agent_end
  resolveAgentEnd(event);

  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.deepEqual(result.event, event);
});

test("resolveAgentEnd drops event when no promise is pending", () => {
  _resetPendingResolve();

  // Should not throw — event is dropped (logged as warning)
  assert.doesNotThrow(() => {
    resolveAgentEnd(makeEvent());
  });
});

test("double resolveAgentEnd only resolves once (second is dropped)", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession();
  const event1 = makeEvent([{ id: 1 }]);
  const event2 = makeEvent([{ id: 2 }]);

  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt");

  await new Promise((r) => setTimeout(r, 10));

  // First resolve — should work
  resolveAgentEnd(event1);

  // Second resolve — should be dropped (no pending resolver)
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

  const result = await runUnit(ctx, pi, s, "task", "T01", "prompt");

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

  const result = await runUnit(ctx, pi, s, "task", "T01", "prompt");

  assert.equal(result.status, "cancelled");
  assert.equal(result.event, undefined);
  assert.equal(pi.calls.length, 0);
});

test("runUnit keeps the session-switch guard across a late newSession settlement", async () => {
  _resetPendingResolve();
  mock.timers.enable();

  try {
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    // Use delays longer than NEW_SESSION_TIMEOUT_MS (120s) so the timeout fires
    const firstSession = makeMockSession({ newSessionDelayMs: 200_000 });
    const secondSession = makeMockSession({ newSessionDelayMs: 200_000 });

    const firstRun = runUnit(ctx, pi, firstSession, "task", "T01", "prompt");

    // Tick past the 120s session timeout
    mock.timers.tick(121_000);
    await Promise.resolve();

    const firstResult = await firstRun;
    assert.equal(firstResult.status, "cancelled");
    assert.equal(isSessionSwitchInFlight(), true, "guard should remain set after the timed-out session");

    mock.timers.tick(1);
    const secondRun = runUnit(ctx, pi, secondSession, "task", "T02", "prompt");

    mock.timers.tick(100_000);
    await Promise.resolve();
    assert.equal(
      isSessionSwitchInFlight(),
      true,
      "late settlement from the first session must not clear the newer session guard",
    );

    // Tick past the second session's timeout (121s total > 120s NEW_SESSION_TIMEOUT_MS)
    mock.timers.tick(21_001);
    await Promise.resolve();

    const secondResult = await secondRun;
    assert.equal(secondResult.status, "cancelled");

    // Tick past the second session's delayed promise (200s) so .finally() fires
    mock.timers.tick(80_000);
    await Promise.resolve();
    assert.equal(isSessionSwitchInFlight(), false, "guard should clear after the newer session settles");
  } finally {
    mock.timers.reset();
  }
});

test("runUnit returns cancelled when s.active is false before sendMessage", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession();
  s.active = false;

  const result = await runUnit(ctx, pi, s, "task", "T01", "prompt");

  assert.equal(result.status, "cancelled");
  assert.equal(pi.calls.length, 0);
});

test("runUnit only arms resolve after newSession completes", async () => {
  _resetPendingResolve();

  let sawSwitchFlag = false;

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession({
    newSessionDelayMs: 20,
    onNewSessionStart: () => {
      sawSwitchFlag = isSessionSwitchInFlight();
    },
  });

  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt");

  await new Promise((r) => setTimeout(r, 30));

  assert.equal(sawSwitchFlag, true, "session switch guard should be active during newSession");
  assert.equal(isSessionSwitchInFlight(), false, "session switch guard should clear after newSession settles");

  resolveAgentEnd(makeEvent());

  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.equal(pi.calls.length, 1);
});

test("runUnit re-applies the selected unit model after newSession before dispatch", async () => {
  _resetPendingResolve();

  const callOrder: string[] = [];
  const ctx = makeMockCtx();
  const pi = makeMockPi();
  pi.setModel = async (...args: unknown[]) => {
    callOrder.push("setModel");
    pi.setModelCalls.push(args);
    return true;
  };
  pi.sendMessage = (...args: unknown[]) => {
    callOrder.push("sendMessage");
    pi.calls.push(args);
  };

  const s = makeMockSession();
  s.currentUnitModel = { provider: "anthropic", id: "claude-opus-4-6" };

  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt");

  await new Promise((r) => setTimeout(r, 10));
  resolveAgentEnd(makeEvent());

  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.deepEqual(callOrder, ["setModel", "sendMessage"]);
  assert.equal(pi.setModelCalls.length, 1);
  assert.deepEqual(pi.setModelCalls[0][0], s.currentUnitModel);
  assert.equal(pi.calls.length, 1);
});

test("runUnit cancels before dispatch when model restore fails after newSession", async () => {
  _resetPendingResolve();

  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = makeMockCtx();
  ctx.ui.notify = (message: string, level: string) => {
    notifications.push({ message, level });
  };

  const pi = makeMockPi();
  pi.setModel = async (...args: unknown[]) => {
    pi.setModelCalls.push(args);
    return false;
  };

  const s = makeMockSession();
  s.currentUnitModel = { provider: "openai-codex", id: "gpt-5.4" };

  const result = await runUnit(ctx, pi, s, "task", "T01", "prompt");

  assert.equal(result.status, "cancelled");
  assert.equal(result.errorContext?.category, "session-failed");
  assert.match(
    result.errorContext?.message ?? "",
    /Failed to restore configured model openai-codex\/gpt-5\.4 after session creation/,
  );
  assert.equal(pi.setModelCalls.length, 1);
  assert.equal(pi.calls.length, 0, "unit must not dispatch on the session default model");
  assert.deepEqual(notifications, [
    {
      message: "Failed to restore configured model openai-codex/gpt-5.4 after session creation. Cancelling unit before dispatch.",
      level: "warning",
    },
  ]);
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

test("auto/loop.ts contains a while keyword", () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "auto", "loop.ts"),
    "utf-8",
  );
  assert.ok(
    src.includes("while"),
    "auto/loop.ts should contain a while keyword (loop or placeholder)",
  );
});

test("auto/resolve.ts one-shot pattern: _currentResolve is nulled before calling resolver", () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "auto", "resolve.ts"),
    "utf-8",
  );
  // The one-shot pattern requires: save ref, null the variable, then call
  const resolveBlock = src.slice(
    src.indexOf("export function resolveAgentEnd"),
    src.indexOf("export function resolveAgentEnd") + 600,
  );
  const nullIdx = resolveBlock.indexOf("_currentResolve = null");
  const callIdx = resolveBlock.indexOf("r({");
  assert.ok(nullIdx > 0, "should null _currentResolve in resolveAgentEnd");
  assert.ok(callIdx > 0, "should call resolver in resolveAgentEnd");
  assert.ok(
    nullIdx < callIdx,
    "_currentResolve should be nulled before calling the resolver (one-shot)",
  );
});

test("auto/phases.ts: selectAndApplyModel called exactly once and before updateProgressWidget (#2907)", () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "auto", "phases.ts"),
    "utf-8",
  );
  // Extract the runUnitPhase function body
  const fnStart = src.indexOf("export async function runUnitPhase");
  assert.ok(fnStart > 0, "runUnitPhase should exist in phases.ts");
  const fnBody = src.slice(fnStart, fnStart + 12000);

  // selectAndApplyModel must appear exactly once
  const allOccurrences = [...fnBody.matchAll(/selectAndApplyModel\(/g)];
  assert.equal(
    allOccurrences.length,
    1,
    `selectAndApplyModel should be called exactly once in runUnitPhase, found ${allOccurrences.length} calls`,
  );

  // selectAndApplyModel must appear BEFORE updateProgressWidget
  const modelIdx = fnBody.indexOf("selectAndApplyModel(");
  const widgetIdx = fnBody.indexOf("updateProgressWidget(");
  assert.ok(modelIdx > 0, "selectAndApplyModel should exist in runUnitPhase");
  assert.ok(widgetIdx > 0, "updateProgressWidget should exist in runUnitPhase");
  assert.ok(
    modelIdx < widgetIdx,
    "selectAndApplyModel must be called BEFORE updateProgressWidget (#2899/#2907)",
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
    mergeMilestoneToMain: () => ({ pushed: false, codeFilesChanged: true }),
    teardownAutoWorktree: () => {},
    createAutoWorktree: () => "/tmp/wt",
    captureIntegrationBranch: () => {},
    getIsolationMode: () => "none",
    getCurrentBranch: () => "main",
    autoWorktreeBranch: () => "auto/M001",
    resolveMilestoneFile: () => null,
    reconcileMergeState: () => "clean",
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
    closeoutUnit: async () => {},
    recordOutcome: () => {},
    writeLock: () => {},
    captureAvailableSkills: () => {},
    ensurePreconditions: () => {},
    updateSliceProgressCache: () => {},
    selectAndApplyModel: async () => ({ routing: null, appliedModel: null }),
    startUnitSupervision: () => {},
    getDeepDiagnostic: () => null,
    isDbAvailable: () => false,
    reorderForCaching: (p: string) => p,
    existsSync: (p: string) => p.endsWith(".git") || p.endsWith("package.json"),
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
    rebuildState: async () => {},
    resolveModelId: (id: string, models: any[]) => models.find((m: any) => m.id === id),
    emitJournalEvent: () => {},
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
    deps.callLog.includes("pauseAuto"),
    "should have called pauseAuto for blocked state",
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
      // Deactivate after first iteration to exit the loop
      s.active = false;
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

test("crash lock records session file from AFTER newSession, not before (#1710)", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};

  // Simulate newSession changing the session file path.
  // newSession() in runUnit changes the underlying session, so getSessionFile
  // returns a different path after newSession completes.
  let currentSessionFile = "/tmp/old-session.json";
  ctx.sessionManager = {
    getSessionFile: () => currentSessionFile,
  };
  const pi = makeMockPi();

  const s = makeLoopSession({
    cmdCtx: {
      newSession: () => {
        // When newSession completes, the session file changes
        currentSessionFile = "/tmp/new-session-after-newSession.json";
        return Promise.resolve({ cancelled: false });
      },
      getContextUsage: () => ({ percent: 10, tokens: 1000, limit: 10000 }),
    },
  });

  // Track all writeLock calls with their sessionFile argument
  const writeLockCalls: { sessionFile: string | undefined }[] = [];
  const updateSessionLockCalls: { sessionFile: string | undefined }[] = [];

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
    writeLock: (_base: string, _ut: string, _uid: string, sessionFile?: string) => {
      writeLockCalls.push({ sessionFile });
    },
    updateSessionLock: (_base: string, _ut: string, _uid: string, sessionFile?: string) => {
      updateSessionLockCalls.push({ sessionFile });
    },
    getSessionFile: (ctxArg: any) => {
      return ctxArg.sessionManager?.getSessionFile() ?? "";
    },
    postUnitPostVerification: async () => {
      deps.callLog.push("postUnitPostVerification");
      // Deactivate after first iteration to exit the loop
      s.active = false;
      return "continue" as const;
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);

  // Give the loop time to reach runUnit's await
  await new Promise((r) => setTimeout(r, 50));

  // Resolve the unit's agent_end
  resolveAgentEnd(makeEvent());

  await loopPromise;

  // The preliminary lock (before runUnit) should have NO session file
  assert.ok(
    writeLockCalls.length >= 2,
    `expected at least 2 writeLock calls, got ${writeLockCalls.length}`,
  );
  assert.strictEqual(
    writeLockCalls[0].sessionFile,
    undefined,
    "preliminary lock before runUnit should have no session file",
  );

  // The post-runUnit lock should have the NEW session file path
  assert.strictEqual(
    writeLockCalls[1].sessionFile,
    "/tmp/new-session-after-newSession.json",
    "post-runUnit lock should record the session file created by newSession",
  );

  // updateSessionLock should also have the new session file
  assert.ok(
    updateSessionLockCalls.length >= 1,
    "updateSessionLock should have been called at least once",
  );
  assert.strictEqual(
    updateSessionLockCalls[0].sessionFile,
    "/tmp/new-session-after-newSession.json",
    "updateSessionLock should record the session file created by newSession",
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

  // Pre-queued verification actions: each entry provides a side-effect + return value
  type VerifyAction = { sideEffect?: () => void; response: "retry" | "continue" };
  const verificationActions: VerifyAction[] = [
    {
      sideEffect: () => {
        // Simulate retry — set pendingVerificationRetry on session
        s.pendingVerificationRetry = {
          unitId: "M001/S01/T01",
          failureContext: "test failed: expected X got Y",
          attempt: 1,
        };
      },
      response: "retry",
    },
    { response: "continue" },
  ];

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
      const action = verificationActions[verifyCallCount] ?? { response: "continue" as const };
      verifyCallCount++;
      deps.callLog.push("runPostUnitVerification");
      action.sideEffect?.();
      return action.response;
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

// #2474: warning-level dispatch stop should pause (resumable), not hard-stop
test("autoLoop pauses instead of stopping for warning-level dispatch stop", async (t) => {
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
        reason: 'UAT verdict for S01 is "partial" — blocking progression.',
        level: "warning" as const,
      };
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.ok(
    deps.callLog.includes("resolveDispatch"),
    "should have called resolveDispatch",
  );
  assert.ok(
    deps.callLog.includes("pauseAuto"),
    "warning-level stop should call pauseAuto (resumable)",
  );
  assert.ok(
    !deps.callLog.includes("stopAuto"),
    "warning-level stop should NOT call stopAuto (hard stop)",
  );
});

// #2474: error-level dispatch stop should still hard-stop
test("autoLoop hard-stops for error-level dispatch stop", async (t) => {
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
        reason: "Cannot complete milestone: missing SUMMARY files.",
        level: "error" as const,
      };
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.ok(
    deps.callLog.includes("stopAuto"),
    "error-level stop should call stopAuto (hard stop)",
  );
  assert.ok(
    !deps.callLog.includes("pauseAuto"),
    "error-level stop should NOT call pauseAuto",
  );
});

test("autoLoop handles dispatch skip action by continuing", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();

  let dispatchCallCount = 0;
  // Pre-queued dispatch responses: first call returns "skip", second returns "stop"
  const dispatchResponses = [
    { action: "skip" as const },
    { action: "stop" as const, reason: "done", level: "info" as const },
  ];
  const deps = makeMockDeps({
    resolveDispatch: async () => {
      const response = dispatchResponses[dispatchCallCount] ?? dispatchResponses[dispatchResponses.length - 1];
      dispatchCallCount++;
      deps.callLog.push("resolveDispatch");
      return response;
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
  const postVerActions: Array<() => void> = [
    () => {
      // First call (main unit): enqueue a sidecar item
      s.sidecarQueue.push({
        kind: "hook" as const,
        unitType: "hook/review",
        unitId: "M001/S01/T01/review",
        prompt: "review the code",
      });
    },
    () => {
      // Second call (sidecar unit completed): deactivate
      s.active = false;
    },
  ];
  const deps = makeMockDeps({
    postUnitPostVerification: async () => {
      postVerActions[postVerCallCount]?.();
      postVerCallCount++;
      deps.callLog.push("postUnitPostVerification");
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
    resolve(import.meta.dirname, "..", "auto", "loop-deps.ts"),
    "utf-8",
  );
  assert.ok(
    src.includes("export interface LoopDeps"),
    "auto/loop-deps.ts should export LoopDeps interface",
  );
});

test("autoLoop signature accepts deps parameter", async () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "auto", "loop.ts"),
    "utf-8",
  );
  assert.ok(
    src.includes("deps: LoopDeps"),
    "autoLoop should accept a deps: LoopDeps parameter",
  );
});

test("autoLoop contains while (s.active) loop", () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "auto", "loop.ts"),
    "utf-8",
  );
  assert.ok(
    src.includes("while (s.active)"),
    "autoLoop should contain a while (s.active) loop",
  );
});

// ── T03: End-to-end wiring structural assertions ─────────────────────────────

test("auto-loop.ts barrel re-exports autoLoop, runUnit, and resolveAgentEnd", () => {
  const barrel = readFileSync(
    resolve(import.meta.dirname, "..", "auto-loop.ts"),
    "utf-8",
  );
  assert.ok(
    barrel.includes("autoLoop"),
    "barrel must re-export autoLoop",
  );
  assert.ok(
    barrel.includes("runUnit"),
    "barrel must re-export runUnit",
  );
  assert.ok(
    barrel.includes("resolveAgentEnd"),
    "barrel must re-export resolveAgentEnd",
  );
  // Verify the actual function declarations exist in the submodules
  const loopSrc = readFileSync(
    resolve(import.meta.dirname, "..", "auto", "loop.ts"),
    "utf-8",
  );
  assert.ok(
    loopSrc.includes("export async function autoLoop"),
    "auto/loop.ts must define autoLoop",
  );
  const runUnitSrc = readFileSync(
    resolve(import.meta.dirname, "..", "auto", "run-unit.ts"),
    "utf-8",
  );
  assert.ok(
    runUnitSrc.includes("export async function runUnit"),
    "auto/run-unit.ts must define runUnit",
  );
  const resolveSrc = readFileSync(
    resolve(import.meta.dirname, "..", "auto", "resolve.ts"),
    "utf-8",
  );
  assert.ok(
    resolveSrc.includes("export function resolveAgentEnd"),
    "auto/resolve.ts must define resolveAgentEnd",
  );
});

test("auto.ts startAuto dispatches through the UOK kernel wrapper with explicit kernel and legacy paths", () => {
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
    fnBlock.includes("runAutoLoopWithUok("),
    "startAuto must dispatch through runAutoLoopWithUok()",
  );
  assert.ok(
    fnBlock.includes("runKernelLoop: runUokKernelLoop"),
    "startAuto must wire the explicit UOK kernel loop path",
  );
  assert.ok(
    fnBlock.includes("runLegacyLoop: runLegacyAutoLoop"),
    "startAuto must preserve explicit legacy fallback dispatch",
  );
});

test("startAuto calls selfHealRuntimeRecords before autoLoop (#1727)", { skip: "selfHealRuntimeRecords moved to crash-recovery pipeline in v3" }, () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "auto.ts"),
    "utf-8",
  );
  const fnIdx = src.indexOf("export async function startAuto");
  assert.ok(fnIdx > -1, "startAuto must exist in auto.ts");
  const fnEnd = src.indexOf("\n// ─── ", fnIdx + 100);
  const fnBlock =
    fnEnd > -1 ? src.slice(fnIdx, fnEnd) : src.slice(fnIdx, fnIdx + 5000);

  // Both autoLoop call sites must be preceded by selfHealRuntimeRecords
  const healIdx = fnBlock.indexOf("selfHealRuntimeRecords");
  const loopIdx = fnBlock.indexOf("autoLoop(");
  assert.ok(healIdx > -1, "startAuto must call selfHealRuntimeRecords");
  assert.ok(healIdx < loopIdx, "selfHealRuntimeRecords must be called before autoLoop");

  // Verify the second autoLoop call site also has selfHeal before it (if present)
  const secondLoopIdx = fnBlock.indexOf("autoLoop(", loopIdx + 1);
  const secondHealIdx = fnBlock.indexOf("selfHealRuntimeRecords", healIdx + 1);
  assert.ok(
    secondLoopIdx === -1 || (secondHealIdx > -1 && secondHealIdx < secondLoopIdx),
    "if a second autoLoop call exists, it must also be preceded by selfHealRuntimeRecords",
  );
});

test("startAuto guards against concurrent invocation (#2923)", () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "auto.ts"),
    "utf-8",
  );
  const fnIdx = src.indexOf("export async function startAuto");
  assert.ok(fnIdx > -1, "startAuto must exist in auto.ts");
  // The guard must appear before any other logic in the function body
  const fnBody = src.slice(fnIdx, fnIdx + 500);
  const activeGuard = fnBody.indexOf("if (s.active)");
  assert.ok(activeGuard > -1, "startAuto must check s.active to prevent concurrent auto-loops");
  const returnIdx = fnBody.indexOf("return;", activeGuard);
  assert.ok(
    returnIdx > -1 && returnIdx < activeGuard + 120,
    "s.active guard must early-return to prevent a second concurrent loop",
  );
});

test("agent_end handler calls resolveAgentEnd (not the legacy auto.ts path)", () => {
  const hooksSrc = readFileSync(
    resolve(import.meta.dirname, "..", "bootstrap", "register-hooks.ts"),
    "utf-8",
  );
  // Verify the agent_end hook is registered
  const handlerIdx = hooksSrc.indexOf('pi.on("agent_end"');
  assert.ok(handlerIdx > -1, "register-hooks.ts must have an agent_end handler");

  const recoverySrc = readFileSync(
    resolve(import.meta.dirname, "..", "bootstrap", "agent-end-recovery.ts"),
    "utf-8",
  );
  assert.ok(
    recoverySrc.includes("resolveAgentEnd(event)"),
    "agent_end success path must call resolveAgentEnd(event) instead of legacy wrappers",
  );
  assert.ok(
    recoverySrc.includes("isSessionSwitchInFlight()"),
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

// ── Stuck counter tests ──────────────────────────────────────────────────────

test("stuck detection: stops when sliding window detects same unit 3 consecutive times", async () => {
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

  // Sliding window: iteration 1 pushes [A], iteration 2 pushes [A,A],
  // iteration 3 pushes [A,A,A] → Rule 2 fires (3 consecutive) → Level 1 recovery.
  // Level 1 invalidates caches and continues. Iteration 4 pushes [A,A,A,A] →
  // Rule 2 fires again → Level 2 hard stop.
  // Iterations 1-3 each run a unit (3 resolves needed). Iteration 3 triggers
  // Level 1 (cache invalidation + continue). Iteration 4 triggers Level 2 (stop
  // before runUnit), so no 4th resolve needed.

  for (let i = 0; i < 3; i++) {
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
    stopReason.includes("M001/S01/T01"),
    "stop reason should include unitId",
  );
});

test("stuck detection: window resets recovery when deriveState returns a different unit", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.ui.notify = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();

  let deriveCallCount = 0;
  let postVerCallCount = 0;
  let stopCalled = false;

  // First 3 derives return T01, 4th returns T02; dispatch follows the derived task
  const derivedTaskIds = ["T01", "T01", "T01", "T02"];

  const deps = makeMockDeps({
    deriveState: async () => {
      const taskId = derivedTaskIds[Math.min(deriveCallCount, derivedTaskIds.length - 1)];
      deriveCallCount++;
      deps.callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: taskId },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      } as any;
    },
    resolveDispatch: async () => {
      const taskId = derivedTaskIds[Math.min(deriveCallCount - 1, derivedTaskIds.length - 1)];
      deps.callLog.push("resolveDispatch");
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
      postVerCallCount++;
      deps.callLog.push("postUnitPostVerification");
      // Exit on the 4th call (after T02 unit completes)
      const shouldExit = postVerCallCount >= 4;
      s.active = !shouldExit;
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

  // Level 1 recovery fires on iteration 3 (cache invalidation + continue),
  // then iteration 4 derives T02 — no Level 2 hard stop.
  assert.ok(
    !stopCalled,
    "stopAuto should NOT have been called — different unit broke stuck pattern",
  );
  assert.ok(
    deriveCallCount >= 4,
    `deriveState should have been called at least 4 times (got ${deriveCallCount})`,
  );
});

test("stuck detection: does not push to window during verification retry", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.ui.notify = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();

  let verifyCallCount = 0;
  let stopReason = "";

  // Pre-queued responses: 3 retries then a continue (exit)
  const verifyActions: Array<() => "retry" | "continue"> = [
    () => { s.pendingVerificationRetry = { unitId: "M001/S01/T01", failureContext: "test failed", attempt: 1 }; return "retry"; },
    () => { s.pendingVerificationRetry = { unitId: "M001/S01/T01", failureContext: "test failed", attempt: 2 }; return "retry"; },
    () => { s.pendingVerificationRetry = { unitId: "M001/S01/T01", failureContext: "test failed", attempt: 3 }; return "retry"; },
    () => { s.active = false; return "continue"; },
  ];

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
      const action = verifyActions[verifyCallCount] ?? (() => { s.active = false; return "continue" as const; });
      verifyCallCount++;
      deps.callLog.push("runPostUnitVerification");
      return action();
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
  // not push to the sliding window, so stuck detection should not have fired
  assert.ok(
    !stopReason.includes("Stuck"),
    `stuck detection should not fire during verification retries, got: ${stopReason}`,
  );
  assert.equal(
    verifyCallCount,
    4,
    "verification should have been called 4 times (1 initial + 3 retries)",
  );
});

// ── detectStuck unit tests ────────────────────────────────────────────────────

test("detectStuck: returns null for fewer than 2 entries", () => {
  assert.equal(detectStuck([]), null);
  assert.equal(detectStuck([{ key: "A" }]), null);
});

test("detectStuck: Rule 1 — same error twice in a row", () => {
  const result = detectStuck([
    { key: "A", error: "ENOENT: file not found" },
    { key: "A", error: "ENOENT: file not found" },
  ]);
  assert.ok(result?.stuck, "should detect same error repeated");
  assert.ok(result?.reason.includes("Same error repeated"));
});

test("detectStuck: Rule 1 — different errors do not trigger", () => {
  const result = detectStuck([
    { key: "A", error: "ENOENT: file not found" },
    { key: "A", error: "EACCES: permission denied" },
  ]);
  assert.equal(result, null);
});

test("detectStuck: Rule 2 — same unit 3 consecutive times", () => {
  const result = detectStuck([
    { key: "execute-task/M001/S01/T01" },
    { key: "execute-task/M001/S01/T01" },
    { key: "execute-task/M001/S01/T01" },
  ]);
  assert.ok(result?.stuck);
  assert.ok(result?.reason.includes("3 consecutive times"));
});

test("detectStuck: Rule 2 — 2 consecutive does not trigger", () => {
  assert.equal(detectStuck([
    { key: "A" },
    { key: "A" },
  ]), null);
});

test("detectStuck: Rule 3 — oscillation A→B→A→B", () => {
  const result = detectStuck([
    { key: "A" },
    { key: "B" },
    { key: "A" },
    { key: "B" },
  ]);
  assert.ok(result?.stuck);
  assert.ok(result?.reason.includes("Oscillation"));
});

test("detectStuck: Rule 3 — non-oscillation pattern A→B→C→B", () => {
  assert.equal(detectStuck([
    { key: "A" },
    { key: "B" },
    { key: "C" },
    { key: "B" },
  ]), null);
});

test("detectStuck: Rule 1 takes priority over Rule 2 when both match", () => {
  const result = detectStuck([
    { key: "A", error: "test error" },
    { key: "A", error: "test error" },
    { key: "A", error: "test error" },
  ]);
  assert.ok(result?.stuck);
  // Rule 1 fires first
  assert.ok(result?.reason.includes("Same error repeated"));
});

test("detectStuck: truncates long error strings", () => {
  const longError = "x".repeat(500);
  const result = detectStuck([
    { key: "A", error: longError },
    { key: "A", error: longError },
  ]);
  assert.ok(result?.stuck);
  assert.ok(result!.reason.length < 300, "reason should be truncated");
});

test("stuck detection: logs debug output with stuck-detected phase", () => {
  // Structural test: verify auto/phases.ts contains
  // stuck-detected and stuck-counter-reset debug log phases, plus detectStuck
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "auto", "phases.ts"),
    "utf-8",
  );
  assert.ok(
    src.includes('"stuck-detected"'),
    "auto/phases.ts must log phase: 'stuck-detected' when stuck detection fires",
  );
  assert.ok(
    src.includes('"stuck-counter-reset"'),
    "auto/phases.ts must log phase: 'stuck-counter-reset' when recovery resets on new unit",
  );
  assert.ok(
    src.includes("detectStuck"),
    "auto/phases.ts must use detectStuck for sliding window analysis",
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
  // The 6th entry (index 5) is the terminal "complete" phase that stops the loop.
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
    // Call 6: terminal — deactivate to exit the loop
    {
      phase: "complete",
      activeSlice: null,
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
      const p = phases[Math.min(deriveCallCount, phases.length - 1)];
      deriveCallCount++;
      deps.callLog.push("deriveState");

      const terminalPhases: Record<string, string> = { complete: "complete" };
      s.active = p.phase !== "complete";
      const milestoneStatus = terminalPhases[p.phase] ?? "active";
      return {
        phase: p.phase,
        activeMilestone: { id: "M001", title: "Test", status: milestoneStatus },
        activeSlice: p.activeSlice ?? null,
        activeTask: p.activeTask ?? null,
        registry: [{ id: "M001", status: milestoneStatus }],
        blockers: [],
      } as any;
    },
    resolveDispatch: async () => {
      const d = dispatches[Math.min(dispatchCallCount, dispatches.length - 1)];
      dispatchCallCount++;
      deps.callLog.push("resolveDispatch");
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

  // Verify interleaving: a deriveState must follow a resolveDispatch (confirms loop advanced)
  const firstDispatchIdx = deps.callLog.indexOf("resolveDispatch");
  const firstDeriveAfterDispatch = deps.callLog.indexOf("deriveState", firstDispatchIdx + 1);
  assert.ok(firstDispatchIdx >= 0, "resolveDispatch should appear in callLog");
  assert.ok(firstDeriveAfterDispatch > firstDispatchIdx, "deriveState should follow resolveDispatch to confirm loop advanced");

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

// ─── resolveAgentEndCancelled tests ──────────────────────────────────────────

test("resolveAgentEndCancelled resolves a pending promise with cancelled status", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession();

  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt");

  await new Promise((r) => setTimeout(r, 10));

  resolveAgentEndCancelled();

  const result = await resultPromise;
  assert.equal(result.status, "cancelled");
  assert.equal(result.event, undefined);
});

test("resolveAgentEndCancelled is a no-op when no promise is pending", () => {
  _resetPendingResolve();

  assert.doesNotThrow(() => {
    resolveAgentEndCancelled();
  });
});

test("resolveAgentEndCancelled prevents orphaned promise after abort path", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession();

  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt");

  await new Promise((r) => setTimeout(r, 10));

  s.active = false;
  resolveAgentEndCancelled();

  const result = await resultPromise;
  assert.equal(result.status, "cancelled");
});

test("resolveAgentEndCancelled with errorContext passes it through to resolved promise", async () => {
  _resetPendingResolve();

  const { _setCurrentResolve } = await import("../auto/resolve.js");

  const p = new Promise<UnitResult>((r) => {
    _setCurrentResolve(r);
  });

  resolveAgentEndCancelled({ message: "test timeout", category: "timeout", isTransient: true });

  const resolved = await p;
  assert.equal(resolved.status, "cancelled");
  assert.ok(resolved.errorContext, "errorContext must be present");
  assert.equal(resolved.errorContext!.category, "timeout");
  assert.equal(resolved.errorContext!.message, "test timeout");
  assert.equal(resolved.errorContext!.isTransient, true);
});

test("resolveAgentEndCancelled without args produces no errorContext field", async () => {
  _resetPendingResolve();

  const { _setCurrentResolve } = await import("../auto/resolve.js");

  const p = new Promise<UnitResult>((r) => {
    _setCurrentResolve(r);
  });

  resolveAgentEndCancelled();

  const resolved = await p;
  assert.equal(resolved.status, "cancelled");
  assert.equal(resolved.errorContext, undefined, "errorContext must not be present when no args passed");
});

// ─── #1571: artifact verification retry ──────────────────────────────────────

test("autoLoop re-iterates when postUnitPreVerification returns retry (#1571)", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();

  let preVerifyCallCount = 0;
  // Pre-queued responses: first call returns "retry", second returns "continue"
  const preVerifyResponses = ["retry", "continue"] as const;

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
    postUnitPreVerification: async () => {
      deps.callLog.push("postUnitPreVerification");
      return preVerifyResponses[preVerifyCallCount++] ?? "continue";
    },
    postUnitPostVerification: async () => {
      deps.callLog.push("postUnitPostVerification");
      s.active = false;
      return "continue" as const;
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);

  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd(makeEvent());

  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd(makeEvent());

  await loopPromise;

  assert.equal(preVerifyCallCount, 2, "preVerification should be called twice");

  const postVerifyCalls = deps.callLog.filter(
    (c: string) => c === "runPostUnitVerification",
  );
  const postPostVerifyCalls = deps.callLog.filter(
    (c: string) => c === "postUnitPostVerification",
  );

  assert.equal(postVerifyCalls.length, 1, "runPostUnitVerification should only be called once");
  assert.equal(postPostVerifyCalls.length, 1, "postUnitPostVerification should only be called once");
});

// ─── stopAuto unitPromise leak regression (#1799) ────────────────────────────

test("resolveAgentEnd unblocks pending runUnit when called before session reset (#1799)", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession();

  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "do work");

  await new Promise((r) => setTimeout(r, 10));

  resolveAgentEnd({ messages: [] });
  _resetPendingResolve();
  s.active = false;

  const result = await resultPromise;
  assert.equal(result.status, "completed", "runUnit should resolve, not hang");
});

// ─── Zero tool-call hallucination guard (#1833) ───────────────────────────

test("autoLoop rejects execute-task with 0 tool calls as hallucinated (#1833)", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();

  let iterationCount = 0;
  const notifications: string[] = [];
  ctx.ui.notify = (msg: string) => { notifications.push(msg); };

  const s = makeLoopSession();

  // Mock ledger: execute-task completed with 0 tool calls
  const mockLedger = {
    version: 1,
    projectStartedAt: Date.now(),
    units: [] as any[],
  };

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
        prompt: "implement the feature",
      };
    },
    closeoutUnit: async () => {
      // Simulate snapshotUnitMetrics adding a 0-toolCalls entry to ledger
      mockLedger.units.push({
        type: "execute-task",
        id: "M001/S01/T01",
        startedAt: s.currentUnit?.startedAt ?? Date.now(),
        toolCalls: 0,
        assistantMessages: 1,
        tokens: { input: 100, output: 200, total: 300, cacheRead: 0, cacheWrite: 0 },
        cost: 0.50,
      });
    },
    getLedger: () => mockLedger,
    postUnitPostVerification: async () => {
      deps.callLog.push("postUnitPostVerification");
      iterationCount++;
      // Deactivate after 2nd iteration
      s.active = iterationCount < 2;
      return "continue" as const;
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);

  // First iteration: execute-task with 0 tool calls → rejected
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd(makeEvent());

  // Second iteration: same task re-dispatched, this time with tool calls
  await new Promise((r) => setTimeout(r, 50));
  mockLedger.units.length = 0; // clear previous entry
  (deps as any).closeoutUnit = async () => {
    mockLedger.units.push({
      type: "execute-task",
      id: "M001/S01/T01",
      startedAt: s.currentUnit?.startedAt ?? Date.now(),
      toolCalls: 5,
      assistantMessages: 3,
      tokens: { input: 500, output: 800, total: 1300, cacheRead: 0, cacheWrite: 0 },
      cost: 1.00,
    });
  };
  resolveAgentEnd(makeEvent());

  await loopPromise;

  // The task should NOT have been added to completedUnits on the first iteration
  // (0 tool calls), but SHOULD be added on the second iteration (5 tool calls)
  const warningNotification = notifications.find(
    (n) => n.includes("0 tool calls") && n.includes("context exhaustion"),
  );
  assert.ok(
    warningNotification,
    "should notify about 0 tool calls context exhaustion",
  );

  // Verify deriveState was called at least twice (two iterations)
  const deriveCount = deps.callLog.filter((c) => c === "deriveState").length;
  assert.ok(
    deriveCount >= 2,
    `deriveState should be called at least 2 times for retry (got ${deriveCount})`,
  );
});

test("autoLoop rejects complete-slice with 0 tool calls as context-exhausted (#2653)", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();

  let iterationCount = 0;
  const notifications: string[] = [];
  ctx.ui.notify = (msg: string) => { notifications.push(msg); };

  const s = makeLoopSession();

  const mockLedger = {
    version: 1,
    projectStartedAt: Date.now(),
    units: [] as any[],
  };

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
        unitType: "complete-slice",
        unitId: "M001/S01",
        prompt: "complete the slice",
      };
    },
    closeoutUnit: async () => {
      // complete-slice with 0 tool calls — context exhausted, no progress
      mockLedger.units.push({
        type: "complete-slice",
        id: "M001/S01",
        startedAt: s.currentUnit?.startedAt ?? Date.now(),
        toolCalls: 0,
        assistantMessages: 1,
        tokens: { input: 50, output: 100, total: 150, cacheRead: 0, cacheWrite: 0 },
        cost: 0.10,
      });
    },
    getLedger: () => mockLedger,
    postUnitPostVerification: async () => {
      deps.callLog.push("postUnitPostVerification");
      iterationCount++;
      // Deactivate after 2nd iteration
      s.active = iterationCount < 2;
      return "continue" as const;
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);

  // First iteration: complete-slice with 0 tool calls → rejected
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd(makeEvent());

  // Second iteration: re-dispatched, this time with tool calls
  await new Promise((r) => setTimeout(r, 50));
  mockLedger.units.length = 0;
  (deps as any).closeoutUnit = async () => {
    mockLedger.units.push({
      type: "complete-slice",
      id: "M001/S01",
      startedAt: s.currentUnit?.startedAt ?? Date.now(),
      toolCalls: 3,
      assistantMessages: 2,
      tokens: { input: 200, output: 400, total: 600, cacheRead: 0, cacheWrite: 0 },
      cost: 0.30,
    });
  };
  resolveAgentEnd(makeEvent());

  await loopPromise;

  // Should have a warning about 0 tool calls for complete-slice
  const warningNotification = notifications.find(
    (n) => n.includes("0 tool calls"),
  );
  assert.ok(
    warningNotification,
    "should flag complete-slice with 0 tool calls as failed (#2653)",
  );

  // Verify deriveState was called at least twice (two iterations: rejected + retry)
  const deriveCount = deps.callLog.filter((c) => c === "deriveState").length;
  assert.ok(
    deriveCount >= 2,
    `deriveState should be called at least 2 times for retry (got ${deriveCount})`,
  );
});

// ─── Worktree health check (#1833) ────────────────────────────────────────

test("autoLoop stops when worktree has no .git for execute-task (#1833)", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();

  const notifications: string[] = [];
  ctx.ui.notify = (msg: string) => { notifications.push(msg); };

  const s = makeLoopSession({ basePath: "/tmp/broken-worktree" });

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
    // .git does not exist in the broken worktree
    existsSync: (p: string) => !p.endsWith(".git"),
  });

  await autoLoop(ctx, pi, s, deps);

  assert.ok(
    deps.callLog.includes("stopAuto"),
    "should stop auto-mode when worktree is invalid",
  );
  const healthNotification = notifications.find(
    (n) => n.includes("Worktree health check failed") && n.includes("no .git"),
  );
  assert.ok(
    healthNotification,
    "should notify about missing .git in worktree",
  );
});

test("autoLoop warns but proceeds for greenfield project (no project files) (#1833)", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();

  const notifications: string[] = [];
  const s = makeLoopSession({ basePath: "/tmp/empty-worktree" });

  ctx.ui.notify = (msg: string) => {
    notifications.push(msg);
    // Terminate the loop after the greenfield warning fires,
    // so we don't hang waiting for dispatch resolution.
    if (msg.includes("greenfield")) {
      s.active = false;
    }
  };

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
    // Has .git but no package.json or src/
    existsSync: (p: string) => p.endsWith(".git"),
  });

  await autoLoop(ctx, pi, s, deps);

  // Should NOT have stopped auto-mode due to health check — greenfield is allowed
  const stoppedForHealth = notifications.find(
    (n) => n.includes("Worktree health check failed"),
  );
  assert.ok(
    !stoppedForHealth,
    "should not stop with health check failure for greenfield project",
  );
  const greenfieldWarning = notifications.find(
    (n) => n.includes("no recognized project files") && n.includes("greenfield"),
  );
  assert.ok(
    greenfieldWarning,
    "should warn about greenfield project (no project files)",
  );
});
