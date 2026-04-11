// GSD — reopen-milestone tool handler

/**
 * reopen-milestone handler — the core operation behind gsd_milestone_reopen.
 *
 * Resets a closed milestone back to "active", all of its slices to
 * "in_progress", and all tasks to "pending". Cleans up stale filesystem
 * artifacts so the DB-filesystem reconciler does not auto-correct
 * entities back to "complete".
 */

import {
  getMilestone,
  getMilestoneSlices,
  getSliceTasks,
  updateMilestoneStatus,
  updateSliceStatus,
  updateTaskStatus,
  transaction,
} from "../gsd-db.js";
import { invalidateStateCache } from "../state.js";
import { isClosedStatus } from "../status-guards.js";
import { renderAllProjections } from "../workflow-projections.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning } from "../workflow-logger.js";
import { debugLog } from "../debug-logger.js";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveMilestonePath, resolveSlicePath, resolveTasksDir, clearPathCache } from "../paths.js";

export interface ReopenMilestoneParams {
  milestoneId: string;
  reason?: string;
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
}

export interface ReopenMilestoneResult {
  milestoneId: string;
  slicesReset: number;
  tasksReset: number;
}

export async function handleReopenMilestone(
  params: ReopenMilestoneParams,
  basePath: string,
): Promise<ReopenMilestoneResult | { error: string }> {
  // ── Validate required fields ────────────────────────────────────────────
  if (!params.milestoneId || typeof params.milestoneId !== "string" || params.milestoneId.trim() === "") {
    return { error: "milestoneId is required and must be a non-empty string" };
  }

  // ── Guards + DB writes inside a single transaction (prevents TOCTOU) ───
  let guardError: string | null = null;
  let slicesResetCount = 0;
  let tasksResetCount = 0;

  transaction(() => {
    const milestone = getMilestone(params.milestoneId);
    if (!milestone) {
      guardError = `milestone not found: ${params.milestoneId}`;
      return;
    }
    if (!isClosedStatus(milestone.status)) {
      guardError = `milestone ${params.milestoneId} is not closed (status: ${milestone.status}) — nothing to reopen`;
      return;
    }

    updateMilestoneStatus(params.milestoneId, "active", null);

    const slices = getMilestoneSlices(params.milestoneId);
    slicesResetCount = slices.length;

    for (const slice of slices) {
      updateSliceStatus(params.milestoneId, slice.id, "in_progress");
      const tasks = getSliceTasks(params.milestoneId, slice.id);
      tasksResetCount += tasks.length;
      for (const task of tasks) {
        updateTaskStatus(params.milestoneId, slice.id, task.id, "pending");
      }
    }
  });

  if (guardError) {
    return { error: guardError };
  }

  // ── Invalidate caches ────────────────────────────────────────────────────
  invalidateStateCache();

  // ── Clean up stale filesystem artifacts (M12 fix) ────────────────────────
  // Without this, the DB-filesystem reconciler sees SUMMARY.md files and
  // auto-corrects entities back to "complete", making reopen a no-op (#3161).
  try {
    const milestoneDir = resolveMilestonePath(basePath, params.milestoneId);
    if (milestoneDir) {
      const milestoneSummary = join(milestoneDir, `${params.milestoneId}-SUMMARY.md`);
      if (existsSync(milestoneSummary)) unlinkSync(milestoneSummary);
    }

    const slices = getMilestoneSlices(params.milestoneId);
    for (const slice of slices) {
      const sliceDir = resolveSlicePath(basePath, params.milestoneId, slice.id);
      if (sliceDir) {
        const sliceSummary = join(sliceDir, `${slice.id}-SUMMARY.md`);
        if (existsSync(sliceSummary)) unlinkSync(sliceSummary);
        const sliceUat = join(sliceDir, `${slice.id}-UAT.md`);
        if (existsSync(sliceUat)) unlinkSync(sliceUat);
      }

      const tasksDir = resolveTasksDir(basePath, params.milestoneId, slice.id);
      if (tasksDir) {
        const tasks = getSliceTasks(params.milestoneId, slice.id);
        for (const task of tasks) {
          const taskSummary = join(tasksDir, `${task.id}-SUMMARY.md`);
          if (existsSync(taskSummary)) unlinkSync(taskSummary);
        }
      }
    }
  } catch (err) { debugLog("reopen-milestone-cleanup-failed", { milestoneId: params.milestoneId, error: String(err) }); }
  clearPathCache();

  // ── Post-mutation hook ───────────────────────────────────────────────────
  try {
    await renderAllProjections(basePath, params.milestoneId);
    writeManifest(basePath);
    appendEvent(basePath, {
      cmd: "reopen-milestone",
      params: {
        milestoneId: params.milestoneId,
        reason: params.reason ?? null,
        slicesReset: slicesResetCount,
        tasksReset: tasksResetCount,
      },
      ts: new Date().toISOString(),
      actor: "agent",
      actor_name: params.actorName,
      trigger_reason: params.triggerReason,
    });
  } catch (hookErr) {
    logWarning("tool", `reopen-milestone post-mutation hook warning: ${(hookErr as Error).message}`);
  }

  return {
    milestoneId: params.milestoneId,
    slicesReset: slicesResetCount,
    tasksReset: tasksResetCount,
  };
}
