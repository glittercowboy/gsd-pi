/**
 * GSD Metrics Logger — Write unit-level telemetry to .gsd/activity/
 *
 * Each unit dispatch writes its complete UnitMetrics object as a single-line 
 * JSON entry in a dispatch-metrics.jsonl file.
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { gsdRoot } from "./paths.js";
import type { UnitMetrics } from "./metrics.js";

/**
 * Persist unit-level telemetry for a completed dispatch unit.
 * Appends the UnitMetrics object as a single JSON line.
 */
export function persistUnitMetrics(basePath: string, metrics: UnitMetrics): void {
  try {
    const activityDir = join(gsdRoot(basePath), "activity");
    mkdirSync(activityDir, { recursive: true });
    
    // Write to dispatch-metrics.jsonl — a shared JSONL file per activity directory
    // to avoid creating thousands of tiny files.
    const metricsPath = join(activityDir, "dispatch-metrics.jsonl");
    
    const line = JSON.stringify(metrics) + "\n";
    appendFileSync(metricsPath, line, "utf-8");
  } catch (e) {
    // Non-fatal — telemetry should not block dispatch execution
    void e; 
  }
}
