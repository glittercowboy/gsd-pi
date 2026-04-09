/**
 * Metrics tests — consolidated from:
 *   - metrics.test.ts (pure aggregation functions, formatting)
 *   - metrics-io.test.ts (disk I/O, init, snapshot, persistence)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// ── snapshotUnitMetrics idempotency ──────────────────────────────────────────

test("snapshotUnitMetrics deduplicates entries with same type+id+startedAt", () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "gsd-metrics-dedup-"));
  mkdirSync(join(tmpBase, ".gsd"), { recursive: true });
  try {
    initMetrics(tmpBase);
    const startedAt = Date.now() - 10000;
    const ctx = mockCtx([
      {
        role: "assistant",
        content: [{ type: "text", text: "Working" }],
        usage: {
          input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1500,
          cost: 0.01,
        },
      },
    ]);

    // First snapshot — should create entry
    const unit1 = snapshotUnitMetrics(ctx, "plan-slice", "M001/S01", startedAt, "test-model");
    assert.ok(unit1);
    assert.equal(getLedger()!.units.length, 1);

    // Second snapshot with same type+id+startedAt — should UPDATE, not append
    const unit2 = snapshotUnitMetrics(ctx, "plan-slice", "M001/S01", startedAt, "test-model");
    assert.ok(unit2);
    assert.equal(getLedger()!.units.length, 1, "should still be 1 entry after duplicate snapshot");

    // The entry should have the latest finishedAt
    assert.ok(getLedger()!.units[0].finishedAt >= unit1!.finishedAt);

    // Different startedAt — should create a NEW entry (different execution)
    const unit3 = snapshotUnitMetrics(ctx, "plan-slice", "M001/S01", startedAt + 5000, "test-model");
    assert.ok(unit3);
    assert.equal(getLedger()!.units.length, 2, "different startedAt = different execution = new entry");

    // Persist and verify on disk
    resetMetrics();
    initMetrics(tmpBase);
    assert.equal(getLedger()!.units.length, 2);
  } finally {
    resetMetrics();
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("snapshotUnitMetrics handles simulated idle-watchdog duplicate pattern", () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "gsd-metrics-watchdog-"));
  mkdirSync(join(tmpBase, ".gsd"), { recursive: true });
  try {
    initMetrics(tmpBase);
    const startedAt = Date.now() - 60000;
    const ctx = mockCtx([
      {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
        usage: {
          input: 2000, output: 1000, cacheRead: 500, cacheWrite: 100, totalTokens: 3600,
          cost: 0.05,
        },
      },
    ]);

    // Simulate watchdog calling closeoutUnit (which calls snapshotUnitMetrics)
    // 10 times at 15s intervals — mimicking the bug scenario
    for (let i = 0; i < 10; i++) {
      snapshotUnitMetrics(ctx, "plan-slice", "M001/S01", startedAt, "test-model");
    }

    // Should still be exactly 1 entry, not 10
    assert.equal(getLedger()!.units.length, 1, "10 watchdog snapshots should produce 1 entry, not 10");

    // Persist and verify
    const raw = readFileSync(join(tmpBase, ".gsd", "metrics.json"), "utf-8");
    const parsed: MetricsLedger = JSON.parse(raw);
    assert.equal(parsed.units.length, 1);
  } finally {
    resetMetrics();
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

// ── toolCall block counting ─────────────────────────────────────────────────

test("snapshotUnitMetrics counts toolCall blocks correctly (#1713)", () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "gsd-metrics-toolcall-"));
  mkdirSync(join(tmpBase, ".gsd"), { recursive: true });

  try {
    resetMetrics();
    initMetrics(tmpBase);

    const ctx = mockCtx([
      { role: "user", content: "Do something" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me help." },
          { type: "toolCall", name: "Read", input: { file: "foo.ts" } },
          { type: "toolCall", name: "Edit", input: { file: "bar.ts" } },
        ],
        usage: {
          input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1500,
          cost: 0.01,
        },
      },
      {
        role: "assistant",
        content: [
          { type: "toolCall", name: "Bash", input: { command: "ls" } },
          { type: "text", text: "All done." },
        ],
        usage: {
          input: 800, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1100,
          cost: 0.008,
        },
      },
    ]);

    const unit = snapshotUnitMetrics(ctx, "execute-task", "M001/S01/T01", Date.now() - 3000, "test-model");
    assert.ok(unit);
    assert.equal(unit!.toolCalls, 3, "should count 3 toolCall blocks across 2 assistant messages");
    assert.equal(unit!.assistantMessages, 2);
    assert.equal(unit!.userMessages, 1);
  } finally {
    resetMetrics();
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

// ── #1943 — Duplicate metrics entries from idle watchdog ──────────────────────

test("#1943 initMetrics deduplicates entries loaded from a corrupted disk ledger", () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "gsd-metrics-dedup-load-"));
  mkdirSync(join(tmpBase, ".gsd"), { recursive: true });

  try {
    resetMetrics();

    // Simulate a corrupted metrics.json with duplicate entries on disk
    // (same type+id+startedAt but different finishedAt — idle watchdog pattern)
    const corruptedLedger: MetricsLedger = {
      version: 1,
      projectStartedAt: 1700000000000,
      units: [
        makeUnit({ type: "research-slice", id: "M009/S02", startedAt: 1774011016218, finishedAt: 1774011031218, cost: 1.50, tokens: { input: 6600000, output: 100000, cacheRead: 0, cacheWrite: 0, total: 6700000 } }),
        makeUnit({ type: "research-slice", id: "M009/S02", startedAt: 1774011016218, finishedAt: 1774011046218, cost: 1.55, tokens: { input: 6800000, output: 110000, cacheRead: 0, cacheWrite: 0, total: 6910000 } }),
        makeUnit({ type: "research-slice", id: "M009/S02", startedAt: 1774011016218, finishedAt: 1774011061218, cost: 1.60, tokens: { input: 7000000, output: 120000, cacheRead: 0, cacheWrite: 0, total: 7120000 } }),
        makeUnit({ type: "research-slice", id: "M009/S02", startedAt: 1774011016218, finishedAt: 1774011076218, cost: 1.65, tokens: { input: 7200000, output: 130000, cacheRead: 0, cacheWrite: 0, total: 7330000 } }),
        // A different unit — should be preserved
        makeUnit({ type: "execute-task", id: "M001/S01/T01", startedAt: 1774012000000, finishedAt: 1774012060000, cost: 0.50 }),
      ],
    };
    writeFileSync(
      join(tmpBase, ".gsd", "metrics.json"),
      JSON.stringify(corruptedLedger, null, 2),
    );

    // Load the corrupted ledger — duplicates should be collapsed on load
    initMetrics(tmpBase);
    const ledger = getLedger();
    assert.ok(ledger);

    // The 4 entries with identical (type, id, startedAt) should collapse to 1,
    // keeping the latest (highest finishedAt). Plus the 1 different unit = 2 total.
    assert.equal(
      ledger!.units.length, 2,
      `expected 2 entries after dedup (1 collapsed group + 1 unique), got ${ledger!.units.length}`,
    );

    // The surviving duplicate should be the one with the latest finishedAt
    const researchEntry = ledger!.units.find(u => u.type === "research-slice");
    assert.ok(researchEntry);
    assert.equal(researchEntry!.finishedAt, 1774011076218, "should keep the latest finishedAt");
    assert.equal(researchEntry!.cost, 1.65, "should keep the latest cost");

    // The on-disk file should also be deduplicated
    const diskRaw = readFileSync(join(tmpBase, ".gsd", "metrics.json"), "utf-8");
    const diskLedger: MetricsLedger = JSON.parse(diskRaw);
    assert.equal(diskLedger.units.length, 2, "disk should also have deduplicated entries");
  } finally {
    resetMetrics();
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("#1943 getProjectTotals reports correct cost after dedup (no 35% inflation)", () => {
  // Simulate the exact scenario from the issue: 20 entries for a single dispatch
  // with monotonically increasing token counts and 15s-apart finishedAt values
  const startedAt = 1774011016218;
  const baseCost = 1.50;
  const duplicateUnits: UnitMetrics[] = [];

  for (let i = 0; i < 20; i++) {
    duplicateUnits.push(makeUnit({
      type: "research-slice",
      id: "M009/S02",
      startedAt,
      finishedAt: startedAt + (i + 1) * 15000,
      cost: baseCost + i * 0.05,
      toolCalls: 0,
      tokens: {
        input: 6600000 + i * 200000,
        output: 100000 + i * 10000,
        cacheRead: 0,
        cacheWrite: 0,
        total: 6700000 + i * 210000,
      },
    }));
  }

  // Without dedup, getProjectTotals would sum all 20 entries' costs
  const rawTotals = getProjectTotals(duplicateUnits);
  // With dedup (only last entry should count), cost should be the last entry's cost
  const lastEntryCost = duplicateUnits[duplicateUnits.length - 1].cost;

  // This test documents the bug: raw totals inflate cost by summing duplicates
  assert.ok(
    rawTotals.cost > lastEntryCost * 2,
    "raw totals with duplicates inflate cost (bug demonstration)",
  );

  // After loading through initMetrics (which should dedup), totals should be correct
  const tmpBase = mkdtempSync(join(tmpdir(), "gsd-metrics-cost-inflation-"));
  mkdirSync(join(tmpBase, ".gsd"), { recursive: true });
  try {
    resetMetrics();
    writeFileSync(
      join(tmpBase, ".gsd", "metrics.json"),
      JSON.stringify({ version: 1, projectStartedAt: 1700000000000, units: duplicateUnits }, null, 2),
    );
    initMetrics(tmpBase);
    const ledger = getLedger()!;
    const dedupedTotals = getProjectTotals(ledger.units);
    assert.equal(ledger.units.length, 1, "20 duplicates should collapse to 1 entry");
    assert.equal(
      dedupedTotals.cost, lastEntryCost,
      `deduped cost should be ${lastEntryCost}, not ${dedupedTotals.cost}`,
    );
  } finally {
    resetMetrics();
    rmSync(tmpBase, { recursive: true, force: true });
  }
});
