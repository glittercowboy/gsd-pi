/**
 * run-manager.ts — Create and list isolated workflow run directories.
 *
 * Each run lives under `.gsd/workflow-runs/<name>/<timestamp>/` and contains:
 * - DEFINITION.yaml — frozen snapshot of the workflow definition at run-creation time
 * - GRAPH.yaml — initialized step graph with all steps pending
 * - PARAMS.json — (optional) parameter overrides used for this run
 *
 * Observability:
 * - All run state is on disk in human-readable YAML/JSON — inspectable with cat/less.
 * - `listRuns()` returns structured metadata including step counts and overall status.
 * - Timestamp directory names are filesystem-safe (ISO with hyphens replacing colons).
 * - Errors include the full path context for diagnosis.
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadDefinition, substituteParams } from "./definition-loader.js";
import { initializeGraph, writeGraph, readGraph } from "./graph.js";
import type { WorkflowDefinition } from "./definition-loader.js";
import type { WorkflowGraph } from "./graph.js";

// ─── Types ───────────────────────────────────────────────────────────────

export interface RunMetadata {
  /** Workflow definition name. */
  name: string;
  /** Filesystem-safe timestamp string used as dir name. */
  timestamp: string;
  /** Full path to the run directory. */
  runDir: string;
  /** Step counts derived from GRAPH.yaml. */
  steps: { total: number; completed: number; pending: number; active: number };
  /** Overall status derived from step states. */
  status: "pending" | "running" | "complete";
}

// ─── Constants ───────────────────────────────────────────────────────────

const RUNS_DIR = "workflow-runs";
const DEFS_DIR = "workflow-defs";

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Generate a filesystem-safe timestamp: `YYYY-MM-DDTHH-MM-SS`.
 * Replaces colons with hyphens so the string is safe as a directory name
 * on all platforms (Windows forbids colons in paths).
 */
function makeTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/:/g, "-").replace(/\.\d{3}Z$/, "");
}

/**
 * Derive overall status from a graph's step statuses.
 */
function deriveStatus(graph: WorkflowGraph): "pending" | "running" | "complete" {
  const hasActive = graph.steps.some((s) => s.status === "active");
  const allDone = graph.steps.every(
    (s) => s.status === "complete" || s.status === "expanded",
  );
  if (allDone) return "complete";
  if (hasActive) return "running";
  return "pending";
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Create a new isolated run directory for a workflow definition.
 *
 * 1. Loads the definition from `<basePath>/.gsd/workflow-defs/<defName>.yaml`
 * 2. Applies parameter substitution if overrides are provided
 * 3. Creates `<basePath>/.gsd/workflow-runs/<defName>/<timestamp>/`
 * 4. Writes frozen DEFINITION.yaml, initialized GRAPH.yaml, and optional PARAMS.json
 *
 * @param basePath — project root directory
 * @param defName — definition filename (without .yaml extension)
 * @param overrides — optional parameter overrides (merged with definition defaults)
 * @returns Full path to the created run directory
 * @throws Error if the definition file doesn't exist or is invalid
 */
export function createRun(
  basePath: string,
  defName: string,
  overrides?: Record<string, string>,
): string {
  const defsDir = join(basePath, ".gsd", DEFS_DIR);

  // Load and validate the definition
  const rawDef = loadDefinition(defsDir, defName);

  // Apply parameter substitution if overrides provided
  const def: WorkflowDefinition = overrides
    ? substituteParams(rawDef, overrides)
    : substituteParams(rawDef); // still resolve default params if any

  // Create the run directory
  const timestamp = makeTimestamp();
  const runDir = join(basePath, ".gsd", RUNS_DIR, defName, timestamp);
  mkdirSync(runDir, { recursive: true });

  // Freeze the definition as DEFINITION.yaml
  writeFileSync(join(runDir, "DEFINITION.yaml"), stringify(def), "utf-8");

  // Initialize and write GRAPH.yaml
  const graph = initializeGraph(def);
  writeGraph(runDir, graph);

  // Write PARAMS.json if overrides were provided
  if (overrides && Object.keys(overrides).length > 0) {
    writeFileSync(
      join(runDir, "PARAMS.json"),
      JSON.stringify(overrides, null, 2),
      "utf-8",
    );
  }

  return runDir;
}

/**
 * List existing workflow runs with metadata.
 *
 * Scans `<basePath>/.gsd/workflow-runs/` for run directories. Each run's
 * GRAPH.yaml is read to derive step counts and overall status.
 *
 * @param basePath — project root directory
 * @param defName — optional filter: only list runs for this definition name
 * @returns Array of run metadata, sorted newest-first within each definition
 */
export function listRuns(basePath: string, defName?: string): RunMetadata[] {
  const runsRoot = join(basePath, ".gsd", RUNS_DIR);
  if (!existsSync(runsRoot)) return [];

  const results: RunMetadata[] = [];

  // Get workflow name directories
  const nameDirs = defName ? [defName] : readdirSync(runsRoot).filter((entry) => {
    const full = join(runsRoot, entry);
    return statSync(full).isDirectory();
  });

  for (const name of nameDirs) {
    const nameDir = join(runsRoot, name);
    if (!existsSync(nameDir)) continue;

    const timestamps = readdirSync(nameDir).filter((entry) => {
      const full = join(nameDir, entry);
      return statSync(full).isDirectory();
    });

    // Sort newest-first (ISO strings sort lexicographically)
    timestamps.sort().reverse();

    for (const ts of timestamps) {
      const runDir = join(nameDir, ts);
      try {
        const graph = readGraph(runDir);
        const total = graph.steps.length;
        const completed = graph.steps.filter((s) => s.status === "complete").length;
        const pending = graph.steps.filter((s) => s.status === "pending").length;
        const active = graph.steps.filter((s) => s.status === "active").length;

        results.push({
          name,
          timestamp: ts,
          runDir,
          steps: { total, completed, pending, active },
          status: deriveStatus(graph),
        });
      } catch {
        // Skip runs with invalid/missing GRAPH.yaml
      }
    }
  }

  return results;
}
