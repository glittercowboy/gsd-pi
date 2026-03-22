/**
 * GSD-2 / state-machine-fixes.test.ts
 * Tests for state machine bug fixes from the deep-dive audit.
 *
 * Covers:
 *   M2 — stuckRecoveryAttempts restored from session on loop entry (survives pause/resume)
 *   M2 — stuckRecoveryAttempts synced back to session on increment
 *   M4 — rewriteAttemptCount circuit-breaker on sidecar rewrite-docs path
 *   C2 — verificationRetryCount capped at 3 (advances past stuck unit after exhaustion)
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  autoLoop,
  resolveAgentEnd,
  _resetPendingResolve,
  type LoopDeps,
} from "../auto-loop.js";
import type { SessionLockStatus } from "../session-lock.js";

// ─── Shared helpers (mirrors auto-loop.test.ts conventions) ──────────────────

function makeEvent(messages: unknown[] = [{ role: "assistant" }]) {
  return { messages };
}

function makeMockCtx() {
  return {
    ui: { notify: () => {}, setStatus: () => {} },
    model: { id: "test-model" },
    sessionManager: { getSessionFile: () => "/tmp/session.json" },
  } as any;
}

function makeMockPi() {
  return { sendMessage: () => {}, calls: [] } as any;
}

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
    stuckRecoveryAttempts: 0,
    rewriteAttemptCount: 0,
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

function makeMockDeps(overrides?: Partial<LoopDeps>): LoopDeps & { callLog: string[] } {
  const callLog: string[] = [];

  const baseDeps: LoopDeps = {
    lockBase: () => "/tmp/test-lock",
    buildSnapshotOpts: () => ({}),
    stopAuto: async () => { callLog.push("stopAuto"); },
    pauseAuto: async () => { callLog.push("pauseAuto"); },
    clearUnitTimeout: () => {},
    updateProgressWidget: () => {},
    syncCmuxSidebar: () => {},
    logCmuxEvent: () => {},
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
    validateSessionLock: () => ({ valid: true } as SessionLockStatus),
    updateSessionLock: () => { callLog.push("updateSessionLock"); },
    handleLostSessionLock: () => { callLog.push("handleLostSessionLock"); },
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
    existsSync: (p: string) => p.endsWith(".git") || p.endsWith("package.json"),
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
    postUnitPreVerification: async () => { callLog.push("postUnitPreVerification"); return "continue" as const; },
    runPostUnitVerification: async () => { callLog.push("runPostUnitVerification"); return "continue" as const; },
    postUnitPostVerification: async () => { callLog.push("postUnitPostVerification"); return "continue" as const; },
    getSessionFile: () => "/tmp/session.json",
    rebuildState: async () => {},
    resolveModelId: (id: string, models: any[]) => models.find((m: any) => m.id === id),
    emitJournalEvent: () => {},
  };

  return { ...baseDeps, ...overrides, callLog };
}

// ─── M2a: stuckRecoveryAttempts restored from session → skip Level 1 ─────────

test("M2: session.stuckRecoveryAttempts=1 at startup causes Level 2 stop on first stuck signal (no Level 1 cache invalidation)", async () => {
  // When a session resumes with stuckRecoveryAttempts=1 already counted
  // (Level 1 already fired in a previous session), the first stuck signal
  // in the new session must go directly to Level 2 (hard stop).
  // Without Fix M2, loopState always started at 0, so Level 1 would repeat
  // indefinitely across restarts.
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeLoopSession({ stuckRecoveryAttempts: 1 });

  let stopReason = "";
  const deps = makeMockDeps({
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

  // Iterations 1 and 2 each run a unit (agent_end needed).
  // Iteration 3: [T01,T01,T01] → detectStuck → stuckRecoveryAttempts already 1
  // → Level 2 fires (stopAuto + break), no runUnit for iteration 3.
  for (let i = 0; i < 2; i++) {
    await new Promise((r) => setTimeout(r, 30));
    resolveAgentEnd(makeEvent());
  }

  await loopPromise;

  assert.ok(deps.callLog.includes("stopAuto"), "Level 2 hard stop should fire");
  assert.ok(stopReason.includes("Stuck"), `stop reason should mention 'Stuck', got: ${stopReason}`);

  // Level 1 (cache invalidation) must NOT have been called — we started at
  // stuckRecoveryAttempts=1, so Level 1 was skipped entirely.
  assert.ok(
    !deps.callLog.includes("invalidateAllCaches"),
    "invalidateAllCaches should NOT be called — Level 1 was already consumed before restart",
  );
});

// ─── M2b: stuckRecoveryAttempts synced to session after Level 1 fires ────────

test("M2: s.stuckRecoveryAttempts updated to 1 after Level 1 recovery so pause/resume escalates correctly", async () => {
  // After Level 1 fires (first stuck signal with attempts=0), s.stuckRecoveryAttempts
  // must be 1 so that if the session is paused and resumed, the next stuck
  // signal triggers Level 2 instead of repeating Level 1.
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeLoopSession({ stuckRecoveryAttempts: 0 });

  const deps = makeMockDeps({
    resolveDispatch: async () => ({
      action: "dispatch" as const,
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "do the thing",
    }),
    // Level 2 fires (iteration 4) → stopAuto → break
    stopAuto: async (_ctx?: any, _pi?: any, _reason?: string) => {
      deps.callLog.push("stopAuto");
      s.active = false;
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);

  // Iterations 1-2 run units. Iteration 3 → Level 1 (no runUnit). Iteration 4 → Level 2.
  // Send extra resolves — extras are dropped harmlessly.
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 30));
    resolveAgentEnd(makeEvent());
  }

  await loopPromise;

  assert.equal(
    s.stuckRecoveryAttempts,
    1,
    "s.stuckRecoveryAttempts should be 1 after Level 1 so resuming triggers Level 2, not repeat Level 1",
  );
});

// ─── M4a: sidecar circuit-breaker skips unit and resets counter ──────────────

test("M4: sidecar rewrite-docs is skipped and rewriteAttemptCount reset when count >= 3", async () => {
  // The sidecar circuit-breaker guards against unbounded rewrite-docs retries.
  // When s.rewriteAttemptCount >= 3, the sidecar item must be dropped (no unit
  // run) and the counter reset to 0. Without Fix M4, the counter was not
  // persisted across restarts so this guard never fired after a resume.
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeLoopSession({
    rewriteAttemptCount: 3,
    sidecarQueue: [
      { kind: "sidecar", unitType: "rewrite-docs", unitId: "M001/S01/T01", prompt: "rewrite" },
    ],
  });

  let postVerCallCount = 0;
  const deps = makeMockDeps({
    // After the sidecar is skipped, the normal dispatch fires. Return "stop"
    // so the loop exits cleanly without needing an agent_end resolve.
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      return { action: "stop" as const, reason: "test-exit" };
    },
    stopAuto: async () => { deps.callLog.push("stopAuto"); },
    postUnitPostVerification: async () => {
      postVerCallCount++;
      return "continue" as const;
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.equal(s.rewriteAttemptCount, 0, "rewriteAttemptCount should be reset to 0 by the circuit-breaker");
  assert.equal(postVerCallCount, 0, "no unit should run — postUnitPostVerification must not be called");
  assert.ok(!deps.callLog.includes("runPostUnitVerification"), "runPostUnitVerification must not be called for the blocked sidecar");
});

// ─── M4b: sidecar increments counter when under the limit ────────────────────

test("M4: sidecar rewrite-docs increments rewriteAttemptCount when count < 3", async () => {
  // When the counter is below the limit, the sidecar unit must run normally
  // and s.rewriteAttemptCount must be incremented.
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeLoopSession({
    rewriteAttemptCount: 1,
    sidecarQueue: [
      { kind: "sidecar", unitType: "rewrite-docs", unitId: "M001/S01/T01", prompt: "rewrite" },
    ],
  });

  const deps = makeMockDeps({
    postUnitPostVerification: async () => {
      s.active = false;
      return "continue" as const;
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);

  // One agent_end for the sidecar unit that runs
  await new Promise((r) => setTimeout(r, 30));
  resolveAgentEnd(makeEvent());

  await loopPromise;

  assert.equal(s.rewriteAttemptCount, 2, "rewriteAttemptCount should increment from 1 to 2");
});

// ─── C2: verification retry cap at 3 ─────────────────────────────────────────

test("C2: loop recovers after 3 verification failures by treating the unit as complete", async () => {
  // auto-post-unit.ts caps verificationRetryCount at 3 (attempt > 2 → advance).
  // After exhaustion, runPostUnitVerification returns 'continue' and the loop
  // proceeds normally. Without this cap the loop would retry indefinitely.
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeLoopSession();

  let verifyCallCount = 0;
  let postVerCallCount = 0;

  // Simulate: 2 retries (attempts 1-2) then cap fires → continue (attempt 3)
  type VerifyAction = { sideEffect?: () => void; response: "retry" | "continue" };
  const verifyActions: VerifyAction[] = [
    {
      sideEffect: () => {
        s.pendingVerificationRetry = { unitId: "M001/S01/T01", failureContext: "artifact missing (attempt 1)", attempt: 1 };
      },
      response: "retry",
    },
    {
      sideEffect: () => {
        s.pendingVerificationRetry = { unitId: "M001/S01/T01", failureContext: "artifact missing (attempt 2)", attempt: 2 };
      },
      response: "retry",
    },
    {
      // attempt 3: cap fires in real code → returns continue, clears retry
      sideEffect: () => {
        s.pendingVerificationRetry = null;
      },
      response: "continue",
    },
  ];

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
    resolveDispatch: async () => ({
      action: "dispatch" as const,
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "do the thing",
    }),
    runPostUnitVerification: async () => {
      const action = verifyActions[verifyCallCount] ?? { response: "continue" as const };
      verifyCallCount++;
      deps.callLog.push("runPostUnitVerification");
      action.sideEffect?.();
      return action.response;
    },
    postUnitPostVerification: async () => {
      postVerCallCount++;
      deps.callLog.push("postUnitPostVerification");
      s.active = false;
      return "continue" as const;
    },
    stopAuto: async (_ctx?: any, _pi?: any, reason?: string) => {
      deps.callLog.push("stopAuto");
      s.active = false;
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);

  // 3 agent_end resolves: initial dispatch + 2 retries
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 50));
    resolveAgentEnd(makeEvent());
  }

  await loopPromise;

  assert.ok(!deps.callLog.includes("stopAuto"), "loop should not hard-stop — verification cap should advance past the unit");
  assert.equal(verifyCallCount, 3, `expected 3 verification calls (2 retries + 1 cap), got ${verifyCallCount}`);
  assert.ok(postVerCallCount >= 1, "postUnitPostVerification should be called once verification resolves");
});
