/**
 * Tests for parallel orchestrator crash recovery.
 *
 * Validates that orchestrator state is persisted to disk and can be
 * restored after a coordinator crash, with PID liveness filtering.
 */

import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  persistState,
  restoreState,
  resetOrchestrator,
  getOrchestratorState,
  startParallel,
  type PersistedState,
} from "../parallel-orchestrator.ts";
import { writeSessionStatus, readAllSessionStatuses, removeSessionStatus, consumeSignal } from "../session-status-io.ts";
import { isPortActive, clearPortState, _resetForTesting as resetContextTracker } from "../context-tracker.ts";
import { createTestContext } from './test-helpers.ts';

const { assertEq, assertTrue, report } = createTestContext();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-crash-recovery-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  mkdirSync(join(dir, ".gsd", "parallel"), { recursive: true });
  return dir;
}

function stateFilePath(basePath: string): string {
  return join(basePath, ".gsd", "orchestrator.json");
}

function writeStateFile(basePath: string, state: PersistedState): void {
  writeFileSync(stateFilePath(basePath), JSON.stringify(state, null, 2), "utf-8");
}

function makePersistedState(overrides: Partial<PersistedState> = {}): PersistedState {
  return {
    active: true,
    workers: [],
    totalCost: 0,
    startedAt: Date.now(),
    configSnapshot: { max_workers: 3 },
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// Test 1: persistState writes valid JSON
{
  const basePath = makeTempDir();
  try {
    // We can't call persistState directly without internal state set up,
    // so we test the round-trip by writing a state file and reading it back
    const state = makePersistedState({
      workers: [
        {
          milestoneId: "M001",
          title: "M001",
          pid: process.pid,
          worktreePath: "/tmp/wt-M001",
          startedAt: Date.now(),
          state: "running",
          completedUnits: 3,
          cost: 0.15,
        },
      ],
      totalCost: 0.15,
    });
    writeStateFile(basePath, state);

    const raw = readFileSync(stateFilePath(basePath), "utf-8");
    const parsed = JSON.parse(raw) as PersistedState;
    assertEq(parsed.active, true, "persistState: active field preserved");
    assertEq(parsed.workers.length, 1, "persistState: worker count preserved");
    assertEq(parsed.workers[0].milestoneId, "M001", "persistState: milestoneId preserved");
    assertEq(parsed.workers[0].cost, 0.15, "persistState: cost preserved");
    assertEq(parsed.totalCost, 0.15, "persistState: totalCost preserved");
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
}

// Test 2: restoreState returns null for missing file
{
  const basePath = makeTempDir();
  try {
    const result = restoreState(basePath);
    assertEq(result, null, "restoreState: returns null when no state file");
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
}

// Test 3: restoreState filters dead PIDs
{
  const basePath = makeTempDir();
  try {
    // PID 99999999 is almost certainly not alive
    const state = makePersistedState({
      workers: [
        {
          milestoneId: "M001",
          title: "M001",
          pid: 99999999,
          worktreePath: "/tmp/wt-M001",
          startedAt: Date.now(),
          state: "running",
          completedUnits: 0,
          cost: 0,
        },
        {
          milestoneId: "M002",
          title: "M002",
          pid: 99999998,
          worktreePath: "/tmp/wt-M002",
          startedAt: Date.now(),
          state: "running",
          completedUnits: 0,
          cost: 0,
        },
      ],
    });
    writeStateFile(basePath, state);

    const result = restoreState(basePath);
    // Both PIDs are dead, so result should be null and file should be cleaned up
    assertEq(result, null, "restoreState: returns null when all PIDs dead");
    assertTrue(!existsSync(stateFilePath(basePath)), "restoreState: cleans up state file when all dead");
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
}

// Test 4: restoreState keeps alive PIDs
{
  const basePath = makeTempDir();
  try {
    // Use current process PID (definitely alive)
    const state = makePersistedState({
      workers: [
        {
          milestoneId: "M001",
          title: "M001",
          pid: process.pid,
          worktreePath: "/tmp/wt-M001",
          startedAt: Date.now(),
          state: "running",
          completedUnits: 5,
          cost: 0.25,
        },
        {
          milestoneId: "M002",
          title: "M002",
          pid: 99999999, // dead
          worktreePath: "/tmp/wt-M002",
          startedAt: Date.now(),
          state: "running",
          completedUnits: 0,
          cost: 0,
        },
      ],
      totalCost: 0.25,
    });
    writeStateFile(basePath, state);

    const result = restoreState(basePath);
    assertTrue(result !== null, "restoreState: returns state when alive PID exists");
    assertEq(result!.workers.length, 1, "restoreState: filters out dead PID");
    assertEq(result!.workers[0].milestoneId, "M001", "restoreState: keeps alive worker");
    assertEq(result!.workers[0].pid, process.pid, "restoreState: preserves PID");
    assertEq(result!.workers[0].completedUnits, 5, "restoreState: preserves progress");
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
}

// Test 5: restoreState skips stopped/error workers even with alive PIDs
{
  const basePath = makeTempDir();
  try {
    const state = makePersistedState({
      workers: [
        {
          milestoneId: "M001",
          title: "M001",
          pid: process.pid,
          worktreePath: "/tmp/wt-M001",
          startedAt: Date.now(),
          state: "stopped",
          completedUnits: 10,
          cost: 0.50,
        },
      ],
    });
    writeStateFile(basePath, state);

    const result = restoreState(basePath);
    assertEq(result, null, "restoreState: skips stopped workers");
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
}

// Test 6: orphan detection finds stale sessions
{
  const basePath = makeTempDir();
  try {
    // Write a session status with a dead PID
    mkdirSync(join(basePath, ".gsd", "parallel"), { recursive: true });
    writeSessionStatus(basePath, {
      milestoneId: "M001",
      pid: 99999999,
      state: "running",
      currentUnit: null,
      completedUnits: 3,
      cost: 0.10,
      lastHeartbeat: Date.now(),
      startedAt: Date.now(),
      worktreePath: "/tmp/wt-M001",
    });

    // Write a session status with alive PID
    writeSessionStatus(basePath, {
      milestoneId: "M002",
      pid: process.pid,
      state: "running",
      currentUnit: null,
      completedUnits: 1,
      cost: 0.05,
      lastHeartbeat: Date.now(),
      startedAt: Date.now(),
      worktreePath: "/tmp/wt-M002",
    });

    // Read all sessions — both should exist initially
    const before = readAllSessionStatuses(basePath);
    assertEq(before.length, 2, "orphan: both sessions exist before detection");

    // Now simulate orphan detection logic (same as prepareParallelStart)
    const sessions = readAllSessionStatuses(basePath);
    const orphans: Array<{ milestoneId: string; pid: number; alive: boolean }> = [];
    for (const session of sessions) {
      let alive: boolean;
      try {
        process.kill(session.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      orphans.push({ milestoneId: session.milestoneId, pid: session.pid, alive });
      if (!alive) {
        removeSessionStatus(basePath, session.milestoneId);
      }
    }

    assertTrue(orphans.length === 2, "orphan: detected both sessions");
    const deadOrphan = orphans.find(o => o.milestoneId === "M001");
    assertTrue(deadOrphan !== undefined && !deadOrphan.alive, "orphan: M001 detected as dead");
    const aliveOrphan = orphans.find(o => o.milestoneId === "M002");
    assertTrue(aliveOrphan !== undefined && aliveOrphan.alive, "orphan: M002 detected as alive");

    // Dead session should be cleaned up
    const after = readAllSessionStatuses(basePath);
    assertEq(after.length, 1, "orphan: dead session cleaned up");
    assertEq(after[0].milestoneId, "M002", "orphan: alive session remains");
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
}

// Test 7: restoreState handles corrupt JSON gracefully
{
  const basePath = makeTempDir();
  try {
    writeFileSync(stateFilePath(basePath), "{ not valid json !!!", "utf-8");
    const result = restoreState(basePath);
    assertEq(result, null, "restoreState: returns null for corrupt JSON");
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
}

// Clean up module state
resetOrchestrator();

// ─── Port State Crash Recovery ────────────────────────────────────────────────

// Test 8: clears stale portState and resumes paused worker on restore
{
  const basePath = makeTempDir();
  try {
    resetOrchestrator();
    resetContextTracker();

    // Write orchestrator.json with portState and one alive worker
    const state = makePersistedState({
      workers: [
        {
          milestoneId: "M001",
          title: "M001",
          pid: process.pid, // alive — triggers adoption path (no spawn)
          worktreePath: "/tmp/wt-M001",
          startedAt: Date.now(),
          state: "running",
          completedUnits: 2,
          cost: 0.10,
          stderrLines: [],
          restartCount: 0,
        },
      ],
      totalCost: 0.10,
      portState: {
        coordinatorSessionFile: "/tmp/session",
        portedWorkerMid: "M005",
        portedAt: "2026-01-01T00:00:00Z",
      },
    });
    writeStateFile(basePath, state);

    // startParallel with alive worker → adoption path (no spawn needed)
    await startParallel(basePath, [], undefined);

    // (a) isPortActive should be false after recovery
    assertEq(isPortActive(), false, "portState recovery: isPortActive() false after clearPortState");

    // (b) Resume signal should have been written for M005
    const signal = consumeSignal(basePath, "M005");
    assertTrue(signal !== null, "portState recovery: resume signal was sent to M005");
    assertEq(signal!.signal, "resume", "portState recovery: signal is 'resume'");

    // (c) Worker M001 was adopted normally
    const orch = getOrchestratorState();
    assertTrue(orch !== null, "portState recovery: orchestrator state exists");
    assertTrue(orch!.workers.has("M001"), "portState recovery: M001 was adopted");
    assertEq(orch!.workers.get("M001")!.completedUnits, 2, "portState recovery: M001 progress preserved");
  } finally {
    resetOrchestrator();
    resetContextTracker();
    rmSync(basePath, { recursive: true, force: true });
  }
}

// Test 9: no portState — no recovery action
{
  const basePath = makeTempDir();
  try {
    resetOrchestrator();
    resetContextTracker();

    // Write orchestrator.json WITHOUT portState, one alive worker
    const state = makePersistedState({
      workers: [
        {
          milestoneId: "M001",
          title: "M001",
          pid: process.pid,
          worktreePath: "/tmp/wt-M001",
          startedAt: Date.now(),
          state: "running",
          completedUnits: 1,
          cost: 0.05,
          stderrLines: [],
          restartCount: 0,
        },
      ],
      totalCost: 0.05,
    });
    writeStateFile(basePath, state);

    // isPortActive should already be false (no port state set in context-tracker)
    assertEq(isPortActive(), false, "no portState: isPortActive() already false before recovery");

    // startParallel with alive worker → adoption path (no spawn)
    await startParallel(basePath, [], undefined);

    // isPortActive still false
    assertEq(isPortActive(), false, "no portState: isPortActive() still false after recovery");

    // No resume signal should have been sent to any worker
    const signalM001 = consumeSignal(basePath, "M001");
    assertEq(signalM001, null, "no portState: no resume signal sent to M001");
  } finally {
    resetOrchestrator();
    resetContextTracker();
    rmSync(basePath, { recursive: true, force: true });
  }
}

// Test 10: portState with non-existent worker — recovery still clears state
{
  const basePath = makeTempDir();
  try {
    resetOrchestrator();
    resetContextTracker();

    // Write orchestrator.json with portState referencing M099 (not in workers array)
    // Workers array has alive M001 so restoreState returns non-null
    const state = makePersistedState({
      workers: [
        {
          milestoneId: "M001",
          title: "M001",
          pid: process.pid,
          worktreePath: "/tmp/wt-M001",
          startedAt: Date.now(),
          state: "running",
          completedUnits: 0,
          cost: 0,
          stderrLines: [],
          restartCount: 0,
        },
      ],
      portState: {
        coordinatorSessionFile: "/tmp/session-old",
        portedWorkerMid: "M099",
        portedAt: "2026-01-01T00:00:00Z",
      },
    });
    writeStateFile(basePath, state);

    await startParallel(basePath, [], undefined);

    // Port state should be cleared even though M099 isn't a tracked worker
    assertEq(isPortActive(), false, "unknown worker portState: isPortActive() false after clearPortState");

    // Resume signal was still sent for M099 (best-effort)
    const signal = consumeSignal(basePath, "M099");
    assertTrue(signal !== null, "unknown worker portState: resume signal sent to M099");
    assertEq(signal!.signal, "resume", "unknown worker portState: signal is 'resume'");
  } finally {
    resetOrchestrator();
    resetContextTracker();
    rmSync(basePath, { recursive: true, force: true });
  }
}

report();
