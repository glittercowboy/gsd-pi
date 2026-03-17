/**
 * GSD Parallel Merge — Worktree reconciliation for parallel milestones.
 *
 * Handles merging completed milestone worktrees back to main branch
 * with safety checks for parallel execution context.
 */

import { loadFile } from "./files.js";
import { resolveMilestoneFile } from "./paths.js";
import { mergeMilestoneToMain } from "./auto-worktree.js";
import { MergeConflictError } from "./git-service.js";
import { removeSessionStatus } from "./session-status-io.js";
import type { WorkerInfo } from "./parallel-orchestrator.js";

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
 * Determine safe merge order for completed milestones.
 * Sequential: merge in milestone ID order (M001 before M002).
 * By-completion: merge in the order milestones finished.
 */
export function determineMergeOrder(
  workers: WorkerInfo[],
  order: MergeOrder = "sequential",
): string[] {
  const completed = workers.filter(w => w.state === "stopped" && w.completedUnits > 0);
  if (order === "by-completion") {
    return completed
      .sort((a, b) => a.startedAt - b.startedAt) // earliest first
      .map(w => w.milestoneId);
  }
  return completed
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
      error: err instanceof Error ? err.message : String(err),
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
  const mergeOrder = determineMergeOrder(workers, order);
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
