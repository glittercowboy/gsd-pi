/**
 * Tests for summarize-metrics utility
 *
 * @module summarize-metrics.test
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { summarizeMetrics, formatComparisonTable } from "../summarize-metrics.js";
import type { MetricsLedger, UnitMetrics } from "../metrics.js";

// ─── Test Fixtures ────────────────────────────────────────────────────────────

/** Create a minimal MetricsLedger with the given units. */
function makeLedger(units: UnitMetrics[]): MetricsLedger {
  return {
    version: 1,
    projectStartedAt: Date.now() - 3600000,
    units,
  };
}

/** Create a realistic UnitMetrics with all M007 fields. */
function makeUnit(
  type: string,
  id: string,
  opts: {
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
    interventions?: { blocker?: number; correction?: number; redirect?: number };
    factCheck?: { claimsChecked?: number; verified?: number; refuted?: number };
    wallClockMs?: number;
    startedAt?: number;
    finishedAt?: number;
  } = {}
): UnitMetrics {
  const startedAt = opts.startedAt ?? Date.now() - 1800000;
  const finishedAt = opts.finishedAt ?? Date.now() - 900000;

  return {
    type,
    id,
    model: "claude-3-sonnet",
    startedAt,
    finishedAt,
    tokens: {
      input: opts.inputTokens ?? 10000,
      output: opts.outputTokens ?? 5000,
      cacheRead: 0,
      cacheWrite: 0,
      total: (opts.inputTokens ?? 10000) + (opts.outputTokens ?? 5000),
    },
    cost: opts.cost ?? 0.15,
    toolCalls: 5,
    assistantMessages: 3,
    userMessages: 2,
    ...(opts.interventions
      ? {
          interventions: {
            blocker: opts.interventions.blocker ?? 0,
            correction: opts.interventions.correction ?? 0,
            redirect: opts.interventions.redirect ?? 0,
          },
        }
      : {}),
    ...(opts.factCheck
      ? {
          factCheck: {
            claimsChecked: opts.factCheck.claimsChecked ?? 0,
            verified: opts.factCheck.verified ?? 0,
            refuted: opts.factCheck.refuted ?? 0,
            inconclusive: 0,
            scoutTokens: 1000,
          },
        }
      : {}),
    wallClockMs: opts.wallClockMs ?? (finishedAt - startedAt),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("summarizeMetrics", () => {
  it("aggregates per-phase tokens across two ledgers", () => {
    const ledger1 = makeLedger([
      makeUnit("research-milestone", "M001/R", { inputTokens: 50000, outputTokens: 10000, cost: 0.5 }),
      makeUnit("plan-slice", "M001/S01/P", { inputTokens: 20000, outputTokens: 5000, cost: 0.2 }),
      makeUnit("execute-task", "M001/S01/T01", { inputTokens: 30000, outputTokens: 8000, cost: 0.3 }),
    ]);

    const ledger2 = makeLedger([
      makeUnit("research-milestone", "M002/R", { inputTokens: 60000, outputTokens: 12000, cost: 0.6 }),
      makeUnit("execute-task", "M002/S01/T01", { inputTokens: 40000, outputTokens: 10000, cost: 0.4 }),
    ]);

    const comparison = summarizeMetrics([
      { label: "baseline", ledger: ledger1 },
      { label: "treatment", ledger: ledger2 },
    ]);

    // Should have research, planning, execution rows
    assert.ok(comparison.rows.length >= 2, "Should have at least 2 phase rows");

    // Check research phase
    const researchRow = comparison.rows.find(r => r.phase === "research");
    assert.ok(researchRow, "Should have research row");
    assert.equal(researchRow.entries.length, 2, "Research row should have 2 entries");

    const baselineResearch = researchRow.entries.find(e => e.label === "baseline");
    assert.ok(baselineResearch, "Should have baseline research entry");
    assert.equal(baselineResearch.tokens, 60000, "Baseline research tokens should be 60k");

    const treatmentResearch = researchRow.entries.find(e => e.label === "treatment");
    assert.ok(treatmentResearch, "Should have treatment research entry");
    assert.equal(treatmentResearch.tokens, 72000, "Treatment research tokens should be 72k");

    // Check execution phase
    const executionRow = comparison.rows.find(r => r.phase === "execution");
    assert.ok(executionRow, "Should have execution row");

    const baselineExecution = executionRow.entries.find(e => e.label === "baseline");
    assert.ok(baselineExecution, "Should have baseline execution entry");
    assert.equal(baselineExecution.tokens, 38000, "Baseline execution tokens should be 38k");

    // Check totals
    assert.equal(comparison.totals.length, 2, "Should have 2 totals");
    const baselineTotal = comparison.totals.find(t => t.label === "baseline");
    assert.ok(baselineTotal, "Should have baseline totals");
    assert.equal(baselineTotal.totals.units, 3, "Baseline should have 3 units");
  });

  it("includes intervention counts in comparison", () => {
    const ledger = makeLedger([
      makeUnit("execute-task", "M001/S01/T01", {
        interventions: { blocker: 1, correction: 2, redirect: 0 },
      }),
      makeUnit("execute-task", "M001/S01/T02", {
        interventions: { blocker: 0, correction: 1, redirect: 1 },
      }),
    ]);

    const comparison = summarizeMetrics([{ label: "test", ledger }]);

    const executionRow = comparison.rows.find(r => r.phase === "execution");
    assert.ok(executionRow, "Should have execution row");

    const entry = executionRow.entries[0];
    assert.ok(entry, "Should have entry");
    // Total interventions: (1+2+0) + (0+1+1) = 5
    assert.equal(entry.interventions, 5, "Should have 5 total interventions");
  });

  it("includes fact-check tallies in comparison", () => {
    const ledger = makeLedger([
      makeUnit("execute-task", "M001/S01/T01", {
        factCheck: { claimsChecked: 10, verified: 8, refuted: 2 },
      }),
    ]);

    const comparison = summarizeMetrics([{ label: "test", ledger }]);

    const executionRow = comparison.rows.find(r => r.phase === "execution");
    assert.ok(executionRow, "Should have execution row");

    const entry = executionRow.entries[0];
    assert.ok(entry, "Should have entry");
    assert.equal(entry.factChecks, 10, "Should have 10 fact-checks");
  });

  it("handles single-ledger input", () => {
    const ledger = makeLedger([
      makeUnit("research-milestone", "M001/R", { inputTokens: 50000 }),
    ]);

    const comparison = summarizeMetrics([{ label: "only", ledger }]);

    assert.equal(comparison.rows.length, 1, "Should have 1 row (research)");
    assert.equal(comparison.rows[0].phase, "research");
    assert.equal(comparison.rows[0].entries.length, 1, "Row should have 1 entry");
    assert.equal(comparison.totals.length, 1, "Should have 1 total");
  });

  it("handles ledger with no intervention/factCheck fields (pre-M007 data)", () => {
    const ledger = makeLedger([
      {
        type: "execute-task",
        id: "M001/S01/T01",
        model: "claude-3-sonnet",
        startedAt: Date.now() - 1000,
        finishedAt: Date.now(),
        tokens: { input: 10000, output: 5000, cacheRead: 0, cacheWrite: 0, total: 15000 },
        cost: 0.1,
        toolCalls: 5,
        assistantMessages: 3,
        userMessages: 2,
        // No interventions or factCheck fields
      },
    ]);

    const comparison = summarizeMetrics([{ label: "legacy", ledger }]);

    const executionRow = comparison.rows.find(r => r.phase === "execution");
    assert.ok(executionRow, "Should have execution row");

    const entry = executionRow.entries[0];
    assert.ok(entry, "Should have entry");
    assert.equal(entry.interventions, 0, "Interventions should default to 0");
    assert.equal(entry.factChecks, 0, "Fact-checks should default to 0");
    assert.ok(entry.wallClockMs > 0, "Should have wall-clock duration");
  });

  it("handles empty ledger (zero units)", () => {
    const ledger = makeLedger([]);

    const comparison = summarizeMetrics([{ label: "empty", ledger }]);

    assert.equal(comparison.rows.length, 0, "Should have 0 rows for empty ledger");
    assert.equal(comparison.totals.length, 1, "Should still have 1 total entry");

    const total = comparison.totals[0];
    assert.equal(total.label, "empty");
    assert.equal(total.totals.units, 0, "Total units should be 0");
    assert.equal(total.totals.tokens.total, 0, "Total tokens should be 0");
    assert.equal(total.totals.cost, 0, "Total cost should be 0");
  });
});

describe("formatComparisonTable", () => {
  it("produces valid Markdown table with column per ledger", () => {
    const ledger1 = makeLedger([
      makeUnit("research-milestone", "M001/R", { inputTokens: 50000, cost: 0.5 }),
    ]);
    const ledger2 = makeLedger([
      makeUnit("research-milestone", "M002/R", { inputTokens: 60000, cost: 0.6 }),
    ]);

    const comparison = summarizeMetrics([
      { label: "baseline", ledger: ledger1 },
      { label: "treatment", ledger: ledger2 },
    ]);

    const table = formatComparisonTable(comparison);

    // Check Markdown table structure
    assert.ok(table.includes("| Phase | baseline | treatment |"), "Should have header row with ledger labels");
    assert.ok(table.includes("| --- | --- | --- |"), "Should have separator row");
    assert.ok(table.includes("research"), "Should include research phase");
    // 50k input + 5k output default = 55k total, formatted as "55.0k"
    assert.ok(table.includes("55.0k") || table.includes("55000"), "Should include token values");
    assert.ok(table.includes("$0.50") || table.includes("$0.500"), "Should include cost values");
  });

  it("includes phase names in output", () => {
    const ledger = makeLedger([
      makeUnit("research-milestone", "M001/R"),
      makeUnit("plan-slice", "M001/S01/P"),
      makeUnit("execute-task", "M001/S01/T01"),
    ]);

    const comparison = summarizeMetrics([{ label: "test", ledger }]);
    const table = formatComparisonTable(comparison);

    assert.ok(table.includes("research"), "Should include research phase");
    assert.ok(table.includes("planning"), "Should include planning phase");
    assert.ok(table.includes("execution"), "Should include execution phase");
  });

  it("includes numeric values for each ledger label", () => {
    const ledger = makeLedger([
      makeUnit("execute-task", "M001/S01/T01", {
        inputTokens: 25000,
        outputTokens: 8000,
        cost: 0.25,
        interventions: { blocker: 1 },
        factCheck: { claimsChecked: 5 },
      }),
    ]);

    const comparison = summarizeMetrics([{ label: "mylabel", ledger }]);
    const table = formatComparisonTable(comparison);

    // Check that the label appears
    assert.ok(table.includes("mylabel"), "Should include ledger label in header");

    // Check that token values appear (25k + 8k = 33k, formatted as "33.0k")
    const hasTokenValue = table.includes("33.0k") || table.includes("33000");
    assert.ok(hasTokenValue, "Should include token values (33.0k)");

    // Check cost appears
    const hasCost = table.includes("$0.25") || table.includes("$0.250");
    assert.ok(hasCost, "Should include cost value");

    // Check interventions appear
    assert.ok(table.includes("1"), "Should include intervention count");
  });

  it("handles empty input gracefully", () => {
    const comparison = summarizeMetrics([]);
    const table = formatComparisonTable(comparison);

    assert.ok(table.includes("No ledgers"), "Should indicate no ledgers to compare");
  });

  it("includes totals section", () => {
    const ledger = makeLedger([
      makeUnit("execute-task", "M001/S01/T01", { cost: 0.1 }),
    ]);

    const comparison = summarizeMetrics([{ label: "test", ledger }]);
    const table = formatComparisonTable(comparison);

    assert.ok(table.includes("total"), "Should include totals section");
    assert.ok(table.includes("Units:"), "Should show unit count");
    assert.ok(table.includes("Cost:"), "Should show total cost");
  });
});
