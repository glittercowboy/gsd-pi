/**
 * Tests for session port protocol extensions:
 * - SessionStatus.sessionFile field serialization
 * - waitForWorkerPause() handshake (success, timeout, dead PID)
 * - PersistedState.portState round-trip
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  writeSessionStatus,
  readSessionStatus,
  waitForWorkerPause,
  type SessionStatus,
} from "../session-status-io.js";

import {
  persistState,
  restoreState,
  startParallel,
  resetOrchestrator,
  type PersistedState,
} from "../parallel-orchestrator.js";

import {
  setPortState,
  clearPortState,
  _resetForTesting as resetContextTracker,
} from "../context-tracker.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-port-protocol-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function makeStatus(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    milestoneId: "M001",
    pid: process.pid,
    state: "running",
    currentUnit: null,
    completedUnits: 0,
    cost: 0,
    lastHeartbeat: Date.now(),
    startedAt: Date.now() - 5000,
    worktreePath: "/tmp/test-worktree",
    ...overrides,
  };
}

/**
 * Write a raw persisted state JSON to the orchestrator file.
 * Used to test restoreState() independently of the orchestrator's module state.
 */
function writePersistedState(basePath: string, data: PersistedState): void {
  const dir = join(basePath, ".gsd");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const dest = join(dir, "orchestrator.json");
  const tmp = dest + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, dest);
}

function readPersistedStateRaw(basePath: string): PersistedState | null {
  try {
    const p = join(basePath, ".gsd", "orchestrator.json");
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8")) as PersistedState;
  } catch {
    return null;
  }
}

// ─── SessionStatus.sessionFile round-trip ────────────────────────────────

describe("SessionStatus.sessionFile", () => {
  let base: string;
  beforeEach(() => { base = makeTmpBase(); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  it("serializes and deserializes sessionFile correctly", () => {
    const status = makeStatus({
      sessionFile: "/home/user/.pi/agent/sessions/--Users-test--/2026-03-18T12-00-00.jsonl",
    });
    writeSessionStatus(base, status);
    const read = readSessionStatus(base, status.milestoneId);
    assert.ok(read, "status should be readable");
    assert.equal(read.sessionFile, status.sessionFile);
  });

  it("omits sessionFile when not provided", () => {
    const status = makeStatus(); // no sessionFile
    writeSessionStatus(base, status);
    const read = readSessionStatus(base, status.milestoneId);
    assert.ok(read, "status should be readable");
    assert.equal(read.sessionFile, undefined);
  });
});

// ─── waitForWorkerPause ──────────────────────────────────────────────────

describe("waitForWorkerPause()", () => {
  let base: string;
  beforeEach(() => { base = makeTmpBase(); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  it("succeeds when worker transitions to paused with sessionFile", async () => {
    const mid = "M001";
    // Write initial running status
    writeSessionStatus(base, makeStatus({ milestoneId: mid, state: "running" }));

    // After 600ms, update the status to paused with sessionFile
    const timer = setTimeout(() => {
      writeSessionStatus(base, makeStatus({
        milestoneId: mid,
        state: "paused",
        sessionFile: "/tmp/test-session.jsonl",
      }));
    }, 600);

    const result = await waitForWorkerPause(base, mid, 5000);

    clearTimeout(timer);
    assert.equal(result.paused, true);
    assert.equal(result.sessionFile, "/tmp/test-session.jsonl");
    assert.ok(result.elapsedMs >= 500, `expected >= 500ms elapsed, got ${result.elapsedMs}`);
    assert.ok(result.elapsedMs < 5000, `expected < 5000ms elapsed, got ${result.elapsedMs}`);
  });

  it("times out when worker stays running", async () => {
    const mid = "M002";
    writeSessionStatus(base, makeStatus({ milestoneId: mid, state: "running" }));

    const result = await waitForWorkerPause(base, mid, 1200);

    assert.equal(result.paused, false);
    assert.equal(result.sessionFile, undefined);
    assert.ok(result.elapsedMs >= 1000, `expected >= 1000ms elapsed, got ${result.elapsedMs}`);
  });

  it("detects dead process and returns quickly", async () => {
    const mid = "M003";
    // Use a PID that definitely doesn't exist
    const deadPid = 2147483647;
    writeSessionStatus(base, makeStatus({
      milestoneId: mid,
      state: "running",
      pid: deadPid,
    }));

    const result = await waitForWorkerPause(base, mid, 10_000);

    assert.equal(result.paused, false);
    // Should return in under 2 seconds (much faster than the 10s timeout)
    assert.ok(result.elapsedMs < 2000, `expected quick return for dead PID, got ${result.elapsedMs}ms`);
  });

  it("sends pause signal before polling", () => {
    const mid = "M004";
    writeSessionStatus(base, makeStatus({ milestoneId: mid, state: "running" }));

    // Start the wait but don't await — just check that the signal file is created
    const promise = waitForWorkerPause(base, mid, 500);

    // Signal file should exist immediately after the call starts
    const signalPath = join(base, ".gsd", "parallel", `${mid}.signal.json`);
    // Give a brief moment for the sync sendSignal to execute
    const checkSignal = () => {
      if (existsSync(signalPath)) {
        const raw = JSON.parse(readFileSync(signalPath, "utf-8"));
        assert.equal(raw.signal, "pause");
        return true;
      }
      return false;
    };

    // The signal should be written synchronously before any polling
    assert.ok(checkSignal(), "pause signal file should exist immediately");

    // Wait for the promise to settle
    return promise.then(() => {});
  });
});

// ─── PersistedState.portState ────────────────────────────────────────────

describe("PersistedState.portState", () => {
  let base: string;
  beforeEach(() => {
    base = makeTmpBase();
    resetOrchestrator();
    resetContextTracker();
  });
  afterEach(() => {
    resetOrchestrator();
    resetContextTracker();
    rmSync(base, { recursive: true, force: true });
  });

  it("round-trips portState through persist/restore via raw JSON", () => {
    const portStateData = {
      coordinatorSessionFile: "/home/user/.pi/agent/sessions/--coord--/session.jsonl",
      portedWorkerMid: "M005",
      portedAt: "2026-03-18T15:30:00.000Z",
    };

    // Write a persisted state with portState directly to disk
    const persisted: PersistedState = {
      active: true,
      workers: [{
        milestoneId: "M005",
        title: "M005",
        pid: process.pid,
        worktreePath: "/tmp/wt",
        startedAt: Date.now(),
        state: "running",
        completedUnits: 0,
        cost: 0,
        stderrLines: [],
        restartCount: 0,
      }],
      totalCost: 0,
      startedAt: Date.now(),
      configSnapshot: { max_workers: 2 },
      portState: portStateData,
    };
    writePersistedState(base, persisted);

    // restoreState should return the portState
    const restored = restoreState(base);
    assert.ok(restored, "should restore state");
    assert.deepStrictEqual(restored.portState, portStateData);
  });

  it("restores without portState when not present", () => {
    const persisted: PersistedState = {
      active: true,
      workers: [{
        milestoneId: "M006",
        title: "M006",
        pid: process.pid,
        worktreePath: "/tmp/wt",
        startedAt: Date.now(),
        state: "running",
        completedUnits: 0,
        cost: 0,
        stderrLines: [],
        restartCount: 0,
      }],
      totalCost: 0,
      startedAt: Date.now(),
      configSnapshot: { max_workers: 2 },
    };
    writePersistedState(base, persisted);

    const restored = restoreState(base);
    assert.ok(restored, "should restore state");
    assert.equal(restored.portState, undefined);
  });

  it("persistState includes portState when context-tracker reports active port", async () => {
    // Set port state in context-tracker
    setPortState({
      coordinatorSessionFile: "/coord/session.jsonl",
      portedWorkerMid: "M007",
      portedAt: "2026-03-18T16:00:00.000Z",
    });

    // Start parallel to initialize orchestrator module state
    // (persistState only writes when module state exists)
    const result = await startParallel(base, ["M007"], undefined);
    // startParallel calls persistState internally

    // Read the raw JSON and check portState
    const raw = readPersistedStateRaw(base);
    assert.ok(raw, "orchestrator.json should exist");
    assert.ok(raw.portState, "portState should be present");
    assert.equal(raw.portState!.coordinatorSessionFile, "/coord/session.jsonl");
    assert.equal(raw.portState!.portedWorkerMid, "M007");
    assert.equal(raw.portState!.portedAt, "2026-03-18T16:00:00.000Z");
  });

  it("persistState omits portState when no active port", async () => {
    // Ensure no port state is set
    clearPortState();

    const result = await startParallel(base, ["M008"], undefined);

    const raw = readPersistedStateRaw(base);
    assert.ok(raw, "orchestrator.json should exist");
    assert.equal(raw.portState, undefined);
  });
});
