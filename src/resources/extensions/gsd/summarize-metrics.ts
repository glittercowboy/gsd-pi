/**
 * GSD Metrics Summary — Comparison Table Utility
 *
 * Reads MetricsLedger objects and produces structured comparison data
 * and human-readable Markdown tables for baseline-vs-treatment analysis.
 *
 * @module summarize-metrics
 */

import type {
  MetricsLedger,
  MetricsPhase,
  ProjectTotals,
  InterventionCounts,
  FactCheckMetrics,
  UnitMetrics,
} from "./metrics.js";
import {
  aggregateByPhase,
  getProjectTotals,
  formatCost,
  formatTokenCount,
  classifyUnitPhase,
} from "./metrics.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Input ledger with a label for table columns. */
export interface LedgerInput {
  label: string;
  ledger: MetricsLedger;
}

/** Per-phase metrics for one ledger in the comparison. */
export interface PhaseEntry {
  label: string;
  units: number;
  tokens: number;
  cost: number;
  interventions: number; // total of all intervention types
  factChecks: number; // claims checked
  wallClockMs: number;
}

/** One row in the comparison table (one phase, values per ledger). */
export interface ComparisonRow {
  phase: MetricsPhase;
  entries: PhaseEntry[];
}

/** Full comparison result with per-phase rows and per-ledger totals. */
export interface MetricsComparison {
  rows: ComparisonRow[];
  totals: { label: string; totals: ProjectTotals }[];
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

/** Aggregate M007 fields (interventions, factCheck, wallClock) for a set of units in one phase. */
function aggregatePhaseExtras(units: UnitMetrics[]): {
  interventions: number;
  factChecks: number;
  wallClockMs: number;
} {
  let interventions = 0;
  let factChecks = 0;
  let wallClockMs = 0;

  for (const u of units) {
    if (u.interventions) {
      interventions += u.interventions.blocker + u.interventions.correction + u.interventions.redirect;
    }
    if (u.factCheck) {
      factChecks += u.factCheck.claimsChecked;
    }
    // Use explicit wallClockMs or derive from timestamps
    wallClockMs += u.wallClockMs ?? (u.finishedAt - u.startedAt);
  }

  return { interventions, factChecks, wallClockMs };
}

/**
 * Aggregate metrics from multiple ledgers into a structured comparison.
 *
 * @param inputs - Array of labeled ledgers to compare
 * @returns Structured comparison with per-phase rows and per-ledger totals
 */
export function summarizeMetrics(inputs: LedgerInput[]): MetricsComparison {
  const rows: ComparisonRow[] = [];
  const totals: { label: string; totals: ProjectTotals }[] = [];

  // Collect all phases across all ledgers
  const allPhases = new Set<MetricsPhase>();

  // Build phase -> entries mapping for each ledger
  const ledgerPhaseData = inputs.map(({ label, ledger }) => {
    const units = ledger.units;
    const phaseAggs = aggregateByPhase(units);

    // Track which phases this ledger has
    for (const agg of phaseAggs) {
      allPhases.add(agg.phase);
    }

    // Map phase -> units for extra aggregation
    const phaseToUnits = new Map<MetricsPhase, UnitMetrics[]>();
    for (const u of units) {
      const phase = classifyUnitPhase(u.type);
      const arr = phaseToUnits.get(phase) ?? [];
      arr.push(u);
      phaseToUnits.set(phase, arr);
    }

    // Build phase -> PhaseEntry map
    const phaseEntries = new Map<MetricsPhase, PhaseEntry>();
    for (const agg of phaseAggs) {
      const phaseUnits = phaseToUnits.get(agg.phase) ?? [];
      const extras = aggregatePhaseExtras(phaseUnits);
      phaseEntries.set(agg.phase, {
        label,
        units: agg.units,
        tokens: agg.tokens.total,
        cost: agg.cost,
        interventions: extras.interventions,
        factChecks: extras.factChecks,
        wallClockMs: extras.wallClockMs,
      });
    }

    // Store totals
    totals.push({ label, totals: getProjectTotals(units) });

    return { label, phaseEntries };
  });

  // Build rows in stable phase order
  const phaseOrder: MetricsPhase[] = ["research", "planning", "execution", "completion", "reassessment"];

  for (const phase of phaseOrder) {
    if (!allPhases.has(phase)) continue;

    const entries: PhaseEntry[] = ledgerPhaseData.map(({ label, phaseEntries }) => {
      const entry = phaseEntries.get(phase);
      if (entry) return entry;

      // Empty entry for ledger without this phase
      return {
        label,
        units: 0,
        tokens: 0,
        cost: 0,
        interventions: 0,
        factChecks: 0,
        wallClockMs: 0,
      };
    });

    rows.push({ phase, entries });
  }

  return { rows, totals };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/** Format a millisecond duration as human-readable string. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

/**
 * Render a Markdown comparison table from metrics comparison data.
 *
 * @param comparison - The structured comparison data
 * @returns Markdown table string
 */
export function formatComparisonTable(comparison: MetricsComparison): string {
  const { rows, totals } = comparison;

  if (totals.length === 0) {
    return "_No ledgers to compare._\n";
  }

  const labels = totals.map(t => t.label);
  const numCols = labels.length;

  // Header row
  const headerCells = ["Phase", ...labels];
  const separatorCells = ["---", ...labels.map(() => "---")];

  // Build data rows
  const dataRows: string[][] = [];

  for (const row of rows) {
    // Phase name row (tokens)
    const tokenCells = [
      `${row.phase} (tokens)`,
      ...row.entries.map(e => formatTokenCount(e.tokens)),
    ];

    // Cost row
    const costCells = [
      `${row.phase} (cost)`,
      ...row.entries.map(e => formatCost(e.cost)),
    ];

    // Interventions row
    const interventionCells = [
      `${row.phase} (interventions)`,
      ...row.entries.map(e => `${e.interventions}`),
    ];

    // Fact-checks row
    const factCheckCells = [
      `${row.phase} (fact-checks)`,
      ...row.entries.map(e => `${e.factChecks}`),
    ];

    // Duration row
    const durationCells = [
      `${row.phase} (duration)`,
      ...row.entries.map(e => formatDuration(e.wallClockMs)),
    ];

    dataRows.push(tokenCells, costCells, interventionCells, factCheckCells, durationCells);
  }

  // Totals section
  dataRows.push(["---", ...labels.map(() => "---")]);

  for (const { label, totals: t } of totals) {
    const totalInterventions =
      t.totalInterventions.blocker +
      t.totalInterventions.correction +
      t.totalInterventions.redirect;

    dataRows.push(
      [`**${label} total**`, `Units: ${t.units}`],
      ["", `Tokens: ${formatTokenCount(t.tokens.total)}`],
      ["", `Cost: ${formatCost(t.cost)}`],
      ["", `Interventions: ${totalInterventions}`],
      ["", `Fact-checks: ${t.totalFactChecks.claimsChecked}`],
      ["", `Duration: ${formatDuration(t.duration)}`],
    );
  }

  // Build table
  const lines: string[] = [];

  // Header
  lines.push(`| ${headerCells.join(" | ")} |`);
  lines.push(`| ${separatorCells.join(" | ")} |`);

  // Data rows
  for (const row of dataRows) {
    // Pad row to match column count
    while (row.length < numCols + 1) {
      row.push("");
    }
    lines.push(`| ${row.join(" | ")} |`);
  }

  return lines.join("\n") + "\n";
}
