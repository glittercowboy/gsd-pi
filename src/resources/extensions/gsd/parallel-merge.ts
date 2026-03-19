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
import { nativeCommit } from "./native-git-bridge.js";
import { abortAndReset } from "./git-self-heal.js";
import { resolveMergeConflicts } from "./merge-healing.js";
import { analyzePreMergeImpact, emitAdaptationSignals } from "./pre-merge-impact.js";
import type { ImpactAnalysis } from "./pre-merge-impact.js";
import type { HealingAttempt } from "./merge-healing.js";
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
  healingAttempts?: HealingAttempt[];
  healingResolved?: boolean;
  impactAnalysis?: ImpactAnalysis;
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
  resolveFn?: (prompt: string) => Promise<string>,
  confidenceThreshold?: number,
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

    // Pre-merge impact analysis — non-fatal, must never block the merge
    let impactAnalysis: ImpactAnalysis | undefined;
    try {
      impactAnalysis = analyzePreMergeImpact(basePath, milestoneId);
      if (impactAnalysis.breakingChanges.length > 0) {
        emitAdaptationSignals(basePath, impactAnalysis);
      }
    } catch { /* non-fatal — impact analysis failure must not prevent merge */ }

    // Attempt the merge
    const result = mergeMilestoneToMain(basePath, milestoneId, roadmapContent);

    // Clean up parallel session status
    removeSessionStatus(basePath, milestoneId);

    return {
      milestoneId,
      success: true,
      commitMessage: result.commitMessage,
      pushed: result.pushed,
      impactAnalysis,
    };
  } catch (err) {
    if (err instanceof MergeConflictError) {
      // Attempt three-tier merge healing
      const healResult = await resolveMergeConflicts(
        basePath,
        milestoneId,
        err.conflictedFiles,
        resolveFn,
        confidenceThreshold,
      );

      if (healResult.resolved) {
        // All conflicts resolved — retry the merge commit
        const commitMessage = `feat(${milestoneId}): merge with automated conflict resolution`;
        nativeCommit(basePath, commitMessage);

        // Clean up parallel session status
        removeSessionStatus(basePath, milestoneId);

        return {
          milestoneId,
          success: true,
          commitMessage,
          healingAttempts: healResult.healingAttempts,
          healingResolved: true,
        };
      }

      // Healing could not resolve all conflicts — abort and restore clean state
      abortAndReset(basePath);

      return {
        milestoneId,
        success: false,
        error: `Merge conflict: ${healResult.unresolvedFiles.length} unresolved file(s) after healing`,
        conflictFiles: healResult.unresolvedFiles,
        healingAttempts: healResult.healingAttempts,
        healingResolved: false,
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
  resolveFn?: (prompt: string) => Promise<string>,
  confidenceThreshold?: number,
): Promise<MergeResult[]> {
  const mergeOrder = determineMergeOrder(workers, order);
  const results: MergeResult[] = [];

  for (const mid of mergeOrder) {
    const result = await mergeCompletedMilestone(basePath, mid, resolveFn, confidenceThreshold);
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
