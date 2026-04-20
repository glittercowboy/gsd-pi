/**
 * reopen-task handler — the core operation behind gsd_task_reopen.
 *
 * Resets a completed task back to "pending" so it can be re-done
 * without manual SQL surgery. The parent slice and milestone must
 * still be open (not complete) — you cannot reopen tasks inside a
 * closed slice.
 */

// GSD — reopen-task tool handler
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import {
  getMilestone,
  getSlice,
  getTask,
  updateTaskStatus,
  transaction,
} from "../gsd-db.js";
import { invalidateStateCache } from "../state.js";
import { isClosedStatus } from "../status-guards.js";
import { renderAllProjections } from "../workflow-projections.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning } from "../workflow-logger.js";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveTasksDir, clearPathCache } from "../paths.js";

export interface ReopenTaskParams {
  milestoneId: string;
  sliceId: string;
  taskId: string;
  reason?: string;
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
}

export interface ReopenTaskResult {
  milestoneId: string;
  sliceId: string;
  taskId: string;
}

export async function handleReopenTask(
  params: ReopenTaskParams,
  basePath: string,
): Promise<ReopenTaskResult | { error: string }> {
  // ── Validate required fields ────────────────────────────────────────────
  if (!params.taskId || typeof params.taskId !== "string" || params.taskId.trim() === "") {
    return { error: "taskId is required and must be a non-empty string" };
  }
  if (!params.sliceId || typeof params.sliceId !== "string" || params.sliceId.trim() === "") {
    return { error: "sliceId is required and must be a non-empty string" };
  }
  if (!params.milestoneId || typeof params.milestoneId !== "string" || params.milestoneId.trim() === "") {
    return { error: "milestoneId is required and must be a non-empty string" };
  }

  // ── Guards + DB write inside a single transaction (prevents TOCTOU) ────
  let guardError: string | null = null;

  transaction(() => {
    const milestone = getMilestone(params.milestoneId);
    if (!milestone) {
      guardError = `milestone not found: ${params.milestoneId}`;
      return;
    }
    if (isClosedStatus(milestone.status)) {
      guardError = `cannot reopen task in a closed milestone: ${params.milestoneId} (status: ${milestone.status})`;
      return;
    }

    const slice = getSlice(params.milestoneId, params.sliceId);
    if (!slice) {
      guardError = `slice not found: ${params.milestoneId}/${params.sliceId}`;
      return;
    }
    if (isClosedStatus(slice.status)) {
      guardError = `cannot reopen task in a closed slice: ${params.sliceId} (status: ${slice.status}) — use gsd_slice_reopen first`;
      return;
    }

    const task = getTask(params.milestoneId, params.sliceId, params.taskId);
    if (!task) {
      guardError = `task not found: ${params.milestoneId}/${params.sliceId}/${params.taskId}`;
      return;
    }
    if (!isClosedStatus(task.status)) {
      guardError = `task ${params.taskId} is not complete (status: ${task.status}) — nothing to reopen`;
      return;
    }

    updateTaskStatus(params.milestoneId, params.sliceId, params.taskId, "pending");
  });

  if (guardError) {
    return { error: guardError };
  }

  // ── Invalidate caches ────────────────────────────────────────────────────
  invalidateStateCache();

  // ── Clean up stale filesystem artifacts (M12 fix) ────────────────────────
  // Without this, the DB-filesystem reconciler sees the SUMMARY.md and
  // auto-corrects the task back to "complete", making reopen a no-op (#3161).
  try {
    const tasksDir = resolveTasksDir(basePath, params.milestoneId, params.sliceId);
    if (tasksDir) {
      const summaryPath = join(tasksDir, `${params.taskId}-SUMMARY.md`);
      if (existsSync(summaryPath)) unlinkSync(summaryPath);
    }
  } catch (cleanupErr) {
    logWarning("tool", `reopen-task artifact cleanup warning: ${(cleanupErr as Error).message}`);
  }
  clearPathCache();

  // ── Post-mutation hook ───────────────────────────────────────────────────
  try {
    await renderAllProjections(basePath, params.milestoneId);
    writeManifest(basePath);
    appendEvent(basePath, {
      cmd: "reopen-task",
      params: {
        milestoneId: params.milestoneId,
        sliceId: params.sliceId,
        taskId: params.taskId,
        reason: params.reason ?? null,
      },
      ts: new Date().toISOString(),
      actor: "agent",
      actor_name: params.actorName,
      trigger_reason: params.triggerReason,
    });
  } catch (hookErr) {
    logWarning("tool", `reopen-task post-mutation hook warning: ${(hookErr as Error).message}`);
  }

  return {
    milestoneId: params.milestoneId,
    sliceId: params.sliceId,
    taskId: params.taskId,
  };
}
