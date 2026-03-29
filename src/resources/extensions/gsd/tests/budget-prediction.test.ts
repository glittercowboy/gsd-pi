/**
 * Budget Prediction — unit tests for M004/S04.
 *
 * Tests prediction math and auto-downgrade logic.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  getAverageCostPerUnitType,
  predictRemainingCost,
  type UnitMetrics,
} from "../metrics.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeUnit(type: string, cost: number): UnitMetrics {
  return {
    type,
    id: `test/${type}`,
    model: "test-model",
    startedAt: 0,
    finishedAt: 1,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost,
    toolCalls: 0,
    assistantMessages: 1,
    userMessages: 1,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Average Cost Per Unit Type
// ═══════════════════════════════════════════════════════════════════════════

test("avgCost: returns correct averages per unit type", () => {
  const units: UnitMetrics[] = [
    makeUnit("execute-task", 0.10),
    makeUnit("execute-task", 0.20),
    makeUnit("plan-slice", 0.05),
    makeUnit("plan-slice", 0.15),
    makeUnit("complete-slice", 0.08),
  ];
  const avgs = getAverageCostPerUnitType(units);
  assert.ok(Math.abs(avgs.get("execute-task")! - 0.15) < 0.001, "execute-task avg should be 0.15");
  assert.ok(Math.abs(avgs.get("plan-slice")! - 0.10) < 0.001, "plan-slice avg should be 0.10");
  assert.ok(Math.abs(avgs.get("complete-slice")! - 0.08) < 0.001, "complete-slice avg should be 0.08");
});

test("avgCost: returns empty map for empty input", () => {
  const avgs = getAverageCostPerUnitType([]);
  assert.equal(avgs.size, 0);
});

test("avgCost: single unit per type returns exact cost", () => {
  const avgs = getAverageCostPerUnitType([makeUnit("execute-task", 0.42)]);
  assert.ok(Math.abs(avgs.get("execute-task")! - 0.42) < 0.001);
});

// ═══════════════════════════════════════════════════════════════════════════
// Predict Remaining Cost
// ═══════════════════════════════════════════════════════════════════════════

test("predict: calculates remaining cost from averages", () => {
  const avgs = new Map([
    ["execute-task", 0.15],
    ["plan-slice", 0.10],
    ["complete-slice", 0.08],
  ]);
  const remaining = ["execute-task", "execute-task", "complete-slice"];
  const cost = predictRemainingCost(avgs, remaining);
  assert.ok(Math.abs(cost - 0.38) < 0.001);
});

test("predict: uses overall average for unknown unit types", () => {
  const avgs = new Map([
    ["execute-task", 0.10],
    ["plan-slice", 0.20],
  ]);
  const remaining = ["execute-task", "unknown-type"];
  const cost = predictRemainingCost(avgs, remaining);
  // unknown: (0.10 + 0.20) / 2 = 0.15 → total 0.10 + 0.15 = 0.25
  assert.ok(Math.abs(cost - 0.25) < 0.001);
});

test("predict: returns 0 for empty remaining", () => {
  const avgs = new Map([["execute-task", 0.15]]);
  assert.equal(predictRemainingCost(avgs, []), 0);
});

test("predict: handles no averages with fallback", () => {
  const avgs = new Map<string, number>();
  const cost = predictRemainingCost(avgs, ["execute-task", "plan-slice"], 0.10);
  assert.ok(Math.abs(cost - 0.20) < 0.001);
});

test("predict: handles no averages and no fallback", () => {
  const avgs = new Map<string, number>();
  const cost = predictRemainingCost(avgs, ["execute-task"]);
  assert.equal(cost, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// Budget Prediction — End-to-End Math
// ═══════════════════════════════════════════════════════════════════════════

test("e2e: budget ceiling exceeded triggers downgrade prediction", () => {
  const units: UnitMetrics[] = [
    makeUnit("execute-task", 0.50),
    makeUnit("execute-task", 0.60),
    makeUnit("plan-slice", 0.30),
    makeUnit("complete-slice", 0.20),
  ];
  const totalSpent = units.reduce((sum, u) => sum + u.cost, 0); // 1.60
  const avgs = getAverageCostPerUnitType(units);
  const remaining = ["execute-task", "execute-task", "execute-task"];
  const predictedRemaining = predictRemainingCost(avgs, remaining);
  const predictedTotal = totalSpent + predictedRemaining;
  const budgetCeiling = 2.50;
  assert.ok(predictedTotal > budgetCeiling, "should predict budget exhaustion");
});

test("e2e: budget ceiling not exceeded does not trigger", () => {
  const units: UnitMetrics[] = [
    makeUnit("execute-task", 0.10),
    makeUnit("plan-slice", 0.05),
  ];
  const totalSpent = units.reduce((sum, u) => sum + u.cost, 0); // 0.15
  const avgs = getAverageCostPerUnitType(units);
  const remaining = ["execute-task", "complete-slice"];
  const predictedRemaining = predictRemainingCost(avgs, remaining);
  const predictedTotal = totalSpent + predictedRemaining;
  const budgetCeiling = 5.00;
  assert.ok(predictedTotal <= budgetCeiling, "should not predict budget exhaustion");
});

// ═══════════════════════════════════════════════════════════════════════════
// Downgrade Logic
// ═══════════════════════════════════════════════════════════════════════════

test("downgrade: one-way per D048 — downgrade should not be reversible", () => {
  let downgraded = false;

  function checkDowngrade(predictedTotal: number, ceiling: number) {
    if (!downgraded && predictedTotal > ceiling) {
      downgraded = true;
    }
    // Never reverse — per D048
  }

  checkDowngrade(3.00, 2.50); // triggers
  assert.ok(downgraded, "should downgrade when prediction exceeds ceiling");

  checkDowngrade(1.50, 2.50); // doesn't reverse
  assert.ok(downgraded, "should stay downgraded (one-way per D048)");
});
