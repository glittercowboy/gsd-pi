/**
 * GSD Metrics Report CLI
 *
 * Reads dispatch-metrics.jsonl files and prints Markdown comparison tables.
 *
 * Usage:
 *   npx tsx src/resources/extensions/gsd/report-metrics.ts <file1.jsonl> [file2.jsonl ...]
 *
 * Each file is treated as a separate ledger (useful for baseline/treatment comparisons).
 *
 * @module report-metrics
 */

import { basename } from "node:path";
import { existsSync } from "node:fs";
import { summarizeMetrics, formatComparisonTable, type LedgerInput } from "./summarize-metrics.js";
import { readMetricsJsonl } from "./metrics-reader.js";
import type { MetricsLedger } from "./metrics.js";

// ─── CLI Entry Point ───────────────────────────────────────────────────────────

function printUsage(): void {
  console.error("Usage: report-metrics <file1.jsonl> [file2.jsonl ...]");
  console.error("");
  console.error("Reads one or more JSONL metrics files and prints a Markdown comparison table.");
  console.error("Each file is treated as a separate ledger for baseline/treatment comparisons.");
  console.error("");
  console.error("Examples:");
  console.error("  npx tsx report-metrics.ts .gsd/activity/dispatch-metrics.jsonl");
  console.error("  npx tsx report-metrics.ts baseline.jsonl treatment.jsonl");
}

function main(): void {
  const args = process.argv.slice(2);

  // No arguments — print usage
  if (args.length === 0) {
    printUsage();
    process.exit(1);
  }

  // Process each file
  const inputs: LedgerInput[] = [];
  let totalSkipped = 0;
  let totalLines = 0;

  for (const filePath of args) {
    // Check file exists
    if (!existsSync(filePath)) {
      console.log(`_File not found: ${filePath}_`);
      continue;
    }

    // Read and parse
    console.error(`[report-metrics] reading ${filePath}`);
    const result = readMetricsJsonl(filePath);
    totalSkipped += result.skippedLines;
    totalLines += result.totalLines;

    console.error(`[report-metrics] parsed ${result.units.length} valid units, skipped ${result.skippedLines} malformed lines`);

    // Skip empty files
    if (result.units.length === 0) {
      console.log(`_No metrics found in ${filePath}_`);
      continue;
    }

    // Create ledger input
    const label = basename(filePath, ".jsonl");
    const ledger: MetricsLedger = {
      version: 1,
      projectStartedAt: result.units[0]?.startedAt ?? Date.now(),
      units: result.units,
    };

    inputs.push({ label, ledger });
  }

  // Print summary diagnostic
  if (totalSkipped > 0) {
    console.error(`[report-metrics] total: ${totalLines} lines, ${totalSkipped} skipped`);
  }

  // No valid inputs — nothing to compare
  if (inputs.length === 0) {
    console.log("_No metrics to compare._");
    return;
  }

  // Generate and print comparison table
  const comparison = summarizeMetrics(inputs);
  const table = formatComparisonTable(comparison);
  console.log(table);
}

main();