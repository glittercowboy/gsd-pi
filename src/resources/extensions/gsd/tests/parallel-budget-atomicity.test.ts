/**
 * parallel-budget-atomicity.test.ts — Budget enforcement tests for parallel orchestration (G6).
 *
 * Verifies that the budget ceiling cannot be exceeded through race conditions
 * or incorrect cost aggregation. Tests the single-writer architecture:
 * workers emit costs via session status files, the coordinator reads them
 * sequentially via refreshWorkerStatuses().
 *
 * Covers:
 *   - Ceiling enforcement: isBudgetExceeded returns true above ceiling
 *   - Cost aggregation: sum across all workers is correct
 *   - No double-counting: multiple refreshes don't accumulate
 *   - Budget reset: totalCost clears after resetOrchestrator
 *   - No budget ceiling: isBudgetExceeded returns false when ceiling unset
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  startParallel,
  getAggregateCost,
  isBudgetExceeded,
  refreshWorkerStatuses,
  resetOrchestrator,
  getOrchestratorState,
  isParallelActive,
  getWorkerStatuses,
} from "../parallel-orchestrator.ts";
import {
  writeSessionStatus,
  readSessionStatus,
  removeSessionStatus,
} from "../session-status-io.ts";
import type { GSDPreferences } from "../preferences.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-budget-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
}

function makePrefs(ceiling?: number): GSDPreferences {
  return {
    parallel: {
      enabled: true,
      max_workers: 2,
      budget_ceiling: ceiling,
      merge_strategy: "per-milestone",
      auto_merge: "confirm",
    },
  };
}

/** Write a session status file for a milestone with a specific cost. */
function writeWorkerCost(
  base: string,
  milestoneId: string,
  cost: number,
): void {
  writeSessionStatus(base, {
    milestoneId,
    pid: process.pid,
    state: "running",
    currentUnit: null,
    cost,
    lastHeartbeat: Date.now(),
    startedAt: Date.now() - 60000,
    worktreePath: join(base, ".gsd", "worktrees", milestoneId.toLowerCase()),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Ceiling Enforcement
// ═══════════════════════════════════════════════════════════════════════════════

test("budget — isBudgetExceeded returns true when totalCost >= ceiling", async () => {
  const base = makeTmpBase();
  try {
    await startParallel(base, ["M001", "M002"], makePrefs(1.0));

    // Initial state: cost is 0, not exceeded
    assert.equal(getAggregateCost(), 0);
    assert.equal(isBudgetExceeded(), false);

    // Write costs that exceed the $1.00 ceiling
    writeWorkerCost(base, "M001", 0.6);
    writeWorkerCost(base, "M002", 0.5);
    refreshWorkerStatuses(base);

    // Total: 0.6 + 0.5 = 1.1 > 1.0
    assert.ok(getAggregateCost() >= 1.0, `aggregate cost should be >= 1.0, got ${getAggregateCost()}`);
    assert.equal(isBudgetExceeded(), true, "should be exceeded at 1.1 vs ceiling 1.0");
  } finally {
    resetOrchestrator();
    cleanup(base);
  }
});

test("budget — isBudgetExceeded returns false when totalCost < ceiling", async () => {
  const base = makeTmpBase();
  try {
    await startParallel(base, ["M001", "M002"], makePrefs(5.0));

    writeWorkerCost(base, "M001", 1.0);
    writeWorkerCost(base, "M002", 1.5);
    refreshWorkerStatuses(base);

    // Total: 1.0 + 1.5 = 2.5 < 5.0
    assert.equal(getAggregateCost(), 2.5);
    assert.equal(isBudgetExceeded(), false, "should not be exceeded at 2.5 vs ceiling 5.0");
  } finally {
    resetOrchestrator();
    cleanup(base);
  }
});

test("budget — isBudgetExceeded returns true at exact ceiling", async () => {
  const base = makeTmpBase();
  try {
    await startParallel(base, ["M001"], makePrefs(2.0));

    writeWorkerCost(base, "M001", 2.0);
    refreshWorkerStatuses(base);

    assert.equal(getAggregateCost(), 2.0);
    assert.equal(isBudgetExceeded(), true, "should be exceeded at exact ceiling");
  } finally {
    resetOrchestrator();
    cleanup(base);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cost Aggregation
// ═══════════════════════════════════════════════════════════════════════════════

test("budget — cost aggregation sums all worker costs correctly", async () => {
  const base = makeTmpBase();
  try {
    await startParallel(base, ["M001", "M002"], makePrefs(100.0));

    writeWorkerCost(base, "M001", 3.14159);
    writeWorkerCost(base, "M002", 2.71828);
    refreshWorkerStatuses(base);

    const expected = 3.14159 + 2.71828;
    const actual = getAggregateCost();
    assert.ok(
      Math.abs(actual - expected) < 0.0001,
      `cost should be ~${expected}, got ${actual}`,
    );
  } finally {
    resetOrchestrator();
    cleanup(base);
  }
});

test("budget — worker cost update reflects in aggregate after refresh", async () => {
  const base = makeTmpBase();
  try {
    await startParallel(base, ["M001"], makePrefs(10.0));

    // Initial cost
    writeWorkerCost(base, "M001", 0.5);
    refreshWorkerStatuses(base);
    assert.equal(getAggregateCost(), 0.5);

    // Cost increases as worker progresses
    writeWorkerCost(base, "M001", 1.5);
    refreshWorkerStatuses(base);
    assert.equal(getAggregateCost(), 1.5, "should reflect updated cost, not accumulated");

    // Cost increases again
    writeWorkerCost(base, "M001", 3.0);
    refreshWorkerStatuses(base);
    assert.equal(getAggregateCost(), 3.0);
  } finally {
    resetOrchestrator();
    cleanup(base);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// No Double-Counting
// ═══════════════════════════════════════════════════════════════════════════════

test("budget — multiple refreshes don't accumulate cost", async () => {
  const base = makeTmpBase();
  try {
    await startParallel(base, ["M001", "M002"], makePrefs(10.0));

    writeWorkerCost(base, "M001", 0.5);
    writeWorkerCost(base, "M002", 0.3);

    // Refresh multiple times
    refreshWorkerStatuses(base);
    refreshWorkerStatuses(base);
    refreshWorkerStatuses(base);
    refreshWorkerStatuses(base);
    refreshWorkerStatuses(base);

    // Cost should be 0.5 + 0.3 = 0.8 regardless of how many refreshes
    assert.equal(getAggregateCost(), 0.8, "cost should be 0.8 after 5 refreshes");
  } finally {
    resetOrchestrator();
    cleanup(base);
  }
});

test("budget — refresh between cost updates tracks correctly", async () => {
  const base = makeTmpBase();
  try {
    await startParallel(base, ["M001", "M002"], makePrefs(10.0));

    // Round 1: M001 has cost, M002 doesn't yet
    writeWorkerCost(base, "M001", 0.5);
    refreshWorkerStatuses(base);
    const cost1 = getAggregateCost();

    // Round 2: both workers have cost
    writeWorkerCost(base, "M002", 0.7);
    refreshWorkerStatuses(base);
    const cost2 = getAggregateCost();

    // Round 3: M001 cost increased
    writeWorkerCost(base, "M001", 1.2);
    refreshWorkerStatuses(base);
    const cost3 = getAggregateCost();

    assert.equal(cost1, 0.5, "round 1: only M001");
    assert.equal(cost2, 1.2, "round 2: M001 + M002");
    assert.equal(cost3, 1.9, "round 3: updated M001 + M002");
  } finally {
    resetOrchestrator();
    cleanup(base);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Budget Reset
// ═══════════════════════════════════════════════════════════════════════════════

test("budget — resetOrchestrator clears totalCost", async () => {
  const base = makeTmpBase();
  try {
    await startParallel(base, ["M001"], makePrefs(10.0));

    writeWorkerCost(base, "M001", 5.0);
    refreshWorkerStatuses(base);
    assert.equal(getAggregateCost(), 5.0, "cost should be 5.0 before reset");

    resetOrchestrator();

    assert.equal(getAggregateCost(), 0, "cost should be 0 after reset");
    assert.equal(isBudgetExceeded(), false, "should not be exceeded after reset");
    assert.equal(isParallelActive(), false, "should not be active after reset");
    assert.equal(getOrchestratorState(), null, "state should be null after reset");
  } finally {
    resetOrchestrator();
    cleanup(base);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// No Budget Ceiling
// ═══════════════════════════════════════════════════════════════════════════════

test("budget — isBudgetExceeded returns false when no ceiling configured", async () => {
  const base = makeTmpBase();
  try {
    // No budget_ceiling set (undefined)
    await startParallel(base, ["M001"], makePrefs(undefined));

    writeWorkerCost(base, "M001", 999.99);
    refreshWorkerStatuses(base);

    assert.equal(getAggregateCost(), 999.99, "cost should be tracked even without ceiling");
    assert.equal(isBudgetExceeded(), false, "should never be exceeded without ceiling");
  } finally {
    resetOrchestrator();
    cleanup(base);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Worker status tracking through refresh
// ═══════════════════════════════════════════════════════════════════════════════

test("budget — refreshWorkerStatuses updates worker state from disk", async () => {
  const base = makeTmpBase();
  try {
    await startParallel(base, ["M001"], makePrefs(10.0));

    // Write status with specific state
    writeSessionStatus(base, {
      milestoneId: "M001",
      pid: process.pid,
      state: "paused",
      currentUnit: { type: "execute-task", id: "M001/S01/T02", startedAt: Date.now() },
      cost: 2.5,
      lastHeartbeat: Date.now(),
      startedAt: Date.now() - 120000,
      worktreePath: join(base, ".gsd", "worktrees", "m001"),
    });

    refreshWorkerStatuses(base);

    const workers = getWorkerStatuses();
    assert.equal(workers.length, 1);
    assert.equal(workers[0]!.state, "paused", "worker state should be updated from disk");
    assert.equal(workers[0]!.cost, 2.5, "cost should be updated from disk");
  } finally {
    resetOrchestrator();
    cleanup(base);
  }
});
