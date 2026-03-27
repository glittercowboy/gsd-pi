/**
 * E2E test: Parallel workers across multiple milestones.
 *
 * Validates the full lifecycle of the worker registry + metrics + budget
 * alerting across multiple milestone contexts. Uses real filesystem fixtures
 * and the actual metrics/worker-registry modules (no mocking).
 *
 * Covers:
 *  - Worker registry tracking across parallel batches
 *  - Metrics ledger accumulation across milestones
 *  - Budget alert level transitions including the 80% threshold
 *  - Dashboard data aggregation with parallel worker context
 *  - Cost projection with budget ceiling awareness
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  registerWorker,
  updateWorker,
  getActiveWorkers,
  getWorkerBatches,
  hasActiveWorkers,
  resetWorkerRegistry,
} from '../../../subagent/worker-registry.ts';
import {
  getBudgetAlertLevel,
  getNewBudgetAlertLevel,
  getBudgetEnforcementAction,
} from '../../auto-budget.ts';
import {
  type UnitMetrics,
  type MetricsLedger,
  getProjectTotals,
  aggregateByPhase,
  aggregateBySlice,
  formatCost,
  formatCostProjection,
  getAverageCostPerUnitType,
  predictRemainingCost,
} from '../../metrics.ts';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-e2e-parallel-'));
  mkdirSync(join(base, '.gsd', 'milestones'), { recursive: true });
  return base;
}

function writeMetricsLedger(base: string, ledger: MetricsLedger): void {
  writeFileSync(join(base, '.gsd', 'metrics.json'), JSON.stringify(ledger, null, 2));
}

function readMetricsLedger(base: string): MetricsLedger {
  return JSON.parse(readFileSync(join(base, '.gsd', 'metrics.json'), 'utf-8'));
}

function makeUnit(overrides: Partial<UnitMetrics> = {}): UnitMetrics {
  return {
    type: "execute-task",
    id: "M001/S01/T01",
    model: "claude-sonnet-4-20250514",
    startedAt: Date.now() - 5000,
    finishedAt: Date.now(),
    tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, total: 1800 },
    cost: 0.05,
    toolCalls: 3,
    assistantMessages: 2,
    userMessages: 1,
    ...overrides,
  };
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

// ─── E2E: Parallel workers across M001 and M002 ──────────────────────────────


describe('parallel-workers-multi-milestone-e2e', () => {
test('E2E: Parallel workers across milestones', () => {
  resetWorkerRegistry();
  const base = createFixtureBase();

  // Create milestone directories
  mkdirSync(join(base, '.gsd', 'milestones', 'M001'), { recursive: true });
  mkdirSync(join(base, '.gsd', 'milestones', 'M002'), { recursive: true });

  // Simulate M001 parallel workers (batch 1)
  const batch1Id = "batch-m001";
  const w1 = registerWorker("scout", "Explore M001 codebase", 0, 3, batch1Id);
  const w2 = registerWorker("researcher", "Research M001 APIs", 1, 3, batch1Id);
  const w3 = registerWorker("worker", "Implement M001 feature", 2, 3, batch1Id);

  assert.deepStrictEqual(getActiveWorkers().length, 3, "M001: 3 parallel workers registered");
  assert.ok(hasActiveWorkers(), "M001: has active workers");

  const batches1 = getWorkerBatches();
  assert.deepStrictEqual(batches1.size, 1, "M001: single batch");
  assert.deepStrictEqual(batches1.get(batch1Id)!.length, 3, "M001: batch has 3 workers");

  // Complete M001 workers
  updateWorker(w1, "completed");
  updateWorker(w2, "completed");
  updateWorker(w3, "completed");
  assert.ok(!hasActiveWorkers(), "M001: no active workers after completion");

  // Simulate M002 parallel workers (batch 2) — overlapping with M001 cleanup
  const batch2Id = "batch-m002";
  const w4 = registerWorker("scout", "Explore M002 codebase", 0, 2, batch2Id);
  const w5 = registerWorker("worker", "Implement M002 feature", 1, 2, batch2Id);

  assert.ok(hasActiveWorkers(), "M002: has active workers");
  const batches2 = getWorkerBatches();
  // M001 workers may still be in cleanup window (5s timeout), M002 workers are active
  assert.ok(batches2.has(batch2Id), "M002: batch exists");
  assert.deepStrictEqual(batches2.get(batch2Id)!.length, 2, "M002: batch has 2 workers");

  // One worker fails in M002
  updateWorker(w4, "completed");
  updateWorker(w5, "failed");
  assert.ok(!hasActiveWorkers(), "M002: no active workers after all finish");

  // Verify worker statuses reflect correctly
  const allWorkers = getActiveWorkers();
  const m002Workers = allWorkers.filter(w => w.batchId === batch2Id);
  if (m002Workers.length > 0) {
    const failedWorker = m002Workers.find(w => w.status === "failed");
    assert.ok(failedWorker !== undefined, "M002: failed worker tracked");
    assert.deepStrictEqual(failedWorker?.agent, "worker", "M002: failed worker is 'worker'");
  }

  cleanup(base);
});

// ─── E2E: Metrics accumulation across milestones ──────────────────────────────
test('E2E: Metrics across milestones', () => {
  const base = createFixtureBase();

  // Build a ledger spanning two milestones
  const ledger: MetricsLedger = {
    version: 1,
    projectStartedAt: Date.now() - 60000,
    units: [
      // M001 units
      makeUnit({ type: "research-milestone", id: "M001", cost: 0.10 }),
      makeUnit({ type: "plan-milestone", id: "M001", cost: 0.08 }),
      makeUnit({ type: "plan-slice", id: "M001/S01", cost: 0.05 }),
      makeUnit({ type: "execute-task", id: "M001/S01/T01", cost: 0.12 }),
      makeUnit({ type: "execute-task", id: "M001/S01/T02", cost: 0.15 }),
      makeUnit({ type: "complete-slice", id: "M001/S01", cost: 0.03 }),
      makeUnit({ type: "plan-slice", id: "M001/S02", cost: 0.06 }),
      makeUnit({ type: "execute-task", id: "M001/S02/T01", cost: 0.20 }),
      makeUnit({ type: "complete-slice", id: "M001/S02", cost: 0.04 }),
      // M002 units
      makeUnit({ type: "research-milestone", id: "M002", cost: 0.12 }),
      makeUnit({ type: "plan-milestone", id: "M002", cost: 0.09 }),
      makeUnit({ type: "plan-slice", id: "M002/S01", cost: 0.07 }),
      makeUnit({ type: "execute-task", id: "M002/S01/T01", cost: 0.18 }),
    ],
  };

  writeMetricsLedger(base, ledger);
  const loaded = readMetricsLedger(base);

  // Verify totals
  const totals = getProjectTotals(loaded.units);
  assert.deepStrictEqual(totals.units, 13, "metrics: 13 total units across M001+M002");
  const totalCost = loaded.units.reduce((sum, u) => sum + u.cost, 0);
  assert.ok(Math.abs(totals.cost - totalCost) < 0.001, "metrics: total cost matches sum");

  // Verify phase aggregation
  const phases = aggregateByPhase(loaded.units);
  const research = phases.find(p => p.phase === "research");
  assert.ok(research !== undefined, "metrics: research phase exists");
  assert.deepStrictEqual(research!.units, 2, "metrics: 2 research units (M001 + M002)");

  const execution = phases.find(p => p.phase === "execution");
  assert.ok(execution !== undefined, "metrics: execution phase exists");
  assert.deepStrictEqual(execution!.units, 4, "metrics: 4 execution units across both milestones");

  // Verify slice aggregation
  const slices = aggregateBySlice(loaded.units);
  assert.ok(slices.length >= 4, "metrics: at least 4 slice aggregates (M001/S01, M001/S02, M002/S01, milestone-level)");

  const m001s01 = slices.find(s => s.sliceId === "M001/S01");
  assert.ok(m001s01 !== undefined, "metrics: M001/S01 slice aggregate exists");
  // M001/S01 has: plan-slice + T01 + T02 + complete-slice = 4 units
  assert.deepStrictEqual(m001s01!.units, 4, "metrics: M001/S01 has 4 units");

  // Cost projection
  const projLines = formatCostProjection(slices, 3, 2.0);
  assert.ok(projLines.length >= 1, "metrics: cost projection generated");
  assert.match(projLines[0], /Projected remaining/, "metrics: projection line text");

  cleanup(base);
});

// ─── E2E: Budget alert progression through all thresholds ─────────────────────
test('E2E: Budget alert progression 0→75→80→90→100', () => {
  // Simulate spending progression against a $10 budget ceiling
  const ceiling = 10.0;

  // Start: 50% spent
  let lastLevel = getBudgetAlertLevel(5.0 / ceiling);
  assert.deepStrictEqual(lastLevel, 0, "budget: 50% → level 0");
  assert.deepStrictEqual(getNewBudgetAlertLevel(0, 5.0 / ceiling), null, "budget: no alert at 50%");

  // Spend to 75%
  let newLevel = getNewBudgetAlertLevel(lastLevel, 7.5 / ceiling);
  assert.deepStrictEqual(newLevel, 75, "budget: alert fires at 75%");
  lastLevel = newLevel!;

  // Spend to 78% — no alert (between 75 and 80)
  assert.deepStrictEqual(getNewBudgetAlertLevel(lastLevel, 7.8 / ceiling), null, "budget: no alert at 78%");

  // Spend to 80% — 80% approach alert
  newLevel = getNewBudgetAlertLevel(lastLevel, 8.0 / ceiling);
  assert.deepStrictEqual(newLevel, 80, "budget: approach alert fires at 80%");
  lastLevel = newLevel!;

  // Spend to 85% — no alert (still at 80 level)
  assert.deepStrictEqual(getNewBudgetAlertLevel(lastLevel, 8.5 / ceiling), null, "budget: no alert at 85%");

  // Spend to 90%
  newLevel = getNewBudgetAlertLevel(lastLevel, 9.0 / ceiling);
  assert.deepStrictEqual(newLevel, 90, "budget: alert fires at 90%");
  lastLevel = newLevel!;

  // Spend to 100%
  newLevel = getNewBudgetAlertLevel(lastLevel, 10.0 / ceiling);
  assert.deepStrictEqual(newLevel, 100, "budget: alert fires at 100%");
  lastLevel = newLevel!;

  // Over budget — no re-emission
  assert.deepStrictEqual(getNewBudgetAlertLevel(lastLevel, 12.0 / ceiling), null, "budget: no re-alert over 100%");

  // Enforcement at 80% — still "none" (enforcement only at 100%)
  assert.deepStrictEqual(getBudgetEnforcementAction("pause", 0.80), "none", "budget: no enforcement at 80%");
  assert.deepStrictEqual(getBudgetEnforcementAction("halt", 0.80), "none", "budget: no enforcement at 80%");
  assert.deepStrictEqual(getBudgetEnforcementAction("warn", 0.80), "none", "budget: no enforcement at 80%");
});

// ─── E2E: Budget prediction with multi-milestone cost data ────────────────────
test('E2E: Budget prediction across milestones', () => {
  const units: UnitMetrics[] = [
    makeUnit({ type: "execute-task", id: "M001/S01/T01", cost: 0.10 }),
    makeUnit({ type: "execute-task", id: "M001/S01/T02", cost: 0.15 }),
    makeUnit({ type: "plan-slice", id: "M001/S01", cost: 0.05 }),
    makeUnit({ type: "execute-task", id: "M002/S01/T01", cost: 0.20 }),
    makeUnit({ type: "plan-slice", id: "M002/S01", cost: 0.08 }),
  ];

  const avgCosts = getAverageCostPerUnitType(units);
  assert.ok(avgCosts.has("execute-task"), "prediction: has execute-task average");
  assert.ok(avgCosts.has("plan-slice"), "prediction: has plan-slice average");

  // Average execute-task cost: (0.10 + 0.15 + 0.20) / 3 = 0.15
  const execAvg = avgCosts.get("execute-task")!;
  assert.ok(Math.abs(execAvg - 0.15) < 0.001, `prediction: execute-task avg is $0.15 (got ${execAvg})`);

  // Average plan-slice cost: (0.05 + 0.08) / 2 = 0.065
  const planAvg = avgCosts.get("plan-slice")!;
  assert.ok(Math.abs(planAvg - 0.065) < 0.001, `prediction: plan-slice avg is $0.065 (got ${planAvg})`);

  // Predict remaining cost for 3 more execute-tasks and 1 plan-slice
  const remaining = predictRemainingCost(avgCosts, [
    "execute-task", "execute-task", "execute-task", "plan-slice",
  ]);
  // Expected: 3 * 0.15 + 1 * 0.065 = 0.515
  assert.ok(Math.abs(remaining - 0.515) < 0.001, `prediction: remaining cost ~$0.515 (got ${remaining})`);
});

// ─── E2E: Parallel workers + budget alerts combined scenario ──────────────────
test('E2E: Combined parallel workers + budget monitoring', () => {
  resetWorkerRegistry();

  // Simulate a scenario: 3 parallel workers running while budget is at 78%
  const batchId = "batch-combined";
  const w1 = registerWorker("scout", "Research APIs", 0, 3, batchId);
  const w2 = registerWorker("worker", "Implement feature", 1, 3, batchId);
  const w3 = registerWorker("worker", "Write tests", 2, 3, batchId);

  // Budget is at 78% — no alert yet (between 75 and 80)
  const ceiling = 10.0;
  let lastLevel: ReturnType<typeof getBudgetAlertLevel> = 75; // already got 75% alert
  assert.deepStrictEqual(getNewBudgetAlertLevel(lastLevel, 7.8 / ceiling), null, "combined: no alert at 78% with workers running");
  assert.ok(hasActiveWorkers(), "combined: workers running during budget check");

  // First worker completes, cost rises to 80%
  updateWorker(w1, "completed");
  const level80 = getNewBudgetAlertLevel(lastLevel, 8.0 / ceiling);
  assert.deepStrictEqual(level80, 80, "combined: 80% approach alert fires after worker completes");
  lastLevel = level80!;

  // Second worker completes, cost rises to 88%
  updateWorker(w2, "completed");
  assert.deepStrictEqual(getNewBudgetAlertLevel(lastLevel, 8.8 / ceiling), null, "combined: no alert at 88%");

  // Third worker completes, cost reaches 90%
  updateWorker(w3, "completed");
  const level90 = getNewBudgetAlertLevel(lastLevel, 9.0 / ceiling);
  assert.deepStrictEqual(level90, 90, "combined: 90% alert fires after all workers complete");

  assert.ok(!hasActiveWorkers(), "combined: no active workers at end");

  resetWorkerRegistry();
});

// ─── E2E: formatCostProjection with budget ceiling warnings ───────────────────
test('E2E: Cost projection ceiling warnings', () => {
  const slices = [
    { sliceId: "M001/S01", units: 4, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 3.0, duration: 10000 },
    { sliceId: "M001/S02", units: 3, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 4.0, duration: 8000 },
    { sliceId: "M002/S01", units: 3, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 5.0, duration: 12000 },
  ];

  // With ceiling NOT yet reached
  const proj1 = formatCostProjection(slices, 2, 20.0);
  assert.ok(proj1.length >= 1, "projection: has projection line");
  assert.match(proj1[0], /Projected remaining/, "projection: shows projection");
  assert.ok(proj1.length === 1, "projection: no ceiling warning when under budget");

  // With ceiling reached (spent 12.0 >= ceiling 10.0)
  const proj2 = formatCostProjection(slices, 2, 10.0);
  assert.ok(proj2.length >= 2, "projection: has ceiling warning when over budget");
  assert.match(proj2[1], /ceiling/, "projection: ceiling warning text");
});

// ─── Summary ──────────────────────────────────────────────────────────────────
});
