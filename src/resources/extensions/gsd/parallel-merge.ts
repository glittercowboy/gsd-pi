/**
 * GSD Parallel Merge — Worktree reconciliation for parallel milestones.
 *
 * Handles merging completed milestone worktrees back to main branch
 * with safety checks for parallel execution context.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadFile } from "./files.js";
import { resolveMilestoneFile } from "./paths.js";
import { mergeMilestoneToMain } from "./auto-worktree.js";
import { MergeConflictError } from "./git-service.js";
import { removeSessionStatus } from "./session-status-io.js";
import type { WorkerInfo } from "./parallel-orchestrator.js";
import { getErrorMessage } from "./error-utils.js";

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

// ─── Merge Queue ───────────────────────────────────────────────────────────

/**
 * Check whether a milestone is complete by querying its worktree SQLite DB.
 * Uses a subprocess to avoid disrupting the global DB singleton.
 * Returns true when milestones.status = 'complete' in the worktree's gsd.db.
 */
export function isMilestoneCompleteInWorktreeDb(basePath: string, mid: string): boolean {
  const dbPath = join(basePath, ".gsd", "worktrees", mid, ".gsd", "gsd.db");
  if (!existsSync(dbPath)) return false;

  try {
    const result = spawnSync(
      "sqlite3",
      [dbPath, `SELECT status FROM milestones WHERE id='${mid}' LIMIT 1`],
      { timeout: 3000, encoding: "utf-8" },
    );
    return (result.stdout || "").trim() === "complete";
  } catch {
    return false;
  }
}

/**
 * Discover milestone IDs with status='complete' in their worktree DB,
 * scanning .gsd/worktrees/<MID>/.gsd/gsd.db for each worktree directory.
 */
function discoverDbCompletedMilestones(basePath: string): Set<string> {
  const completed = new Set<string>();
  const worktreeDir = join(basePath, ".gsd", "worktrees");
  try {
    for (const entry of readdirSync(worktreeDir)) {
      if (entry.startsWith("M") && isMilestoneCompleteInWorktreeDb(basePath, entry)) {
        completed.add(entry);
      }
    }
  } catch {
    // worktrees dir may not exist
  }
  return completed;
}

/**
 * Determine safe merge order for completed milestones.
 * Sequential: merge in milestone ID order (M001 before M002).
 * By-completion: merge in the order milestones finished.
 *
 * When basePath is provided, also checks worktree SQLite DBs as the
 * source of truth — workers with stale orchestrator state (e.g. "error")
 * are included if their worktree DB shows status='complete'.
 * See: https://github.com/gsd-build/gsd-2/issues/2812
 */
export function determineMergeOrder(
  workers: WorkerInfo[],
  order: MergeOrder = "sequential",
  basePath?: string,
): string[] {
  // Start with workers the orchestrator already knows are stopped
  const stoppedIds = new Set(
    workers.filter(w => w.state === "stopped").map(w => w.milestoneId),
  );

  // When basePath is available, also check worktree DBs for milestones
  // whose orchestrator state is stale but are actually complete (#2812)
  const dbCompleted = basePath ? discoverDbCompletedMilestones(basePath) : new Set<string>();

  // Union: milestone is mergeable if stopped OR DB-complete
  const mergeableIds = new Set([...stoppedIds, ...dbCompleted]);

  // Build the list from tracked workers + any DB-discovered milestones
  // not tracked by the orchestrator at all
  const workerMap = new Map(workers.map(w => [w.milestoneId, w]));
  const allMergeable: WorkerInfo[] = [];
  for (const mid of mergeableIds) {
    const w = workerMap.get(mid);
    if (w) {
      allMergeable.push(w);
    } else {
      // Milestone discovered from worktree DB but not in workers list
      allMergeable.push({
        milestoneId: mid,
        title: mid,
        pid: 0,
        process: null,
        worktreePath: basePath ? join(basePath, ".gsd", "worktrees", mid) : "",
        startedAt: 0,
        state: "stopped",
        cost: 0,
      });
    }
  }

  if (order === "by-completion") {
    return allMergeable
      .sort((a, b) => a.startedAt - b.startedAt) // earliest first
      .map(w => w.milestoneId);
  }
  return allMergeable
    .sort((a, b) => a.milestoneId.localeCompare(b.milestoneId))
    .map(w => w.milestoneId);
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
