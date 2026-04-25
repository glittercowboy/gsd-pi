/**
 * journal-integration.test.ts — Integration tests proving that phase functions
 * emit correct journal event sequences with flowId threading, rule provenance,
 * and causedBy references.
 *
 * These tests call the real runDispatch / runUnitPhase / runPreDispatch
 * functions with mock LoopDeps that capture emitJournalEvent calls.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JournalEntry } from "../journal.js";
import type { LoopDeps } from "../auto/loop-deps.js";
import type { IterationContext, LoopState, PreDispatchData, IterationData } from "../auto/types.js";
import type { SessionLockStatus } from "../session-lock.js";
import { runDispatch, runUnitPhase, runPreDispatch, runFinalize } from "../auto/phases.js";
import { readUnitRuntimeRecord } from "../unit-runtime.js";
import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Captured journal events from the mock deps. */
function createEventCapture() {
  const events: JournalEntry[] = [];
  return {
    events,
    emitJournalEvent: (entry: JournalEntry) => { events.push(entry); },
  };
}

/** Minimal mock LoopDeps with journal event capture. */
function makeMockDeps(
  capture: ReturnType<typeof createEventCapture>,
  overrides?: Partial<LoopDeps>,
): LoopDeps {
  const baseDeps: LoopDeps = {
    lockBase: () => "/tmp/test-lock",
    buildSnapshotOpts: () => ({}),
    stopAuto: async () => {},
    pauseAuto: async () => {},
    clearUnitTimeout: () => {},
    updateProgressWidget: () => {},
    syncCmuxSidebar: () => {},
    logCmuxEvent: () => {},
    invalidateAllCaches: () => {},
    deriveState: async () => ({
      phase: "executing",
      activeMilestone: { id: "M001", title: "Test", status: "active" },
      activeSlice: { id: "S01", title: "Slice 1" },
      activeTask: { id: "T01" },
      registry: [{ id: "M001", status: "active" }],
      blockers: [],
    }) as any,
    loadEffectiveGSDPreferences: () => ({ preferences: {} }),
    preDispatchHealthGate: async () => ({ proceed: true, fixesApplied: [] }),
    syncProjectRootToWorktree: () => {},
    checkResourcesStale: () => null,
    validateSessionLock: () => ({ valid: true }) as SessionLockStatus,
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
    getLedger: () => ({ units: [] }),
    getProjectTotals: () => ({ cost: 0 }),
    formatCost: (c: number) => `$${c.toFixed(2)}`,
    getBudgetAlertLevel: () => 0,
    getNewBudgetAlertLevel: () => 0,
    getBudgetEnforcementAction: () => "none",
    getManifestStatus: async () => null,
    collectSecretsFromManifest: async () => null,
    resolveDispatch: async () => ({
      action: "dispatch" as const,
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "do the thing",
      matchedRule: "test-rule-alpha",
    }),
    runPreDispatchHooks: () => ({ firedHooks: [], action: "proceed" }),
    getPriorSliceCompletionBlocker: () => null,
    getMainBranch: () => "main",
    closeoutUnit: async () => {},
    autoCommitUnit: async () => null,
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
    rebuildState: async () => {},
    resolveModelId: (id: string, models: any[]) => models.find((m: any) => m.id === id),
    emitJournalEvent: capture.emitJournalEvent,
  };

  return { ...baseDeps, ...overrides };
}

/** Build a mock IterationContext with real flowId and seqCounter. */
function makeIC(
  deps: LoopDeps,
  overrides?: Partial<IterationContext>,
): IterationContext {
  const flowId = randomUUID();
  let seqCounter = 0;
  return {
    ctx: {
      ui: { notify: () => {}, setStatus: () => {} },
      model: { id: "test-model" },
      modelRegistry: { getAvailable: () => [] },
    } as any,
    pi: {
      sendMessage: () => {},
      setModel: async () => true,
    } as any,
    s: makeSession(),
    deps,
    prefs: undefined,
    iteration: 1,
    flowId,
    nextSeq: () => ++seqCounter,
    ...overrides,
  };
}

/** Minimal mock session for phase calls. */
function makeSession() {
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
  } as any;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("runDispatch emits dispatch-match with correct rule and flowId", async () => {
  const capture = createEventCapture();
  const deps = makeMockDeps(capture, {
    resolveDispatch: async () => ({
      action: "dispatch" as const,
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "do the thing",
      matchedRule: "slice-task-rule",
    }),
  });
  const ic = makeIC(deps);
  const preData: PreDispatchData = {
    state: {
      phase: "executing",
      activeMilestone: { id: "M001", title: "Test", status: "active" },
      activeSlice: { id: "S01", title: "Slice 1" },
      activeTask: { id: "T01" },
      registry: [{ id: "M001", status: "active" }],
      blockers: [],
    } as any,
    mid: "M001",
    midTitle: "Test Milestone",
  };
  const loopState: LoopState = { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };

  const result = await runDispatch(ic, preData, loopState);

  assert.equal(result.action, "next", "runDispatch should return next for dispatch action");

  const matchEvents = capture.events.filter(e => e.eventType === "dispatch-match");
  assert.equal(matchEvents.length, 1, "should emit exactly one dispatch-match event");

  const ev = matchEvents[0];
  assert.equal(ev.flowId, ic.flowId, "dispatch-match event should share the iteration flowId");
  assert.equal(ev.rule, "slice-task-rule", "dispatch-match should carry the matched rule name");
  assert.equal((ev.data as any).unitType, "execute-task");
  assert.equal((ev.data as any).unitId, "M001/S01/T01");
});

test("runDispatch emits dispatch-stop when dispatch returns stop action", async () => {
  const capture = createEventCapture();
  const deps = makeMockDeps(capture, {
    resolveDispatch: async () => ({
      action: "stop" as const,
      reason: "no eligible units",
      level: "info" as const,
      matchedRule: "<no-match>",
    }),
  });
  const ic = makeIC(deps);
  const preData: PreDispatchData = {
    state: { phase: "executing", activeMilestone: { id: "M001" }, registry: [{ id: "M001", status: "active" }], blockers: [] } as any,
    mid: "M001",
    midTitle: "Test",
  };
  const loopState: LoopState = { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };

  const result = await runDispatch(ic, preData, loopState);
  assert.equal(result.action, "break");

  const stopEvents = capture.events.filter(e => e.eventType === "dispatch-stop");
  assert.equal(stopEvents.length, 1);
  assert.equal(stopEvents[0].rule, "<no-match>");
  assert.equal((stopEvents[0].data as any).reason, "no eligible units");
  assert.equal(stopEvents[0].flowId, ic.flowId);
});

test("runDispatch checks prior-slice completion against the project root in worktree mode", async () => {
  const capture = createEventCapture();
  const guardCalls: Array<{ fn: string; args: unknown[] }> = [];
  const deps = makeMockDeps(capture, {
    getMainBranch: (basePath: string) => {
      guardCalls.push({ fn: "getMainBranch", args: [basePath] });
      return "main";
    },
    getPriorSliceCompletionBlocker: (
      basePath: string,
      mainBranch: string,
      unitType: string,
      unitId: string,
    ) => {
      guardCalls.push({
        fn: "getPriorSliceCompletionBlocker",
        args: [basePath, mainBranch, unitType, unitId],
      });
      return null;
    },
  });
  const ic = makeIC(deps, {
    s: {
      ...makeSession(),
      basePath: "/tmp/project/.gsd/worktrees/M029-xoklo9",
      originalBasePath: "/tmp/project",
    } as any,
  });
  const preData: PreDispatchData = {
    state: {
      phase: "executing",
      activeMilestone: { id: "M029-xoklo9", title: "Test", status: "active" },
      activeSlice: { id: "S01", title: "Slice 1" },
      registry: [{ id: "M029-xoklo9", status: "active" }],
      blockers: [],
    } as any,
    mid: "M029-xoklo9",
    midTitle: "Test Milestone",
  };

  const result = await runDispatch(ic, preData, {
    recentUnits: [],
    stuckRecoveryAttempts: 0,
    consecutiveFinalizeTimeouts: 0,
  });

  assert.equal(result.action, "next");
  assert.deepEqual(guardCalls, [
    { fn: "getMainBranch", args: ["/tmp/project"] },
    {
      fn: "getPriorSliceCompletionBlocker",
      args: ["/tmp/project", "main", "execute-task", "M001/S01/T01"],
    },
  ]);
});

test("runDispatch pauses when complete-milestone summary exists on disk but the unit is still stuck (#4289)", async (t) => {
  const capture = createEventCapture();
  let pauseCalls = 0;
  let stopCalls = 0;
  const base = join(tmpdir(), `gsd-stuck-complete-${randomUUID()}`);
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  mkdirSync(join(base, "src"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Summary\nDone.\n");
  writeFileSync(join(base, "src", "app.ts"), "export const ok = true;\n");

  execFileSync("git", ["init", "-b", "main"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Codex"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "codex@example.com"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, "README.md"), "# test\n");
  execFileSync("git", ["add", "README.md"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "chore: seed"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "fix/test"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["add", ".gsd/milestones/M001/M001-SUMMARY.md", "src/app.ts"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "feat: summary exists but db is stale"], { cwd: base, stdio: "ignore" });

  const deps = makeMockDeps(capture, {
    pauseAuto: async () => { pauseCalls++; },
    stopAuto: async () => { stopCalls++; },
    resolveDispatch: async () => ({
      action: "dispatch" as const,
      unitType: "complete-milestone",
      unitId: "M001",
      prompt: "complete the milestone",
      matchedRule: "completing-milestone-rule",
    }),
  });

  const ic = makeIC(deps, {
    s: {
      ...makeSession(),
      basePath: base,
      currentMilestoneId: "M001",
    } as any,
  });
  const preData: PreDispatchData = {
    state: {
      phase: "completing-milestone",
      activeMilestone: { id: "M001", title: "Test", status: "active" },
      registry: [{ id: "M001", status: "active" }],
      blockers: [],
    } as any,
    mid: "M001",
    midTitle: "Test Milestone",
  };

  const result = await runDispatch(ic, preData, {
    recentUnits: [
      { key: "complete-milestone/M001" },
      { key: "complete-milestone/M001" },
    ],
    stuckRecoveryAttempts: 0,
    consecutiveFinalizeTimeouts: 0,
  });

  assert.equal(result.action, "break");
  assert.equal((result as any).reason, "complete-milestone-artifact-db-mismatch");
  assert.equal(pauseCalls, 1, "complete-milestone disk/db mismatch should pause auto-mode");
  assert.equal(stopCalls, 0, "mismatch pause should not hard-stop the loop");
});

test("runUnitPhase emits unit-start and unit-end with causedBy reference", async () => {
  const capture = createEventCapture();

  // We need runUnit to return immediately — mock it by providing a session
  // whose cmdCtx.newSession resolves immediately and the result is completed.
  // Actually, runUnitPhase calls the real runUnit which creates a pending
  // promise and blocks. We need a different approach.
  //
  // Instead, we test that unit-start is emitted at the right point by examining
  // the event immediately after calling runUnitPhase with a session where
  // newSession resolves quickly, and we resolve the agent_end externally.
  const { resolveAgentEnd, _resetPendingResolve } = await import("../auto-loop.js");
  _resetPendingResolve();

  const deps = makeMockDeps(capture);
  const ic = makeIC(deps);
  const iterData: IterationData = {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    prompt: "do stuff",
    finalPrompt: "do stuff",
    pauseAfterUatDispatch: false,
    state: { phase: "executing", activeMilestone: { id: "M001" }, activeSlice: { id: "S01" }, registry: [], blockers: [] } as any,
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: undefined,
  };
  const loopState: LoopState = { recentUnits: [{ key: "execute-task/M001/S01/T01" }], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };

  // Start runUnitPhase (it will block on runUnit internally)
  const unitPromise = runUnitPhase(ic, iterData, loopState);

  // Give it time to reach the await inside runUnit
  await new Promise(r => setTimeout(r, 50));

  // Resolve the agent_end
  resolveAgentEnd({ messages: [{ role: "assistant" }] });

  const result = await unitPromise;
  assert.equal(result.action, "next");

  // Check unit-start
  const startEvents = capture.events.filter(e => e.eventType === "unit-start");
  assert.equal(startEvents.length, 1, "should emit exactly one unit-start");
  assert.equal(startEvents[0].flowId, ic.flowId);
  assert.equal((startEvents[0].data as any).unitType, "execute-task");
  assert.equal((startEvents[0].data as any).unitId, "M001/S01/T01");

  // Check unit-end
  const endEvents = capture.events.filter(e => e.eventType === "unit-end");
  assert.equal(endEvents.length, 1, "should emit exactly one unit-end");
  assert.equal(endEvents[0].flowId, ic.flowId);
  assert.equal((endEvents[0].data as any).unitType, "execute-task");
  assert.equal((endEvents[0].data as any).unitId, "M001/S01/T01");
  assert.equal((endEvents[0].data as any).status, "completed");

  // Verify causedBy: unit-end references unit-start's seq
  assert.ok(endEvents[0].causedBy, "unit-end must have a causedBy reference");
  assert.equal(endEvents[0].causedBy!.flowId, ic.flowId);
  assert.equal(endEvents[0].causedBy!.seq, startEvents[0].seq, "unit-end causedBy.seq must match unit-start.seq");
});

test("runUnitPhase increments unitDispatchCount for repeated artifact-missing retries", async () => {
  const capture = createEventCapture();
  const { resolveAgentEnd, _resetPendingResolve } = await import("../auto-loop.js");
  _resetPendingResolve();

  const deps = makeMockDeps(capture);
  const ic = makeIC(deps);
  const iterData: IterationData = {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    prompt: "do stuff",
    finalPrompt: "do stuff",
    pauseAfterUatDispatch: false,
    state: { phase: "executing", activeMilestone: { id: "M001" }, activeSlice: { id: "S01" }, registry: [], blockers: [] } as any,
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: undefined,
  };
  const loopState: LoopState = { recentUnits: [{ key: "execute-task/M001/S01/T01" }], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };

  const firstRun = runUnitPhase(ic, iterData, loopState);
  await new Promise(r => setTimeout(r, 50));
  resolveAgentEnd({ messages: [{ role: "assistant" }] });
  await firstRun;
  assert.equal(ic.s.unitDispatchCount.get("execute-task/M001/S01/T01"), 1);

  _resetPendingResolve();
  const secondRun = runUnitPhase(ic, iterData, loopState);
  await new Promise(r => setTimeout(r, 50));
  resolveAgentEnd({ messages: [{ role: "assistant" }] });
  await secondRun;
  assert.equal(ic.s.unitDispatchCount.get("execute-task/M001/S01/T01"), 2);
});

test("all events from a mock iteration have monotonically increasing seq and same flowId", async () => {
  const capture = createEventCapture();
  const { resolveAgentEnd, _resetPendingResolve } = await import("../auto-loop.js");
  _resetPendingResolve();

  const deps = makeMockDeps(capture, {
    resolveDispatch: async () => ({
      action: "dispatch" as const,
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "do the thing",
      matchedRule: "my-rule",
    }),
  });
  const ic = makeIC(deps);

  // Phase 1: Dispatch
  const preData: PreDispatchData = {
    state: { phase: "executing", activeMilestone: { id: "M001", title: "T", status: "active" }, activeSlice: { id: "S01" }, activeTask: { id: "T01" }, registry: [{ id: "M001", status: "active" }], blockers: [] } as any,
    mid: "M001",
    midTitle: "Test",
  };
  const loopState: LoopState = { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };
  const dispatchResult = await runDispatch(ic, preData, loopState);
  assert.equal(dispatchResult.action, "next");

  // Phase 2: Unit execution
  const iterData = (dispatchResult as { action: "next"; data: IterationData }).data;
  const unitPromise = runUnitPhase(ic, iterData, loopState);
  await new Promise(r => setTimeout(r, 50));
  resolveAgentEnd({ messages: [{ role: "assistant" }] });
  await unitPromise;

  // Verify all events share the same flowId
  assert.ok(capture.events.length >= 3, `expected at least 3 events (dispatch-match, unit-start, unit-end), got ${capture.events.length}`);
  const flowId = ic.flowId;
  for (const ev of capture.events) {
    assert.equal(ev.flowId, flowId, `all events must share flowId=${flowId}, found event ${ev.eventType} with flowId=${ev.flowId}`);
  }

  // Verify monotonically increasing seq numbers
  for (let i = 1; i < capture.events.length; i++) {
    assert.ok(
      capture.events[i].seq > capture.events[i - 1].seq,
      `seq must be monotonically increasing: event[${i - 1}].seq=${capture.events[i - 1].seq} (${capture.events[i - 1].eventType}) should be less than event[${i}].seq=${capture.events[i].seq} (${capture.events[i].eventType})`,
    );
  }
});

test("dispatch-match events include matchedRule field matching the rule name", async () => {
  const capture = createEventCapture();
  const RULE_NAME = "priority-execution-rule";
  const deps = makeMockDeps(capture, {
    resolveDispatch: async () => ({
      action: "dispatch" as const,
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "test",
      matchedRule: RULE_NAME,
    }),
  });
  const ic = makeIC(deps);
  const preData: PreDispatchData = {
    state: { phase: "executing", activeMilestone: { id: "M001", title: "T", status: "active" }, activeSlice: { id: "S01" }, activeTask: { id: "T01" }, registry: [{ id: "M001", status: "active" }], blockers: [] } as any,
    mid: "M001",
    midTitle: "Test",
  };

  await runDispatch(ic, preData, { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 });

  const matchEvents = capture.events.filter(e => e.eventType === "dispatch-match");
  assert.equal(matchEvents.length, 1);
  assert.equal(matchEvents[0].rule, RULE_NAME, "dispatch-match event.rule must equal the matchedRule from dispatch result");
});

test("pre-dispatch-hook event is emitted when hooks fire", async () => {
  const capture = createEventCapture();
  const deps = makeMockDeps(capture, {
    resolveDispatch: async () => ({
      action: "dispatch" as const,
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "test",
      matchedRule: "some-rule",
    }),
    runPreDispatchHooks: () => ({
      firedHooks: ["observability-check", "lint-gate"],
      action: "proceed",
    }),
  });
  const ic = makeIC(deps);
  const preData: PreDispatchData = {
    state: { phase: "executing", activeMilestone: { id: "M001", title: "T", status: "active" }, activeSlice: { id: "S01" }, activeTask: { id: "T01" }, registry: [{ id: "M001", status: "active" }], blockers: [] } as any,
    mid: "M001",
    midTitle: "Test",
  };

  await runDispatch(ic, preData, { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 });

  const hookEvents = capture.events.filter(e => e.eventType === "pre-dispatch-hook");
  assert.equal(hookEvents.length, 1, "should emit one pre-dispatch-hook event");
  assert.deepEqual((hookEvents[0].data as any).firedHooks, ["observability-check", "lint-gate"]);
  assert.equal((hookEvents[0].data as any).action, "proceed");
  assert.equal(hookEvents[0].flowId, ic.flowId);
});

test("terminal event is emitted on milestone-complete", async () => {
  const capture = createEventCapture();
  const deps = makeMockDeps(capture, {
    deriveState: async () => ({
      phase: "complete",
      activeMilestone: { id: "M001", title: "Test", status: "complete" },
      activeSlice: null,
      activeTask: null,
      registry: [{ id: "M001", status: "complete" }],
      blockers: [],
    }) as any,
  });
  const ic = makeIC(deps);
  const loopState: LoopState = { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };

  const result = await runPreDispatch(ic, loopState);
  assert.equal(result.action, "break");

  const terminalEvents = capture.events.filter(e => e.eventType === "terminal");
  assert.equal(terminalEvents.length, 1, "should emit one terminal event");
  assert.equal((terminalEvents[0].data as any).reason, "milestone-complete");
  assert.equal(terminalEvents[0].flowId, ic.flowId);
});

test("terminal event is emitted on blocked state", async () => {
  const capture = createEventCapture();
  const deps = makeMockDeps(capture, {
    deriveState: async () => ({
      phase: "blocked",
      activeMilestone: { id: "M001", title: "Test", status: "active" },
      activeSlice: null,
      activeTask: null,
      registry: [{ id: "M001", status: "active" }],
      blockers: ["Missing API key"],
    }) as any,
  });
  const ic = makeIC(deps);
  const loopState: LoopState = { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };

  const result = await runPreDispatch(ic, loopState);
  assert.equal(result.action, "break");

  const terminalEvents = capture.events.filter(e => e.eventType === "terminal");
  assert.equal(terminalEvents.length, 1);
  assert.equal((terminalEvents[0].data as any).reason, "blocked");
  assert.deepEqual((terminalEvents[0].data as any).blockers, ["Missing API key"]);
});

test("#4671: plan-v2 missing CONTEXT.md reaches dispatch recovery instead of pausing", async () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-4671-predispatch-"));
  mkdirSync(join(basePath, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  openDatabase(join(basePath, ".gsd", "gsd.db"));
  try {
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Slice 1",
      status: "in_progress",
      sequence: 1,
    });
    insertTask({
      id: "T01",
      milestoneId: "M001",
      sliceId: "S01",
      title: "Task 1",
      status: "pending",
      keyFiles: ["src/task.ts"],
      sequence: 1,
    });

    let pauseCalls = 0;
    const capture = createEventCapture();
    const deps = makeMockDeps(capture, {
      pauseAuto: async () => { pauseCalls++; },
      deriveState: async () => ({
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01", title: "Task 1" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
        recentDecisions: [],
        nextAction: "dispatch",
      }) as any,
    });
    const ic = makeIC(deps, {
      prefs: { uok: { plan_v2: { enabled: true } } } as any,
    });
    ic.s.basePath = basePath;

    const result = await runPreDispatch(ic, {
      recentUnits: [],
      stuckRecoveryAttempts: 0,
      consecutiveFinalizeTimeouts: 0,
    });

    assert.equal(result.action, "next");
    assert.equal(pauseCalls, 0, "missing CONTEXT.md should be handled by dispatch recovery, not plan gate pause");
  } finally {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("milestone-transition event is emitted when milestone changes", async () => {
  const capture = createEventCapture();
  const deps = makeMockDeps(capture, {
    deriveState: async () => ({
      phase: "executing",
      activeMilestone: { id: "M002", title: "Next Milestone", status: "active" },
      activeSlice: { id: "S01" },
      activeTask: { id: "T01" },
      registry: [
        { id: "M001", status: "complete" },
        { id: "M002", status: "active" },
      ],
      blockers: [],
    }) as any,
  });
  const ic = makeIC(deps);
  // Session says current milestone is M001, but state will return M002
  ic.s.currentMilestoneId = "M001";
  const loopState: LoopState = { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };

  await runPreDispatch(ic, loopState);

  const transitionEvents = capture.events.filter(e => e.eventType === "milestone-transition");
  assert.equal(transitionEvents.length, 1, "should emit one milestone-transition event");
  assert.equal((transitionEvents[0].data as any).from, "M001");
  assert.equal((transitionEvents[0].data as any).to, "M002");
  assert.equal(transitionEvents[0].flowId, ic.flowId);
});

test("unit-end event contains errorContext when unit is cancelled with structured error", async () => {
  const capture = createEventCapture();
  const { resolveAgentEndCancelled, _resetPendingResolve } = await import("../auto-loop.js");
  _resetPendingResolve();

  let pauseCalls = 0;
  let commitCalls = 0;
  const deps = makeMockDeps(capture, {
    pauseAuto: async () => { pauseCalls++; },
    autoCommitUnit: async () => {
      commitCalls++;
      return "commit";
    },
  });
  const ic = makeIC(deps);
  const iterData: IterationData = {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    prompt: "do stuff",
    finalPrompt: "do stuff",
    pauseAfterUatDispatch: false,
    state: { phase: "executing", activeMilestone: { id: "M001" }, activeSlice: { id: "S01" }, registry: [], blockers: [] } as any,
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: undefined,
  };
  const loopState: LoopState = { recentUnits: [{ key: "execute-task/M001/S01/T01" }], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };

  const unitPromise = runUnitPhase(ic, iterData, loopState);
  await new Promise(r => setTimeout(r, 50));

  // Resolve with errorContext (simulates a unit hard timeout — not session creation)
  resolveAgentEndCancelled({ message: "Hard timeout error: exceeded limit", category: "timeout", isTransient: true });

  const result = await unitPromise;
  // Unit hard timeouts pause (recoverable) without auto-resume
  assert.equal(result.action, "break");
  assert.equal((result as any).reason, "unit-hard-timeout");
  assert.equal(pauseCalls, 1, "timeout cancellations should pause auto-mode exactly once");
  assert.equal(commitCalls, 1, "timeout cancellations should flush a unit auto-commit once");

  // Verify error classification used structured errorContext on the window entry
  const entry = loopState.recentUnits[loopState.recentUnits.length - 1];
  assert.ok(entry.error, "window entry must have error set");
  assert.ok(entry.error!.startsWith("timeout:"), "error must start with category from errorContext");
  assert.ok(entry.error!.includes("Hard timeout error"), "error must include the errorContext message");

  const endEvents = capture.events.filter(e => e.eventType === "unit-end");
  assert.equal(endEvents.length, 1, "timeout cancellations should still emit unit-end");
  assert.equal((endEvents[0].data as any).status, "cancelled");
  assert.equal((endEvents[0].data as any).artifactVerified, false);
  assert.equal((endEvents[0].data as any).errorContext.category, "timeout");
});

test("session-failed cancellations close out and emit unit-end before hard stop", async () => {
  const capture = createEventCapture();
  const { resolveAgentEndCancelled, _resetPendingResolve } = await import("../auto-loop.js");
  _resetPendingResolve();

  let closeoutCalls = 0;
  let commitCalls = 0;
  let stopCalls = 0;
  const deps = makeMockDeps(capture, {
    closeoutUnit: async () => { closeoutCalls++; },
    autoCommitUnit: async () => {
      commitCalls++;
      return "commit";
    },
    stopAuto: async () => { stopCalls++; },
  });
  const ic = makeIC(deps);
  const iterData: IterationData = {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    prompt: "do stuff",
    finalPrompt: "do stuff",
    pauseAfterUatDispatch: false,
    state: { phase: "executing", activeMilestone: { id: "M001" }, activeSlice: { id: "S01" }, registry: [], blockers: [] } as any,
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: undefined,
  };
  const loopState: LoopState = { recentUnits: [{ key: "execute-task/M001/S01/T01" }], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };

  const unitPromise = runUnitPhase(ic, iterData, loopState);
  await new Promise(r => setTimeout(r, 50));

  resolveAgentEndCancelled({ message: "session bootstrap exploded", category: "session-failed", isTransient: false });

  const result = await unitPromise;
  assert.equal(result.action, "break");
  assert.equal((result as any).reason, "session-failed");
  assert.equal(closeoutCalls, 1, "session-failed cancellations should close out the unit before stopping");
  assert.equal(commitCalls, 1, "session-failed cancellations should try one auto-commit flush");
  assert.equal(stopCalls, 1, "session-failed cancellations should hard-stop auto-mode");

  const endEvents = capture.events.filter(e => e.eventType === "unit-end");
  assert.equal(endEvents.length, 1, "session-failed cancellations should emit unit-end");
  assert.equal((endEvents[0].data as any).status, "cancelled");
  assert.equal((endEvents[0].data as any).artifactVerified, false);
  assert.equal((endEvents[0].data as any).errorContext.category, "session-failed");
});

test("runFinalize pauses and emits unit-end when pre-verification times out", async () => {
  const capture = createEventCapture();
  let pauseCalls = 0;
  const basePath = mkdtempSync(join(tmpdir(), "gsd-finalize-timeout-"));

  const deps = makeMockDeps(capture, {
    pauseAuto: async () => { pauseCalls++; },
    postUnitPreVerification: async () => {
      await new Promise(() => {});
      return "continue" as const;
    },
  });

  const ic = makeIC(deps, {
    s: {
      ...makeSession(),
      basePath,
      currentUnit: { type: "execute-task", id: "M001/S01/T01", startedAt: 1234 },
    } as any,
  });
  const iterData: IterationData = {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    prompt: "do stuff",
    finalPrompt: "do stuff",
    pauseAfterUatDispatch: false,
    state: { phase: "executing", activeMilestone: { id: "M001" }, activeSlice: { id: "S01" }, registry: [], blockers: [] } as any,
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: undefined,
  };
  const loopState: LoopState = { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };

  const originalSetTimeout = globalThis.setTimeout;
  try {
    globalThis.setTimeout = ((handler: (...args: any[]) => void, _timeout?: number, ...args: any[]) =>
      originalSetTimeout(handler, 0, ...args)) as typeof setTimeout;

    const result = await runFinalize(ic, iterData, loopState);
    assert.equal(result.action, "break");
    assert.equal((result as any).reason, "finalize-pre-timeout");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.equal(pauseCalls, 1, "pre-verification timeout should pause auto-mode");
  assert.equal(loopState.consecutiveFinalizeTimeouts, 1, "timeout should increment finalize timeout counter");
  assert.equal(ic.s.currentUnit, null, "timed-out finalize should detach currentUnit");

  const runtime = readUnitRuntimeRecord(basePath, "execute-task", "M001/S01/T01");
  assert.ok(runtime, "timed-out finalize should persist a runtime record");
  assert.equal(runtime?.phase, "finalize-timeout");
  assert.equal(runtime?.lastProgressKind, "finalize-pre-timeout");

  const endEvents = capture.events.filter((e) => e.eventType === "unit-end");
  assert.equal(endEvents.length, 1, "timed-out finalize should emit terminal unit-end");
  assert.equal((endEvents[0].data as any).status, "timed-out-finalize");
  assert.equal((endEvents[0].data as any).artifactVerified, false);
  assert.equal((endEvents[0].data as any).finalizeStage, "pre");
});

test("transient session-failed cancellations pause instead of hard-stopping", async () => {
  const capture = createEventCapture();
  const { resolveAgentEndCancelled, _resetPendingResolve } = await import("../auto-loop.js");
  _resetPendingResolve();

  const deps = makeMockDeps(capture);
  const ic = makeIC(deps);
  const iterData: IterationData = {
    unitType: "execute-task",
    unitId: "M001/S01/T02",
    prompt: "do more stuff",
    finalPrompt: "do more stuff",
    pauseAfterUatDispatch: false,
    state: { phase: "executing", activeMilestone: { id: "M001" }, activeSlice: { id: "S01" }, registry: [], blockers: [] } as any,
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: undefined,
  };
  const loopState: LoopState = { recentUnits: [{ key: "execute-task/M001/S01/T02" }], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };

  const unitPromise = runUnitPhase(ic, iterData, loopState);
  await new Promise(r => setTimeout(r, 50));

  resolveAgentEndCancelled({ message: "Session creation failed: temporary bootstrap overload", category: "session-failed", isTransient: true });

  const result = await unitPromise;
  assert.equal(result.action, "break");
  assert.equal((result as any).reason, "session-timeout");

  const entry = loopState.recentUnits[loopState.recentUnits.length - 1];
  assert.ok(entry.error, "window entry must have error set");
  assert.ok(entry.error!.startsWith("session-failed:"), "error must preserve the session-failed category");
});
