import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _resetAutoSessionForTest,
  _setAutoSessionStateForTest,
  stopAuto,
} from "../auto.ts";
import { resolveAgentEnd, _resetPendingResolve } from "../auto-loop.js";
import { runUnitPhase } from "../auto/phases.js";
import type { IterationContext, IterationData, LoopState } from "../auto/types.js";
import type { LoopDeps } from "../auto/loop-deps.js";

afterEach(() => {
  _resetPendingResolve();
  _resetAutoSessionForTest();
});

type ThinkingSnapshot = {
  mode: "minimal" | "standard" | "full";
  budgetTokens?: number;
};

function makeBase(): string {
  return mkdtempSync(join(tmpdir(), "gsd-thinking-restore-"));
}

function makeCtx(models: Array<{ provider: string; id: string }> = []) {
  const notifications: string[] = [];
  return {
    notifications,
    ui: {
      notify: (message: string) => { notifications.push(message); },
      setStatus: () => {},
      setWidget: () => {},
    },
    model: { provider: "test-provider", id: "current-model" },
    modelRegistry: {
      find: (provider: string, id: string) =>
        models.find((model) => model.provider === provider && model.id === id),
      getAvailable: () => models,
      getProviderAuthMode: () => "apiKey",
    },
  } as any;
}

function makePi() {
  const thinkingCalls: unknown[] = [];
  const setModelCalls: unknown[] = [];
  const callLog: string[] = [];
  return {
    callLog,
    thinkingCalls,
    setModelCalls,
    sendMessage: () => {},
    setModel: async (...args: unknown[]) => {
      callLog.push("setModel");
      setModelCalls.push(args);
      return true;
    },
    setThinkingLevel: (level: unknown) => {
      callLog.push("setThinkingLevel");
      thinkingCalls.push(level);
    },
    events: { emit: () => {} },
  } as any;
}

function makeSession(basePath: string, thinkingLevel: ThinkingSnapshot | null = null) {
  return {
    active: true,
    verbose: false,
    stepMode: false,
    paused: false,
    basePath,
    originalBasePath: "",
    currentMilestoneId: "M001",
    currentUnit: null,
    currentUnitRouting: null,
    currentUnitModel: null,
    currentDispatchedModelId: null,
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
    manualSessionModelOverride: null,
    autoModeStartThinkingLevel: thinkingLevel,
    unitDispatchCount: new Map<string, number>(),
    unitLifetimeDispatches: new Map<string, number>(),
    unitRecoveryCount: new Map<string, number>(),
    verificationRetryCount: new Map<string, number>(),
    gitService: null,
    autoStartTime: Date.now(),
    checkpointSha: null,
    lastToolInvocationError: null,
    lastGitActionFailure: null,
    lastGitActionStatus: null,
    cmdCtx: {
      newSession: () => Promise.resolve({ cancelled: false }),
      getContextUsage: () => ({ percent: 10, tokens: 1000, limit: 10000 }),
    },
    clearTimers: () => {},
  } as any;
}

function makeDeps(overrides?: Partial<LoopDeps>): LoopDeps {
  const baseDeps = {
    lockBase: () => "/tmp/test-lock",
    buildSnapshotOpts: () => ({}),
    stopAuto: async () => {},
    pauseAuto: async () => {},
    clearUnitTimeout: () => {},
    updateProgressWidget: () => {},
    updateSessionLock: () => {},
    getLedger: () => ({ units: [] }),
    closeoutUnit: async () => {},
    recordOutcome: () => {},
    writeLock: () => {},
    captureAvailableSkills: () => {},
    ensurePreconditions: () => {},
    updateSliceProgressCache: () => {},
    selectAndApplyModel: async () => ({ routing: null, appliedModel: null }),
    startUnitSupervision: () => {},
    isDbAvailable: () => false,
    reorderForCaching: (prompt: string) => prompt,
    getSessionFile: () => "/tmp/session.json",
    resolveModelId: (id: string, models: any[]) =>
      models.find((model) => model.id === id || `${model.provider}/${model.id}` === id),
    emitJournalEvent: () => {},
  };
  return { ...baseDeps, ...overrides } as unknown as LoopDeps;
}

function makeIC(
  basePath: string,
  deps: LoopDeps,
  options?: {
    thinkingLevel?: ThinkingSnapshot | null;
    ctx?: ReturnType<typeof makeCtx>;
    pi?: ReturnType<typeof makePi>;
  },
): IterationContext {
  let seq = 0;
  return {
    ctx: options?.ctx ?? makeCtx(),
    pi: options?.pi ?? makePi(),
    s: makeSession(basePath, options?.thinkingLevel ?? null),
    deps,
    prefs: { safety_harness: { enabled: false } } as any,
    iteration: 1,
    flowId: randomUUID(),
    nextSeq: () => ++seq,
  };
}

function makeIterData(overrides?: Partial<IterationData>): IterationData {
  return {
    unitType: "hook/review",
    unitId: "M001/S01/H01",
    prompt: "do stuff",
    finalPrompt: "do stuff",
    pauseAfterUatDispatch: false,
    state: {
      phase: "executing",
      activeMilestone: { id: "M001", title: "Test", status: "active" },
      activeSlice: { id: "S01", title: "Slice 1" },
      activeTask: { id: "T01" },
      registry: [{ id: "M001", status: "active" }],
      blockers: [],
    } as any,
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: undefined,
    ...overrides,
  };
}

async function runPhaseToCompletion(ic: IterationContext, iterData: IterationData): Promise<void> {
  _resetPendingResolve();
  const loopState: LoopState = {
    recentUnits: [{ key: `${iterData.unitType}/${iterData.unitId}` }],
    stuckRecoveryAttempts: 0,
    consecutiveFinalizeTimeouts: 0,
  };
  const phasePromise = runUnitPhase(ic, iterData, loopState);
  await new Promise((resolve) => setTimeout(resolve, 25));
  resolveAgentEnd({ messages: [{ role: "assistant" }] });
  const result = await phasePromise;
  assert.equal(result.action, "next", JSON.stringify(result));
}

test("stopAuto restores the original thinking level", async () => {
  const base = makeBase();
  const pi = makePi();
  const ctx = makeCtx();
  const originalThinking: ThinkingSnapshot = { mode: "standard", budgetTokens: 4096 };
  try {
    _setAutoSessionStateForTest({
      active: true,
      basePath: base,
      originalThinkingLevel: originalThinking as any,
      currentMilestoneId: null,
    });

    await stopAuto(ctx, pi, "test-stop");

    assert.deepEqual(pi.thinkingCalls, [originalThinking]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("runUnitPhase threads captured thinking level into selectAndApplyModel", async () => {
  const base = makeBase();
  const capturedThinking: unknown[] = [];
  const startThinking: ThinkingSnapshot = { mode: "full", budgetTokens: 8192 };
  try {
    const deps = makeDeps({
      selectAndApplyModel: async (...args) => {
        capturedThinking.push(args[11]);
        return { routing: null, appliedModel: null };
      },
    });
    const ic = makeIC(base, deps, { thinkingLevel: startThinking });

    await runPhaseToCompletion(ic, makeIterData());

    assert.deepEqual(capturedThinking, [startThinking]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("hook model override reapplies the captured thinking level after setModel", async () => {
  const base = makeBase();
  const startThinking: ThinkingSnapshot = { mode: "minimal", budgetTokens: 1024 };
  const hookModel = { provider: "test-provider", id: "hook-model" };
  const ctx = makeCtx([hookModel]);
  const pi = makePi();
  try {
    const deps = makeDeps({
      selectAndApplyModel: async () => ({ routing: null, appliedModel: null }),
    });
    const ic = makeIC(base, deps, { thinkingLevel: startThinking, ctx, pi });

    await runPhaseToCompletion(ic, makeIterData({ hookModelOverride: "hook-model" }));

    assert.deepEqual(pi.setModelCalls[0], [hookModel, { persist: false }]);
    assert.deepEqual(pi.thinkingCalls, [startThinking]);
    assert.deepEqual(pi.callLog.slice(0, 2), ["setModel", "setThinkingLevel"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
