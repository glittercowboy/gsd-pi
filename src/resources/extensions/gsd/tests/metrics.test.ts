/**
 * Metrics tests — consolidated from:
 *   - metrics.test.ts (pure aggregation functions, formatting)
 *   - metrics-io.test.ts (disk I/O, init, snapshot, persistence)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  type UnitMetrics,
  type MetricsLedger,
  classifyUnitPhase,
  aggregateByPhase,
  aggregateBySlice,
  aggregateByModel,
  getProjectTotals,
  formatCost,
  formatTokenCount,
  initMetrics,
  resetMetrics,
  getLedger,
  snapshotUnitMetrics,
} from "../metrics.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeUnit(overrides: Partial<UnitMetrics> = {}): UnitMetrics {
  return {
    type: "execute-task",
    id: "M001/S01/T01",
    model: "claude-sonnet-4-20250514",
    startedAt: 1000,
    finishedAt: 2000,
    tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, total: 1800 },
    cost: 0.05,
    toolCalls: 3,
    assistantMessages: 2,
    userMessages: 1,
    ...overrides,
  };
}

function mockCtx(messages: any[] = []): any {
  const entries = messages.map((msg, i) => ({
    type: "message", id: `entry-${i}`,
    parentId: i > 0 ? `entry-${i - 1}` : null,
    timestamp: new Date().toISOString(), message: msg,
  }));
  return { sessionManager: { getEntries: () => entries }, model: { id: "claude-sonnet-4-20250514" } };
}

// ── Phase classification ─────────────────────────────────────────────────────

test("classifyUnitPhase maps unit types to phases", () => {
  assert.equal(classifyUnitPhase("research-milestone"), "research");
  assert.equal(classifyUnitPhase("research-slice"), "research");
  assert.equal(classifyUnitPhase("plan-milestone"), "planning");
  assert.equal(classifyUnitPhase("plan-slice"), "planning");
  assert.equal(classifyUnitPhase("execute-task"), "execution");
  assert.equal(classifyUnitPhase("complete-slice"), "completion");
  assert.equal(classifyUnitPhase("reassess-roadmap"), "reassessment");
  assert.equal(classifyUnitPhase("unknown-thing"), "execution");
});

// ── getProjectTotals ─────────────────────────────────────────────────────────

test("getProjectTotals aggregates tokens, cost, duration, and tool calls", () => {
  const units = [
    makeUnit({ tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, total: 1800 }, cost: 0.05, toolCalls: 3, startedAt: 1000, finishedAt: 2000 }),
    makeUnit({ tokens: { input: 2000, output: 1000, cacheRead: 400, cacheWrite: 200, total: 3600 }, cost: 0.10, toolCalls: 5, startedAt: 2000, finishedAt: 4000 }),
  ];
  const totals = getProjectTotals(units);
  assert.equal(totals.units, 2);
  assert.equal(totals.tokens.input, 3000);
  assert.equal(totals.tokens.output, 1500);
  assert.equal(totals.tokens.total, 5400);
  assert.ok(Math.abs(totals.cost - 0.15) < 0.001);
  assert.equal(totals.toolCalls, 8);
  assert.equal(totals.duration, 3000);
});

test("getProjectTotals handles empty input", () => {
  const totals = getProjectTotals([]);
  assert.equal(totals.units, 0);
  assert.equal(totals.cost, 0);
  assert.equal(totals.tokens.total, 0);
});

test("getProjectTotals aggregates budget fields", () => {
  const units = [
    makeUnit({ truncationSections: 3, continueHereFired: true }),
    makeUnit({ truncationSections: 2, continueHereFired: false }),
    makeUnit({ truncationSections: 1, continueHereFired: true }),
  ];
  const totals = getProjectTotals(units);
  assert.equal(totals.totalTruncationSections, 6);
  assert.equal(totals.continueHereFiredCount, 2);
});

test("getProjectTotals defaults budget fields to 0 for old units", () => {
  const totals = getProjectTotals([makeUnit(), makeUnit()]);
  assert.equal(totals.totalTruncationSections, 0);
  assert.equal(totals.continueHereFiredCount, 0);
});

// ── aggregateByPhase ─────────────────────────────────────────────────────────

test("aggregateByPhase groups units by phase and sums costs", () => {
  const units = [
    makeUnit({ type: "research-milestone", cost: 0.02 }),
    makeUnit({ type: "research-slice", cost: 0.03 }),
    makeUnit({ type: "plan-milestone", cost: 0.01 }),
    makeUnit({ type: "plan-slice", cost: 0.02 }),
    makeUnit({ type: "execute-task", cost: 0.10 }),
    makeUnit({ type: "execute-task", cost: 0.08 }),
    makeUnit({ type: "complete-slice", cost: 0.01 }),
    makeUnit({ type: "reassess-roadmap", cost: 0.005 }),
  ];
  const phases = aggregateByPhase(units);
  assert.equal(phases.length, 5);
  assert.equal(phases[0].phase, "research");
  assert.equal(phases[0].units, 2);
  assert.ok(Math.abs(phases[0].cost - 0.05) < 0.001);
  assert.equal(phases[2].phase, "execution");
  assert.ok(Math.abs(phases[2].cost - 0.18) < 0.001);
});

// ── aggregateBySlice ─────────────────────────────────────────────────────────

test("aggregateBySlice groups units by slice ID", () => {
  const units = [
    makeUnit({ id: "M001/S01/T01", cost: 0.05 }),
    makeUnit({ id: "M001/S01/T02", cost: 0.04 }),
    makeUnit({ id: "M001/S02/T01", cost: 0.10 }),
    makeUnit({ id: "M001", type: "research-milestone", cost: 0.02 }),
  ];
  const slices = aggregateBySlice(units);
  assert.equal(slices.length, 3);
  const s01 = slices.find(s => s.sliceId === "M001/S01");
  assert.ok(s01);
  assert.equal(s01!.units, 2);
  assert.ok(Math.abs(s01!.cost - 0.09) < 0.001);
});

// ── aggregateByModel ─────────────────────────────────────────────────────────

test("aggregateByModel groups by model sorted by cost desc", () => {
  const units = [
    makeUnit({ model: "claude-sonnet-4-20250514", cost: 0.05 }),
    makeUnit({ model: "claude-sonnet-4-20250514", cost: 0.04 }),
    makeUnit({ model: "claude-opus-4-20250514", cost: 0.30 }),
  ];
  const models = aggregateByModel(units);
  assert.equal(models.length, 2);
  assert.equal(models[0].model, "claude-opus-4-20250514");
  assert.equal(models[1].units, 2);
});

test("aggregateByModel picks first defined contextWindowTokens", () => {
  const units = [
    makeUnit({ model: "claude-sonnet-4-20250514", contextWindowTokens: 200000, cost: 0.05 }),
    makeUnit({ model: "claude-sonnet-4-20250514", contextWindowTokens: 150000, cost: 0.04 }),
  ];
  const models = aggregateByModel(units);
  assert.equal(models[0].contextWindowTokens, 200000);
});

// ── Formatting ───────────────────────────────────────────────────────────────

test("formatCost formats dollar amounts correctly", () => {
  assert.equal(formatCost(0), "$0.0000");
  assert.equal(formatCost(0.001), "$0.0010");
  assert.equal(formatCost(0.05), "$0.050");
  assert.equal(formatCost(1.50), "$1.50");
  assert.equal(formatCost(14.20), "$14.20");
});

test("formatTokenCount uses k/M suffixes", () => {
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(500), "500");
  assert.equal(formatTokenCount(1500), "1.5k");
  assert.equal(formatTokenCount(150000), "150.0k");
  assert.equal(formatTokenCount(1500000), "1.50M");
});

// ── Backward compatibility ───────────────────────────────────────────────────

test("old UnitMetrics without budget fields work with all aggregation functions", () => {
  const oldUnit = makeUnit();
  assert.equal(aggregateByPhase([oldUnit]).length, 1);
  assert.equal(aggregateBySlice([oldUnit]).length, 1);
  assert.equal(aggregateByModel([oldUnit]).length, 1);
  assert.equal(getProjectTotals([oldUnit]).units, 1);
  assert.equal(oldUnit.contextWindowTokens, undefined);
});

// ── Disk I/O ─────────────────────────────────────────────────────────────────

test("initMetrics creates ledger, snapshotUnitMetrics persists across resets", () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "gsd-metrics-test-"));
  mkdirSync(join(tmpBase, ".gsd"), { recursive: true });

  try {
    resetMetrics();
    assert.equal(getLedger(), null);

    initMetrics(tmpBase);
    const ledger = getLedger();
    assert.ok(ledger);
    assert.equal(ledger!.version, 1);
    assert.equal(ledger!.units.length, 0);

    // Snapshot a unit
    const ctx = mockCtx([
      { role: "user", content: "Do the thing" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
        usage: {
          input: 5000, output: 2000, cacheRead: 3000, cacheWrite: 500, totalTokens: 10500,
          cost: { input: 0.015, output: 0.03, cacheRead: 0.003, cacheWrite: 0.002, total: 0.05 },
        },
      },
    ]);
    const unit = snapshotUnitMetrics(ctx, "execute-task", "M001/S01/T01", Date.now() - 5000, "claude-sonnet-4-20250514");
    assert.ok(unit);
    assert.equal(unit!.type, "execute-task");
    assert.equal(unit!.tokens.input, 5000);

    // Persist and reload
    resetMetrics();
    initMetrics(tmpBase);
    assert.equal(getLedger()!.units.length, 1);
    assert.equal(getLedger()!.units[0].id, "M001/S01/T01");

    // Verify file content
    const raw = readFileSync(join(tmpBase, ".gsd", "metrics.json"), "utf-8");
    const parsed: MetricsLedger = JSON.parse(raw);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.units.length, 1);

    // Empty session returns null
    const emptyUnit = snapshotUnitMetrics(mockCtx([]), "plan-slice", "M001/S01", Date.now(), "test-model");
    assert.equal(emptyUnit, null);
    assert.equal(getLedger()!.units.length, 1);
  } finally {
    resetMetrics();
    rmSync(tmpBase, { recursive: true, force: true });
  }
});
