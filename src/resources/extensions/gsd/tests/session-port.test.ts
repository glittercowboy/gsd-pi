/**
 * Contract tests for session-port.ts — full port/detach lifecycle.
 *
 * Covers: successful port, successful detach, worker-not-found,
 * no-sessionFile, pause-timeout, switchSession-throws, detach-no-port.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
 *        --experimental-strip-types --test src/resources/extensions/gsd/tests/session-port.test.ts
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Module-level mocks ────────────────────────────────────────────────────
// Must be set up BEFORE dynamic import of session-port.

// Controllable stubs — reassigned per test in beforeEach
let mockGetOrchestratorState: () => any = () => null;
let mockPersistState: (bp: string) => void = () => {};
let mockReadSessionStatus: (bp: string, mid: string) => any = () => null;
let mockWaitForWorkerPause: (bp: string, mid: string) => Promise<any> = async () => ({
  paused: false,
  elapsedMs: 30000,
});
let mockSendSignal: (bp: string, mid: string, sig: string) => void = () => {};

// Port state tracking — simulates context-tracker module state
let trackerPortState: any = null;

mock.module("../parallel-orchestrator.js", {
  namedExports: {
    getOrchestratorState: (...args: any[]) => mockGetOrchestratorState(),
    persistState: (...args: any[]) => mockPersistState(args[0]),
  },
});

mock.module("../session-status-io.js", {
  namedExports: {
    readSessionStatus: (...args: any[]) => mockReadSessionStatus(args[0], args[1]),
    waitForWorkerPause: (...args: any[]) => mockWaitForWorkerPause(args[0], args[1]),
    sendSignal: (...args: any[]) => mockSendSignal(args[0], args[1], args[2]),
    readTeamSignals: () => [],
    writeTeamSignal: () => {},
    clearTeamSignals: () => {},
  },
});

mock.module("../context-tracker.js", {
  namedExports: {
    setPortState: (state: any) => { trackerPortState = { ...state }; },
    getPortState: () => trackerPortState ? { ...trackerPortState } : null,
    clearPortState: () => { trackerPortState = null; },
    isPortActive: () => trackerPortState !== null,
    getPortedWorkerId: () => trackerPortState?.portedWorkerMid ?? null,
  },
});

// ─── Dynamic import (after mocks) ─────────────────────────────────────────

const { portIntoWorker, detachFromWorker, isPortActive, getPortedWorkerId } =
  await import("../session-port.js");

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeWorkers(entries: Array<{ mid: string; state?: string; sessionFile?: string }>) {
  const workers = new Map<string, any>();
  for (const e of entries) {
    workers.set(e.mid, {
      milestoneId: e.mid,
      title: e.mid,
      pid: process.pid,
      process: null,
      worktreePath: `/tmp/wt-${e.mid}`,
      startedAt: Date.now(),
      state: e.state ?? "running",
      completedUnits: 0,
      cost: 0,
      stderrLines: [],
      restartCount: 0,
    });
  }
  return { active: true, workers, config: { max_workers: 2 }, totalCost: 0, startedAt: Date.now() };
}

function makeOpts(overrides: Partial<{
  switchSession: any;
  getSessionFile: any;
  pauseAutoMode: any;
  resumeAutoMode: any;
}> = {}) {
  return {
    cmdCtx: {
      sessionManager: {
        switchSession: overrides.switchSession ?? mock.fn(async (_path: string) => {}),
        getSessionFile: overrides.getSessionFile ?? mock.fn(() => "/coordinator/session.jsonl"),
      },
    },
    basePath: "/test/base",
    pauseAutoMode: overrides.pauseAutoMode ?? mock.fn(() => {}),
    resumeAutoMode: overrides.resumeAutoMode ?? mock.fn(() => {}),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("portIntoWorker()", () => {
  beforeEach(() => {
    trackerPortState = null;
    mockGetOrchestratorState = () => null;
    mockPersistState = () => {};
    mockReadSessionStatus = () => null;
    mockWaitForWorkerPause = async () => ({ paused: false, elapsedMs: 30000 });
    mockSendSignal = () => {};
  });

  afterEach(() => {
    trackerPortState = null;
  });

  it("successful port: pauses auto-mode, waits for handshake, switches session", async () => {
    const workerSessionFile = "/worker/M001/session.jsonl";
    mockGetOrchestratorState = () => makeWorkers([{ mid: "M001", state: "running" }]);
    mockReadSessionStatus = (_bp, mid) =>
      mid === "M001" ? { milestoneId: "M001", pid: process.pid, state: "running", sessionFile: workerSessionFile } : null;
    mockWaitForWorkerPause = async () => ({ paused: true, sessionFile: workerSessionFile, elapsedMs: 800 });

    const persistCalls: string[] = [];
    mockPersistState = (bp) => { persistCalls.push(bp); };

    const opts = makeOpts();
    const result = await portIntoWorker("M001", opts);

    assert.equal(result.success, true, `expected success, got: ${result.error}`);
    assert.ok(result.elapsedMs !== undefined && result.elapsedMs >= 0);

    // pauseAutoMode called
    assert.equal((opts.pauseAutoMode as any).mock.callCount(), 1, "pauseAutoMode should be called once");

    // switchSession called with worker session file
    assert.equal(
      (opts.cmdCtx.sessionManager.switchSession as any).mock.callCount(), 1,
      "switchSession should be called once",
    );
    assert.equal(
      (opts.cmdCtx.sessionManager.switchSession as any).mock.calls[0].arguments[0],
      workerSessionFile,
    );

    // Port state set in context tracker
    assert.ok(trackerPortState, "port state should be set");
    assert.equal(trackerPortState.portedWorkerMid, "M001");
    assert.equal(trackerPortState.coordinatorSessionFile, "/coordinator/session.jsonl");

    // persistState called (for crash recovery)
    assert.ok(persistCalls.length >= 1, "persistState should be called at least once");

    // resumeAutoMode NOT called (auto-mode stays paused while ported)
    assert.equal((opts.resumeAutoMode as any).mock.callCount(), 0, "resumeAutoMode should NOT be called on success");
  });

  it("fails when worker not found", async () => {
    mockGetOrchestratorState = () => makeWorkers([]); // no workers

    const opts = makeOpts();
    const result = await portIntoWorker("M001", opts);

    assert.equal(result.success, false);
    assert.ok(result.error?.includes("not found"));

    // pauseAutoMode NOT called
    assert.equal((opts.pauseAutoMode as any).mock.callCount(), 0, "pauseAutoMode should NOT be called");

    // switchSession NOT called
    assert.equal((opts.cmdCtx.sessionManager.switchSession as any).mock.callCount(), 0);
  });

  it("fails when worker has no sessionFile", async () => {
    mockGetOrchestratorState = () => makeWorkers([{ mid: "M001", state: "running" }]);
    mockReadSessionStatus = () => ({ milestoneId: "M001", pid: process.pid, state: "running" }); // no sessionFile

    const opts = makeOpts();
    const result = await portIntoWorker("M001", opts);

    assert.equal(result.success, false);
    assert.ok(result.error?.includes("no session file"));

    // pauseAutoMode NOT called
    assert.equal((opts.pauseAutoMode as any).mock.callCount(), 0);
  });

  it("fails when pause handshake times out — auto-mode resumed", async () => {
    mockGetOrchestratorState = () => makeWorkers([{ mid: "M001", state: "running" }]);
    mockReadSessionStatus = () => ({
      milestoneId: "M001", pid: process.pid, state: "running",
      sessionFile: "/worker/session.jsonl",
    });
    mockWaitForWorkerPause = async () => ({ paused: false, elapsedMs: 30000 });

    const opts = makeOpts();
    const result = await portIntoWorker("M001", opts);

    assert.equal(result.success, false);
    assert.ok(result.error?.includes("did not pause"));

    // pauseAutoMode was called (it pauses before sending handshake)
    assert.equal((opts.pauseAutoMode as any).mock.callCount(), 1);

    // resumeAutoMode called because port failed
    assert.equal((opts.resumeAutoMode as any).mock.callCount(), 1, "resumeAutoMode should be called after timeout");

    // Port state NOT set
    assert.equal(trackerPortState, null, "port state should not be set on timeout");
  });

  it("fails when switchSession throws — port state cleaned up, auto-mode resumed", async () => {
    mockGetOrchestratorState = () => makeWorkers([{ mid: "M001", state: "running" }]);
    mockReadSessionStatus = () => ({
      milestoneId: "M001", pid: process.pid, state: "running",
      sessionFile: "/worker/session.jsonl",
    });
    mockWaitForWorkerPause = async () => ({ paused: true, sessionFile: "/worker/session.jsonl", elapsedMs: 500 });

    const switchSession = mock.fn(async () => {
      throw new Error("Session switch exploded");
    });
    const opts = makeOpts({ switchSession });

    const result = await portIntoWorker("M001", opts);

    assert.equal(result.success, false);
    assert.ok(result.error?.includes("switchSession failed"));
    assert.ok(result.error?.includes("Session switch exploded"));

    // Port state cleaned up
    assert.equal(trackerPortState, null, "port state should be cleared on switchSession error");

    // Auto-mode resumed
    assert.equal((opts.resumeAutoMode as any).mock.callCount(), 1, "resumeAutoMode should be called after switchSession error");
  });

  it("fails when orchestrator is not active", async () => {
    mockGetOrchestratorState = () => null;

    const opts = makeOpts();
    const result = await portIntoWorker("M001", opts);

    assert.equal(result.success, false);
    assert.ok(result.error?.includes("not active"));
    assert.equal((opts.pauseAutoMode as any).mock.callCount(), 0);
  });
});

describe("detachFromWorker()", () => {
  beforeEach(() => {
    trackerPortState = null;
    mockGetOrchestratorState = () => null;
    mockPersistState = () => {};
    mockSendSignal = () => {};
  });

  afterEach(() => {
    trackerPortState = null;
  });

  it("successful detach: switches back, clears state, resumes worker + auto-mode", async () => {
    // Pre-set port state (simulating active port)
    trackerPortState = {
      coordinatorSessionFile: "/coordinator/session.jsonl",
      portedWorkerMid: "M001",
      portedAt: "2026-03-18T15:00:00.000Z",
    };

    const signalCalls: Array<{ bp: string; mid: string; sig: string }> = [];
    mockSendSignal = (bp, mid, sig) => { signalCalls.push({ bp, mid, sig }); };

    const persistCalls: string[] = [];
    mockPersistState = (bp) => { persistCalls.push(bp); };

    const opts = makeOpts();
    const result = await detachFromWorker(opts);

    assert.equal(result.success, true, `expected success, got: ${result.error}`);
    assert.ok(result.elapsedMs !== undefined && result.elapsedMs >= 0);

    // switchSession called with coordinator session file FIRST
    assert.equal(
      (opts.cmdCtx.sessionManager.switchSession as any).mock.callCount(), 1,
    );
    assert.equal(
      (opts.cmdCtx.sessionManager.switchSession as any).mock.calls[0].arguments[0],
      "/coordinator/session.jsonl",
    );

    // Port state cleared
    assert.equal(trackerPortState, null, "port state should be cleared");

    // Resume signal sent to worker
    assert.equal(signalCalls.length, 1);
    assert.equal(signalCalls[0].mid, "M001");
    assert.equal(signalCalls[0].sig, "resume");

    // persistState called
    assert.ok(persistCalls.length >= 1);

    // resumeAutoMode called
    assert.equal((opts.resumeAutoMode as any).mock.callCount(), 1);
  });

  it("fails when no port is active", async () => {
    // trackerPortState is null (no active port)

    const opts = makeOpts();
    const result = await detachFromWorker(opts);

    assert.equal(result.success, false);
    assert.ok(result.error?.includes("No active port"));

    // Nothing should be called
    assert.equal((opts.cmdCtx.sessionManager.switchSession as any).mock.callCount(), 0);
    assert.equal((opts.resumeAutoMode as any).mock.callCount(), 0);
  });

  it("best-effort recovery when switchSession throws during detach", async () => {
    trackerPortState = {
      coordinatorSessionFile: "/coordinator/session.jsonl",
      portedWorkerMid: "M001",
      portedAt: "2026-03-18T15:00:00.000Z",
    };

    const signalCalls: Array<{ bp: string; mid: string; sig: string }> = [];
    mockSendSignal = (bp, mid, sig) => { signalCalls.push({ bp, mid, sig }); };

    const switchSession = mock.fn(async () => {
      throw new Error("Detach switch failed");
    });
    const opts = makeOpts({ switchSession });

    const result = await detachFromWorker(opts);

    // Returns failure with error message
    assert.equal(result.success, false);
    assert.ok(result.error?.includes("Detach switch failed"));

    // But still does best-effort recovery:
    // Port state cleared
    assert.equal(trackerPortState, null, "port state should still be cleared");

    // Resume signal sent
    assert.equal(signalCalls.length, 1, "resume signal should still be sent");
    assert.equal(signalCalls[0].sig, "resume");

    // Auto-mode resumed
    assert.equal((opts.resumeAutoMode as any).mock.callCount(), 1, "resumeAutoMode should still be called");
  });
});

describe("convenience re-exports", () => {
  beforeEach(() => { trackerPortState = null; });
  afterEach(() => { trackerPortState = null; });

  it("isPortActive and getPortedWorkerId delegate to context-tracker mock", () => {
    assert.equal(isPortActive(), false);
    assert.equal(getPortedWorkerId(), null);

    trackerPortState = {
      coordinatorSessionFile: "/c/s.jsonl",
      portedWorkerMid: "M099",
      portedAt: "2026-01-01T00:00:00Z",
    };

    assert.equal(isPortActive(), true);
    assert.equal(getPortedWorkerId(), "M099");
  });
});
