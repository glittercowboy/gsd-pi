/**
 * GSD Metrics Reader — JSONL File Parser
 *
 * Reads dispatch-metrics.jsonl files and returns UnitMetrics arrays.
 * Handles malformed/partial lines gracefully by skipping them.
 *
 * @module metrics-reader
 */

import { readFileSync, existsSync } from "node:fs";
import type { UnitMetrics } from "./metrics.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Result of reading a JSONL metrics file. */
export interface ReadMetricsResult {
  units: UnitMetrics[];
  skippedLines: number;
  totalLines: number;
}

// ─── Reader Implementation ─────────────────────────────────────────────────────

/**
 * Read a JSONL metrics file and parse into UnitMetrics array.
 *
 * - Reads the file synchronously
 * - Splits by newline
 * - Parses each non-empty line as JSON
 * - Skips malformed lines silently (returns count in result)
 *
 * @param filePath - Path to the JSONL file
 * @returns Object with parsed units, skip count, and total line count
 */
export function readMetricsJsonl(filePath: string): ReadMetricsResult {
  const result: ReadMetricsResult = {
    units: [],
    skippedLines: 0,
    totalLines: 0,
  };

  // Check file exists
  if (!existsSync(filePath)) {
    return result;
  }

  // Read file content
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    // File read error — return empty result
    return result;
  }

  // Handle empty file
  if (!content.trim()) {
    return result;
  }

  // Split by newline and process each line
  const lines = content.split("\n");
  result.totalLines = lines.length;

  for (const line of lines) {
    // Skip empty lines
    if (!line.trim()) {
      continue;
    }

    // Try to parse as JSON
    try {
      const parsed = JSON.parse(line);
      // Validate required UnitMetrics fields
      if (
        typeof parsed === "object" && parsed !== null &&
        typeof parsed.type === "string" &&
        typeof parsed.id === "string" &&
        typeof parsed.startedAt === "number" &&
        typeof parsed.finishedAt === "number" &&
        typeof parsed.tokens === "object" && parsed.tokens !== null
      ) {
        result.units.push(parsed as UnitMetrics);
      } else {
        result.skippedLines++;
      }
    } catch {
      // Malformed JSON — skip
      result.skippedLines++;
    }
  }

  return result;
}

/**
 * Read multiple JSONL files and merge into a single ledger.
 *
 * @param filePaths - Array of file paths to read
 * @returns Merged array of UnitMetrics from all files
 */
export function readMultipleJsonl(filePaths: string[]): ReadMetricsResult {
  const merged: ReadMetricsResult = {
    units: [],
    skippedLines: 0,
    totalLines: 0,
  };

  for (const filePath of filePaths) {
    const result = readMetricsJsonl(filePath);
    merged.units.push(...result.units);
    merged.skippedLines += result.skippedLines;
    merged.totalLines += result.totalLines;
  }

  return merged;
}