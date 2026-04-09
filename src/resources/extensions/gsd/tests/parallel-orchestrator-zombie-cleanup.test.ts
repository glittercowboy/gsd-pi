/**
 * Regression tests for zombie worker cleanup (#2736).
 *
 * Verifies that:
 * 1. refreshWorkerStatuses() deactivates the orchestrator when all workers
 *    are in terminal states (error/stopped).
 * 2. restoreRuntimeState() (via getWorkerStatuses) returns empty when the
 *    cached state has only dead workers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  persistState,
  resetOrchestrator,
  refreshWorkerStatuses,
  isParallelActive,
  getOrchestratorState,
  getWorkerStatuses,
  type PersistedState,
} from "../parallel-orchestrator.ts";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-test-zombie-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "parallel"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch { /* non-fatal */ }
}

/** Write a fake orchestrator.json to simulate persisted state. */
function writePersistedState(basePath: string, data: PersistedState): void {
  const dest = join(basePath, ".gsd", "orchestrator.json");
  writeFileSync(dest, JSON.stringify(data, null, 2), "utf-8");
}

/** Write a fake session status file to .gsd/parallel/<milestoneId>.status.json */
function writeSessionStatusFile(
  basePath: string,
  milestoneId: string,
  state: "running" | "paused" | "stopped" | "error",
  pid: number,
): void {
  const dest = join(basePath, ".gsd", "parallel", `${milestoneId}.status.json`);
  writeFileSync(
    dest,
    JSON.stringify({
      milestoneId,
      pid,
      state,
      currentUnit: null,
      completedUnits: 0,
      cost: 0.5,
      lastHeartbeat: Date.now(),
      startedAt: Date.now() - 60_000,
      worktreePath: join(basePath, "worktrees", milestoneId),
    }),
    "utf-8",
  );
}

// Use a PID that is guaranteed dead — PID 1 is init/launchd and won't be
// killable by this process, but 2147483647 is unlikely to exist.
const DEAD_PID = 2147483647;

// ─── refreshWorkerStatuses: deactivates when all workers dead ──────────

test("#2736: refreshWorkerStatuses deactivates orchestrator when all workers are error/stopped", (t) => {
  const base = makeTmpBase();
  t.after(() => {
    resetOrchestrator();
    cleanup(base);
  });

  // Seed persisted state with two workers using current PID (alive) so
  // restoreState() accepts them, then immediately mark them as error via
  // session status files so refreshWorkerStatuses sees terminal states.
  const persisted: PersistedState = {
    active: true,
    workers: [
      {
        milestoneId: "M001",
        title: "Milestone 1",
        pid: process.pid, // alive PID so restoreState accepts it
        worktreePath: join(base, "worktrees", "M001"),
        startedAt: Date.now() - 60_000,
        state: "running",
        cost: 1.0,
      },
      {
        milestoneId: "M002",
        title: "Milestone 2",
        pid: process.pid,
        worktreePath: join(base, "worktrees", "M002"),
        startedAt: Date.now() - 60_000,
        state: "running",
        cost: 0.5,
      },
    ],
    totalCost: 1.5,
    startedAt: Date.now() - 60_000,
    configSnapshot: { max_workers: 3 },
  };
  writePersistedState(base, persisted);

  // First, restore the state into memory via getWorkerStatuses (triggers restoreIfNeeded)
  const workers = getWorkerStatuses(base);
  assert.equal(workers.length, 2, "should have 2 workers after restore");
  assert.ok(isParallelActive(), "orchestrator should be active after restore");

  // Now write session status files marking both workers as error
  writeSessionStatusFile(base, "M001", "error", process.pid);
  writeSessionStatusFile(base, "M002", "error", process.pid);

  // Refresh — should detect all-dead and deactivate
  refreshWorkerStatuses(base);

  assert.equal(isParallelActive(), false, "orchestrator should be inactive after all workers died");
  assert.equal(getOrchestratorState(), null, "state should be null after cleanup");
});

test("#2736: refreshWorkerStatuses keeps orchestrator active when some workers are still running", (t) => {
  const base = makeTmpBase();
  t.after(() => {
    resetOrchestrator();
    cleanup(base);
  });

  const persisted: PersistedState = {
    active: true,
    workers: [
      {
        milestoneId: "M001",
        title: "Milestone 1",
        pid: process.pid,
        worktreePath: join(base, "worktrees", "M001"),
        startedAt: Date.now() - 60_000,
        state: "running",
        cost: 1.0,
      },
      {
        milestoneId: "M002",
        title: "Milestone 2",
        pid: process.pid,
        worktreePath: join(base, "worktrees", "M002"),
        startedAt: Date.now() - 60_000,
        state: "running",
        cost: 0.5,
      },
    ],
    totalCost: 1.5,
    startedAt: Date.now() - 60_000,
    configSnapshot: { max_workers: 3 },
  };
  writePersistedState(base, persisted);

  // Restore state
  getWorkerStatuses(base);

  // Mark M001 as error but keep M002 running
  writeSessionStatusFile(base, "M001", "error", process.pid);
  writeSessionStatusFile(base, "M002", "running", process.pid);

  refreshWorkerStatuses(base);

  assert.ok(isParallelActive(), "orchestrator should remain active with a running worker");
  assert.ok(getOrchestratorState() !== null, "state should still exist");
});

// ─── restoreRuntimeState: returns false when cached state has only dead workers ─

test("#2736: getWorkerStatuses returns empty when all cached workers are in error state", (t) => {
  const base = makeTmpBase();
  t.after(() => {
    resetOrchestrator();
    cleanup(base);
  });

  // First, set up active state with live workers
  const persisted: PersistedState = {
    active: true,
    workers: [
      {
        milestoneId: "M001",
        title: "Milestone 1",
        pid: process.pid,
        worktreePath: join(base, "worktrees", "M001"),
        startedAt: Date.now() - 60_000,
        state: "running",
        cost: 0.5,
      },
    ],
    totalCost: 0.5,
    startedAt: Date.now() - 60_000,
    configSnapshot: { max_workers: 3 },
  };
  writePersistedState(base, persisted);

  // Restore into memory
  getWorkerStatuses(base);
  assert.ok(isParallelActive(), "should be active initially");

  // Simulate all workers dying: write error status then refresh to update
  writeSessionStatusFile(base, "M001", "error", process.pid);
  refreshWorkerStatuses(base);

  // State should now be cleared
  assert.equal(getOrchestratorState(), null, "state should be null after all workers error");

  // Reset and try again — getWorkerStatuses with restoreIfNeeded should
  // find no live workers on disk (orchestrator.json was cleaned up)
  const workers = getWorkerStatuses(base);
  assert.equal(workers.length, 0, "should return empty when no live workers exist");
});

test("#2736: restoreRuntimeState clears stale state when all workers are stopped", (t) => {
  const base = makeTmpBase();
  t.after(() => {
    resetOrchestrator();
    cleanup(base);
  });

  // Set up and restore state
  const persisted: PersistedState = {
    active: true,
    workers: [
      {
        milestoneId: "M001",
        title: "Milestone 1",
        pid: process.pid,
        worktreePath: join(base, "worktrees", "M001"),
        startedAt: Date.now() - 60_000,
        state: "running",
        cost: 0.3,
      },
      {
        milestoneId: "M002",
        title: "Milestone 2",
        pid: process.pid,
        worktreePath: join(base, "worktrees", "M002"),
        startedAt: Date.now() - 60_000,
        state: "running",
        cost: 0.7,
      },
    ],
    totalCost: 1.0,
    startedAt: Date.now() - 60_000,
    configSnapshot: { max_workers: 3 },
  };
  writePersistedState(base, persisted);

  // Restore into memory
  getWorkerStatuses(base);
  assert.ok(isParallelActive(), "should be active initially");

  // Mark all as stopped via session status, then refresh
  writeSessionStatusFile(base, "M001", "stopped", process.pid);
  writeSessionStatusFile(base, "M002", "stopped", process.pid);
  refreshWorkerStatuses(base);

  // Orchestrator should be deactivated and state cleaned
  assert.equal(isParallelActive(), false, "should be inactive after all workers stopped");
  assert.equal(getOrchestratorState(), null, "state should be null");

  // Verify the state file was removed
  const stateFile = join(base, ".gsd", "orchestrator.json");
  assert.equal(existsSync(stateFile), false, "orchestrator.json should be removed");
});
