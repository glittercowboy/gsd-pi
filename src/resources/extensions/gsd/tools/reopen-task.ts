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
} from "../gsd-db.js";
import { invalidateStateCache } from "../state.js";
import { renderAllProjections } from "../workflow-projections.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";

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

  // ── State machine preconditions ─────────────────────────────────────────
  const milestone = getMilestone(params.milestoneId);
  if (!milestone) {
    return { error: `milestone not found: ${params.milestoneId}` };
  }
  if (milestone.status === "complete" || milestone.status === "done") {
    return { error: `cannot reopen task in a closed milestone: ${params.milestoneId} (status: ${milestone.status})` };
  }

  const slice = getSlice(params.milestoneId, params.sliceId);
  if (!slice) {
    return { error: `slice not found: ${params.milestoneId}/${params.sliceId}` };
  }
  if (slice.status === "complete" || slice.status === "done") {
    return { error: `cannot reopen task inside a closed slice: ${params.sliceId} (status: ${slice.status}) — use gsd_slice_reopen first` };
  }

  const task = getTask(params.milestoneId, params.sliceId, params.taskId);
  if (!task) {
    return { error: `task not found: ${params.milestoneId}/${params.sliceId}/${params.taskId}` };
  }
  if (task.status !== "complete" && task.status !== "done") {
    return { error: `task ${params.taskId} is not complete (status: ${task.status}) — nothing to reopen` };
  }

  // ── Reset task status ────────────────────────────────────────────────────
  updateTaskStatus(params.milestoneId, params.sliceId, params.taskId, "pending");

  // ── Invalidate caches ────────────────────────────────────────────────────
  invalidateStateCache();

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
    process.stderr.write(
      `gsd: reopen-task post-mutation hook warning: ${(hookErr as Error).message}\n`,
    );
  }

  return {
    milestoneId: params.milestoneId,
    sliceId: params.sliceId,
    taskId: params.taskId,
  };
}
