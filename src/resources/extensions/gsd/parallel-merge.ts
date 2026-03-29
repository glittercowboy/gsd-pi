/**
 * GSD Parallel Merge — Worktree reconciliation for parallel milestones.
 *
 * Handles merging completed milestone worktrees back to main branch
 * with safety checks for parallel execution context.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { loadFile } from "./files.js";
import { resolveMilestoneFile } from "./paths.js";
import { mergeMilestoneToMain } from "./auto-worktree.js";
import { MergeConflictError } from "./git-service.js";
import { removeSessionStatus } from "./session-status-io.js";
import type { WorkerInfo } from "./parallel-orchestrator.js";
import { getErrorMessage } from "./error-utils.js";
import { queryExternalDb } from "./gsd-db.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface MergeResult {
  milestoneId: string;
  success: boolean;
  commitMessage?: string;
  pushed?: boolean;
  error?: string;
  conflictFiles?: string[];
}

export type MergeOrder = "sequential" | "by-completion";

// ─── Worktree DB Check ─────────────────────────────────────────────────────

/**
 * Check the worktree's SQLite DB for actual milestone completion status.
 * This is the ground truth — independent of orchestrator state or status.json.
 *
 * The orchestrator's in-memory worker state (`WorkerInfo.state`) can be stale
 * when workers are manually respawned, when status.json files are cleaned up,
 * or when the orchestrator crashes and restores from disk. The worktree DB is
 * written by the worker itself during `gsd_complete_milestone` and is always
 * authoritative.
 */
function isMilestoneCompleteInWorktree(basePath: string, mid: string): boolean {
  const dbPath = join(basePath, ".gsd", "worktrees", mid, ".gsd", "gsd.db");
  if (!existsSync(dbPath)) return false;

  try {
    const rows = queryExternalDb(
      dbPath,
      "SELECT status FROM milestones WHERE id = ?",
      [mid],
    );
    return rows.length > 0 && rows[0]["status"] === "complete";
  } catch {
    return false;
  }
}

/**
 * Discover all milestone worktrees and return those that are actually complete.
 * Scans .gsd/worktrees/ directories and checks the DB — does not depend on
 * orchestrator state, status.json files, or in-memory worker tracking.
 */
function discoverCompletedMilestones(basePath: string): string[] {
  const worktreeDir = join(basePath, ".gsd", "worktrees");
  if (!existsSync(worktreeDir)) return [];

  const completed: string[] = [];
  try {
    for (const dir of readdirSync(worktreeDir)) {
      if (!dir.startsWith("M")) continue;
      if (isMilestoneCompleteInWorktree(basePath, dir)) {
        completed.push(dir);
      }
    }
  } catch { /* skip */ }

  return completed.sort();
}

// ─── Merge Queue ───────────────────────────────────────────────────────────

/**
 * Determine safe merge order for completed milestones.
 * Checks both orchestrator worker state AND worktree DB ground truth.
 * Sequential: merge in milestone ID order (M001 before M002).
 * By-completion: merge in the order milestones finished.
 */
export function determineMergeOrder(
  workers: WorkerInfo[],
  order: MergeOrder = "sequential",
  basePath?: string,
): string[] {
  // Primary: workers the orchestrator knows about with state "stopped"
  const fromOrchestrator = workers
    .filter(w => w.state === "stopped")
    .map(w => w.milestoneId);

  // Fallback: scan worktree DBs for actually-complete milestones.
  // This catches workers that completed after the orchestrator died,
  // were manually respawned, or whose status.json was cleaned up.
  const fromWorktrees = basePath ? discoverCompletedMilestones(basePath) : [];

  // Union — deduplicate
  const allCompleted = [...new Set([...fromOrchestrator, ...fromWorktrees])];

  if (order === "by-completion") {
    const orchestratorMap = new Map(workers.map(w => [w.milestoneId, w]));
    return allCompleted.sort((a, b) => {
      const aTime = orchestratorMap.get(a)?.startedAt ?? Infinity;
      const bTime = orchestratorMap.get(b)?.startedAt ?? Infinity;
      return aTime - bTime;
    });
  }

  return allCompleted.sort((a, b) => a.localeCompare(b));
}

/**
 * Attempt to merge a single milestone's worktree back to main.
 * Wraps mergeMilestoneToMain with error handling for parallel context.
 */
export async function mergeCompletedMilestone(
  basePath: string,
  milestoneId: string,
): Promise<MergeResult> {
  try {
    // Load the roadmap content (needed by mergeMilestoneToMain)
    const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
    if (!roadmapPath) {
      return {
        milestoneId,
        success: false,
        error: `No roadmap found for ${milestoneId}`,
      };
    }

    const roadmapContent = await loadFile(roadmapPath);
    if (!roadmapContent) {
      return {
        milestoneId,
        success: false,
        error: `Could not read roadmap for ${milestoneId}`,
      };
    }

    // Attempt the merge
    const result = mergeMilestoneToMain(basePath, milestoneId, roadmapContent);

    // Clean up parallel session status
    removeSessionStatus(basePath, milestoneId);

    return {
      milestoneId,
      success: true,
      commitMessage: result.commitMessage,
      pushed: result.pushed,
    };
  } catch (err) {
    if (err instanceof MergeConflictError) {
      return {
        milestoneId,
        success: false,
        error: `Merge conflict: ${err.conflictedFiles.length} conflicting file(s)`,
        conflictFiles: err.conflictedFiles,
      };
    }
    return {
      milestoneId,
      success: false,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Merge all completed milestones in sequence.
 * Stops on first conflict and returns results so far.
 */
export async function mergeAllCompleted(
  basePath: string,
  workers: WorkerInfo[],
  order: MergeOrder = "sequential",
): Promise<MergeResult[]> {
  const mergeOrder = determineMergeOrder(workers, order, basePath);
  const results: MergeResult[] = [];

  for (const mid of mergeOrder) {
    const result = await mergeCompletedMilestone(basePath, mid);
    results.push(result);

    // Stop on first conflict — later merges may depend on this one
    if (!result.success && result.conflictFiles) {
      break;
    }
  }

  return results;
}

/**
 * Format merge results for display.
 */
export function formatMergeResults(results: MergeResult[]): string {
  if (results.length === 0) return "No completed milestones to merge.";

  const lines: string[] = ["# Merge Results\n"];

  for (const r of results) {
    if (r.success) {
      const pushStatus = r.pushed ? " (pushed)" : "";
      lines.push(`- **${r.milestoneId}** — merged successfully${pushStatus}`);
    } else if (r.conflictFiles) {
      lines.push(`- **${r.milestoneId}** — CONFLICT (${r.conflictFiles.length} file(s)):`);
      for (const f of r.conflictFiles) {
        lines.push(`  - \`${f}\``);
      }
      lines.push(`  Resolve conflicts manually and run \`/gsd parallel merge ${r.milestoneId}\` to retry.`);
    } else {
      lines.push(`- **${r.milestoneId}** — failed: ${r.error}`);
    }
  }

  return lines.join("\n");
}
