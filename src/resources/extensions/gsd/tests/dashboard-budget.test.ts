import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
/**
 * Tests for dashboard budget indicator rendering.
 *
 * Tests the rendering logic that wires budget data from the metrics
 * aggregation layer into the dashboard overlay's three sections:
 * Completed (per-unit ▼N and → wrap-up), By Model (context window),
 * and Cost & Usage (aggregate budget summary line).
 *
 * Since the overlay class depends on global state (auto module, file system),
 * we test the rendering patterns directly using the real formatting and
 * aggregation functions, verifying the exact strings that would appear.
 */

import {
  type UnitMetrics,
  type MetricsLedger,
  aggregateByModel,
  getProjectTotals,
  formatTokenCount,
} from "../metrics.js";
// ─── Test helpers ─────────────────────────────────────────────────────────────

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

/**
 * Simulate the Completed section's budget marker rendering logic.
 * This replicates the exact logic from buildContentLines() in dashboard-overlay.ts.
 */
function renderCompletedBudgetMarkers(
  completedUnit: { type: string; id: string },
  ledgerUnits: UnitMetrics[],
): string {
  // Build lookup (same logic as dashboard-overlay.ts)
  const ledgerLookup = new Map<string, UnitMetrics>();
  for (const lu of ledgerUnits) {
    ledgerLookup.set(`${lu.type}:${lu.id}`, lu);
  }

  const ledgerEntry = ledgerLookup.get(`${completedUnit.type}:${completedUnit.id}`);
  let budgetMarkers = "";
  if (ledgerEntry) {
    if (ledgerEntry.truncationSections && ledgerEntry.truncationSections > 0) {
      budgetMarkers += ` ▼${ledgerEntry.truncationSections}`;
    }
    if (ledgerEntry.continueHereFired === true) {
      budgetMarkers += " → wrap-up";
    }
  }
  return budgetMarkers;
}

/**
 * Simulate the Cost & Usage budget summary line rendering logic.
 * Returns the plain text version (without ANSI colors).
 */
function renderCostBudgetLine(units: UnitMetrics[]): string | null {
  const totals = getProjectTotals(units);
  if (totals.totalTruncationSections > 0 || totals.continueHereFiredCount > 0) {
    const parts: string[] = [];
    if (totals.totalTruncationSections > 0) {
      parts.push(`${totals.totalTruncationSections} sections truncated`);
    }
    if (totals.continueHereFiredCount > 0) {
      parts.push(`${totals.continueHereFiredCount} continue-here fired`);
    }
    return parts.join(" · ");
  }
  return null;
}

/**
 * Simulate the By Model context window rendering logic.
 * Returns the context window label for a given model's aggregate.
 */
function renderModelContextWindow(units: UnitMetrics[], modelName: string): string | null {
  const models = aggregateByModel(units);
  const m = models.find(agg => agg.model === modelName);
  if (!m) return null;
  if (m.contextWindowTokens !== undefined) {
    return `[${formatTokenCount(m.contextWindowTokens)}]`;
  }
  return null;
}

// ─── Completed section: budget indicators ─────────────────────────────────────

describe('dashboard-budget', () => {
  test('Completed section: truncation + continue-here markers', () => {
    // Unit with truncation and continue-here — both markers appear
    const ledgerUnits = [
      makeUnit({ type: "execute-task", id: "M001/S01/T01", truncationSections: 3, continueHereFired: true }),
    ];
    const markers = renderCompletedBudgetMarkers(
      { type: "execute-task", id: "M001/S01/T01" },
      ledgerUnits,
    );
    assert.match(markers, /▼3/, "completed: shows ▼3 for 3 truncation sections");
    assert.match(markers, /→ wrap-up/, "completed: shows → wrap-up when continueHereFired");
  });

  {
    // Unit with truncation only — no wrap-up marker
    const ledgerUnits = [
      makeUnit({ type: "execute-task", id: "M001/S01/T01", truncationSections: 5, continueHereFired: false }),
    ];
    const markers = renderCompletedBudgetMarkers(
      { type: "execute-task", id: "M001/S01/T01" },
      ledgerUnits,
    );
    assert.match(markers, /▼5/, "completed: shows ▼5 truncation only");
    assert.doesNotMatch(markers, /wrap-up/, "completed: no wrap-up when continueHereFired=false");
  }

  {
    // Unit with continue-here only — no truncation marker
    const ledgerUnits = [
      makeUnit({ type: "execute-task", id: "M001/S01/T01", truncationSections: 0, continueHereFired: true }),
    ];
    const markers = renderCompletedBudgetMarkers(
      { type: "execute-task", id: "M001/S01/T01" },
      ledgerUnits,
    );
    assert.doesNotMatch(markers, /▼/, "completed: no ▼ when truncationSections=0");
    assert.match(markers, /→ wrap-up/, "completed: shows → wrap-up");
  }

  // ─── Completed section: missing ledger match ──────────────────────────────────

  test('Completed section: missing ledger match', () => {
    // Completed unit with no matching ledger entry — no crash, no markers
    const ledgerUnits = [
      makeUnit({ type: "execute-task", id: "M001/S01/T99", truncationSections: 3 }),
    ];
    const markers = renderCompletedBudgetMarkers(
      { type: "execute-task", id: "M001/S01/T01" },
      ledgerUnits,
    );
    assert.deepStrictEqual(markers, "", "missing match: empty markers when no ledger entry matches");
  });

  {
    // Empty ledger — no crash, no markers
    const markers = renderCompletedBudgetMarkers(
      { type: "execute-task", id: "M001/S01/T01" },
      [],
    );
    assert.deepStrictEqual(markers, "", "empty ledger: empty markers");
  }

  // ─── Completed section: retry handling (last entry wins) ──────────────────────

  test('Completed section: retry handling', () => {
    // Two ledger entries for same unit (retry) — last entry wins
    const ledgerUnits = [
      makeUnit({ type: "execute-task", id: "M001/S01/T01", truncationSections: 1 }),
      makeUnit({ type: "execute-task", id: "M001/S01/T01", truncationSections: 7 }),
    ];
    const markers = renderCompletedBudgetMarkers(
      { type: "execute-task", id: "M001/S01/T01" },
      ledgerUnits,
    );
    assert.match(markers, /▼7/, "retry: last entry's truncation count (7) wins over first (1)");
    assert.doesNotMatch(markers, /▼1/, "retry: first entry's count (1) is not shown");
  });

  // ─── By Model section: context window display ─────────────────────────────────

  test('By Model section: context window', () => {
    // Model with context window — shows formatted token count
    const units = [
      makeUnit({ model: "claude-sonnet-4-20250514", contextWindowTokens: 200000 }),
    ];
    const label = renderModelContextWindow(units, "claude-sonnet-4-20250514");
    assert.deepStrictEqual(label, "[200.0k]", "by model: shows [200.0k] for 200000 context window");
  });

  {
    // Model without context window — no label
    const units = [
      makeUnit({ model: "claude-sonnet-4-20250514" }),
    ];
    const label = renderModelContextWindow(units, "claude-sonnet-4-20250514");
    assert.deepStrictEqual(label, null, "by model: null when no contextWindowTokens");
  }

  {
    // Multiple models — each gets its own context window
    const units = [
      makeUnit({ model: "claude-sonnet-4-20250514", contextWindowTokens: 200000, cost: 0.05 }),
      makeUnit({ model: "claude-opus-4-20250514", contextWindowTokens: 200000, cost: 0.30 }),
    ];
    const sonnetLabel = renderModelContextWindow(units, "claude-sonnet-4-20250514");
    const opusLabel = renderModelContextWindow(units, "claude-opus-4-20250514");
    assert.deepStrictEqual(sonnetLabel, "[200.0k]", "by model multi: sonnet has context window");
    assert.deepStrictEqual(opusLabel, "[200.0k]", "by model multi: opus has context window");
  }

  // ─── By Model section: single model visibility ───────────────────────────────

  test('By Model section: single model visibility', () => {
    // With guard changed to >= 1, single model aggregation should produce results
    const units = [
      makeUnit({ model: "claude-sonnet-4-20250514" }),
    ];
    const models = aggregateByModel(units);
    assert.ok(models.length >= 1, "single model: aggregateByModel returns >= 1 entry");
    assert.deepStrictEqual(models.length, 1, "single model: exactly 1 model aggregate");
    assert.deepStrictEqual(models[0].model, "claude-sonnet-4-20250514", "single model: correct model name");
    // The guard `models.length >= 1` (changed from > 1) means this section now renders
    assert.ok(models.length >= 1, "single model: passes >= 1 guard (section will render)");
  });

  // ─── Cost & Usage: aggregate budget line ──────────────────────────────────────

  test('Cost & Usage: aggregate budget line', () => {
    // Units with truncation and continue-here — both stats appear
    const units = [
      makeUnit({ truncationSections: 3, continueHereFired: true }),
      makeUnit({ truncationSections: 2, continueHereFired: false }),
      makeUnit({ truncationSections: 1, continueHereFired: true }),
    ];
    const line = renderCostBudgetLine(units);
    assert.ok(line !== null, "cost budget: line rendered when budget data exists");
    assert.match(line!, /6 sections truncated/, "cost budget: shows total truncation count (3+2+1=6)");
    assert.match(line!, /2 continue-here fired/, "cost budget: shows continue-here count");
  });

  {
    // Only truncation, no continue-here
    const units = [
      makeUnit({ truncationSections: 4, continueHereFired: false }),
    ];
    const line = renderCostBudgetLine(units);
    assert.ok(line !== null, "cost budget truncation-only: line rendered");
    assert.match(line!, /4 sections truncated/, "cost budget truncation-only: shows count");
    assert.doesNotMatch(line!, /continue-here/, "cost budget truncation-only: no continue-here text");
  }

  {
    // Only continue-here, no truncation
    const units = [
      makeUnit({ truncationSections: 0, continueHereFired: true }),
    ];
    const line = renderCostBudgetLine(units);
    assert.ok(line !== null, "cost budget continue-only: line rendered");
    assert.doesNotMatch(line!, /truncated/, "cost budget continue-only: no truncation text");
    assert.match(line!, /1 continue-here fired/, "cost budget continue-only: shows count");
  }

  // ─── Backward compat: no budget fields ────────────────────────────────────────

  test('Backward compat: no budget data', () => {
    // Old-format units without budget fields — no indicators anywhere
    const oldUnits = [
      makeUnit(), // no budget fields
      makeUnit({ id: "M001/S01/T02" }),
    ];

    // Completed section: no markers
    const markers = renderCompletedBudgetMarkers(
      { type: "execute-task", id: "M001/S01/T01" },
      oldUnits,
    );
    assert.doesNotMatch(markers, /▼/, "backward compat completed: no truncation marker");
    assert.doesNotMatch(markers, /wrap-up/, "backward compat completed: no wrap-up marker");
    assert.deepStrictEqual(markers, "", "backward compat completed: empty markers string");

    // By Model section: no context window label
    const label = renderModelContextWindow(oldUnits, "claude-sonnet-4-20250514");
    assert.deepStrictEqual(label, null, "backward compat by-model: no context window label");

    // Cost & Usage: no budget line
    const line = renderCostBudgetLine(oldUnits);
    assert.deepStrictEqual(line, null, "backward compat cost: no budget summary line");

    // Aggregation still works
    const totals = getProjectTotals(oldUnits);
    assert.deepStrictEqual(totals.totalTruncationSections, 0, "backward compat: truncation total = 0");
    assert.deepStrictEqual(totals.continueHereFiredCount, 0, "backward compat: continueHere count = 0");
    assert.deepStrictEqual(totals.units, 2, "backward compat: unit count correct");
  });

  // ─── Edge cases ───────────────────────────────────────────────────────────────

  test('Edge cases', () => {
    // formatTokenCount for context window values
    assert.deepStrictEqual(formatTokenCount(200000), "200.0k", "format: 200000 → 200.0k");
    assert.deepStrictEqual(formatTokenCount(128000), "128.0k", "format: 128000 → 128.0k");
    assert.deepStrictEqual(formatTokenCount(1000000), "1.00M", "format: 1000000 → 1.00M");
    assert.deepStrictEqual(formatTokenCount(32000), "32.0k", "format: 32000 → 32.0k");
  });

  {
    // Completed unit key includes type — different types don't collide
    const ledgerUnits = [
      makeUnit({ type: "research-slice", id: "M001/S01", truncationSections: 2 }),
      makeUnit({ type: "plan-slice", id: "M001/S01", truncationSections: 5 }),
    ];
    const researchMarkers = renderCompletedBudgetMarkers(
      { type: "research-slice", id: "M001/S01" },
      ledgerUnits,
    );
    const planMarkers = renderCompletedBudgetMarkers(
      { type: "plan-slice", id: "M001/S01" },
      ledgerUnits,
    );
    assert.match(researchMarkers, /▼2/, "type-keying: research unit gets its own truncation count");
    assert.match(planMarkers, /▼5/, "type-keying: plan unit gets its own truncation count");
  }

  // ─── Summary ──────────────────────────────────────────────────────────────────

});
