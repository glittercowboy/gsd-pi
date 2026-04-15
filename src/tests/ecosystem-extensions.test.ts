// GSD2 — Tests for the ecosystem extension wrapper (#3338)
// Covers: AUTO_LOOP_PHASE_MAP behavior, before_agent_start interception,
// snapshot reads, and a key-drift guard against pi's ExtensionAPI surface.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  _resetSnapshot,
  createGSDExtensionAPI,
  type GSDEcosystemBeforeAgentStartHandler,
  getSnapshotActiveUnit,
  getSnapshotPhase,
  mapAutoLoopPhase,
  updateSnapshot,
} from "../resources/extensions/gsd/ecosystem/gsd-extension-api.js";
import type { GSDState } from "../resources/extensions/gsd/types.js";

// ─── Test fixtures ──────────────────────────────────────────────────────

function buildPiStub(): {
  pi: any;
  onCalls: Array<{ event: string; handler: unknown }>;
} {
  const onCalls: Array<{ event: string; handler: unknown }> = [];
  const noop = (): void => {};
  const noopAsync = async (): Promise<undefined> => undefined;
  const pi = {
    on: (event: string, handler: unknown): void => {
      onCalls.push({ event, handler });
    },
    emitBeforeModelSelect: noopAsync,
    emitAdjustToolSet: noopAsync,
    registerTool: noop,
    registerCommand: noop,
    registerBeforeInstall: noop,
    registerAfterInstall: noop,
    registerBeforeRemove: noop,
    registerAfterRemove: noop,
    registerShortcut: noop,
    registerFlag: noop,
    getFlag: () => undefined,
    registerMessageRenderer: noop,
    sendMessage: noop,
    sendUserMessage: noop,
    retryLastTurn: noop,
    appendEntry: noop,
    setSessionName: noop,
    getSessionName: () => undefined,
    setLabel: noop,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: noop,
    getCommands: () => [],
    setModel: async () => true,
    getThinkingLevel: () => "off" as const,
    setThinkingLevel: noop,
    registerProvider: noop,
    unregisterProvider: noop,
    events: {
      emit: noop,
      on: () => noop,
    },
  };
  return { pi, onCalls };
}

function buildState(overrides: Partial<GSDState> = {}): GSDState {
  return {
    activeMilestone: { id: "M001", title: "Milestone One" },
    activeSlice: { id: "S01", title: "Slice One" },
    activeTask: { id: "T01", title: "Task One" },
    phase: "executing",
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [],
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

test("mapAutoLoopPhase returns mapped phase for known keys", () => {
  assert.equal(mapAutoLoopPhase("plan-milestone"), "planning");
  assert.equal(mapAutoLoopPhase("plan-slice"), "planning");
  assert.equal(mapAutoLoopPhase("execute-task"), "executing");
  assert.equal(mapAutoLoopPhase("verify"), "verifying");
  assert.equal(mapAutoLoopPhase("summarize-task"), "summarizing");
  assert.equal(mapAutoLoopPhase("summarize-slice"), "summarizing");
  assert.equal(mapAutoLoopPhase("advance"), "advancing");
  assert.equal(mapAutoLoopPhase("validate-milestone"), "validating-milestone");
  assert.equal(mapAutoLoopPhase("complete-milestone"), "completing-milestone");
  assert.equal(mapAutoLoopPhase("replan-slice"), "replanning-slice");
});

test("mapAutoLoopPhase returns null for unknown keys (does not default)", () => {
  assert.equal(mapAutoLoopPhase("not-a-real-phase"), null);
  assert.equal(mapAutoLoopPhase(""), null);
  assert.notEqual(mapAutoLoopPhase("not-a-real-phase"), "executing");
});

test("createGSDExtensionAPI intercepts before_agent_start", () => {
  const { pi, onCalls } = buildPiStub();
  const shared: GSDEcosystemBeforeAgentStartHandler[] = [];
  const api = createGSDExtensionAPI(pi, shared);

  const handler: GSDEcosystemBeforeAgentStartHandler = async () => undefined;
  api.on("before_agent_start", handler);

  assert.equal(shared.length, 1);
  assert.equal(shared[0], handler);
  assert.equal(onCalls.length, 0, "pi.on should NOT be invoked for before_agent_start");
});

test("createGSDExtensionAPI delegates non-intercepted events to pi.on", () => {
  const { pi, onCalls } = buildPiStub();
  const shared: GSDEcosystemBeforeAgentStartHandler[] = [];
  const api = createGSDExtensionAPI(pi, shared);

  const handler = (): void => {};
  api.on("session_start", handler);

  assert.equal(shared.length, 0, "shared handlers should be empty");
  assert.equal(onCalls.length, 1);
  assert.equal(onCalls[0].event, "session_start");
  assert.equal(onCalls[0].handler, handler);
});

test("getPhase / getActiveUnit read from module snapshot", () => {
  _resetSnapshot();
  const { pi } = buildPiStub();
  const api = createGSDExtensionAPI(pi, []);

  // Initial state: nothing loaded
  assert.equal(api.getPhase(), null);
  assert.equal(api.getActiveUnit(), null);

  updateSnapshot(buildState());
  assert.equal(api.getPhase(), "executing");
  assert.deepEqual(api.getActiveUnit(), {
    milestoneId: "M001",
    milestoneTitle: "Milestone One",
    sliceId: "S01",
    sliceTitle: "Slice One",
    taskId: "T01",
    taskTitle: "Task One",
  });

  // Snapshot getters mirror the api methods
  assert.equal(getSnapshotPhase(), "executing");
  assert.notEqual(getSnapshotActiveUnit(), null);
});

test("getActiveUnit returns null when state has no active triple", () => {
  _resetSnapshot();
  const { pi } = buildPiStub();
  const api = createGSDExtensionAPI(pi, []);

  updateSnapshot(buildState({ activeTask: null }));
  assert.equal(api.getActiveUnit(), null);
  // Phase still resolves even when active unit is missing
  assert.equal(api.getPhase(), "executing");
});

test("updateSnapshot(null) resets both snapshot fields", () => {
  _resetSnapshot();
  updateSnapshot(buildState());
  assert.notEqual(getSnapshotPhase(), null);

  updateSnapshot(null);
  assert.equal(getSnapshotPhase(), null);
  assert.equal(getSnapshotActiveUnit(), null);
});

test("wrapper key-drift guard: every ExtensionAPI method is delegated", () => {
  // If pi adds a new method to ExtensionAPI and the wrapper isn't updated,
  // the `satisfies GSDExtensionAPI` check will fail at compile time. This
  // runtime test catches a different failure: a method becoming a no-op
  // on the wrapper because the wrapper key doesn't exist.
  const { pi } = buildPiStub();
  const api = createGSDExtensionAPI(pi, []);

  const expectedKeys = [
    "on",
    "emitBeforeModelSelect",
    "emitAdjustToolSet",
    "registerTool",
    "registerCommand",
    "registerBeforeInstall",
    "registerAfterInstall",
    "registerBeforeRemove",
    "registerAfterRemove",
    "registerShortcut",
    "registerFlag",
    "getFlag",
    "registerMessageRenderer",
    "sendMessage",
    "sendUserMessage",
    "retryLastTurn",
    "appendEntry",
    "setSessionName",
    "getSessionName",
    "setLabel",
    "exec",
    "getActiveTools",
    "getAllTools",
    "setActiveTools",
    "getCommands",
    "setModel",
    "getThinkingLevel",
    "setThinkingLevel",
    "registerProvider",
    "unregisterProvider",
    "events",
    "getPhase",
    "getActiveUnit",
  ];

  const wrapperKeys = new Set(Object.keys(api));
  for (const key of expectedKeys) {
    assert.ok(
      wrapperKeys.has(key),
      `wrapper missing key "${key}" — pi's ExtensionAPI may have drifted`,
    );
  }
});
