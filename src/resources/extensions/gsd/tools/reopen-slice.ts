/**
 * reopen-slice handler — the core operation behind gsd_slice_reopen.
 *
 * Resets a completed slice back to "in_progress" and resets ALL of its
 * tasks back to "pending". This is intentional — if you're reopening a
 * slice, you're re-doing the work. Partial resets create ambiguous state.
 *
 * The parent milestone must still be open (not complete).
 */

// GSD — reopen-slice tool handler
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import {
  getMilestone,
  getSlice,
  getSliceTasks,
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

export interface ReopenSliceParams {
  milestoneId: string;
  sliceId: string;
  reason?: string;
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
}

export interface ReopenSliceResult {
  milestoneId: string;
  sliceId: string;
  tasksReset: number;
}

export async function handleReopenSlice(
  params: ReopenSliceParams,
  basePath: string,
): Promise<ReopenSliceResult | { error: string }> {
  // ── Validate required fields ────────────────────────────────────────────
  if (!params.sliceId || typeof params.sliceId !== "string" || params.sliceId.trim() === "") {
    return { error: "sliceId is required and must be a non-empty string" };
  }
  if (!params.milestoneId || typeof params.milestoneId !== "string" || params.milestoneId.trim() === "") {
    return { error: "milestoneId is required and must be a non-empty string" };
  }

  // ── Guards + DB writes inside a single transaction (prevents TOCTOU) ───
  let guardError: string | null = null;
  let tasksResetCount = 0;

  transaction(() => {
    const milestone = getMilestone(params.milestoneId);
    if (!milestone) {
      guardError = `milestone not found: ${params.milestoneId}`;
      return;
    }
    if (isClosedStatus(milestone.status)) {
      guardError = `cannot reopen slice in a closed milestone: ${params.milestoneId} (status: ${milestone.status})`;
      return;
    }

    const slice = getSlice(params.milestoneId, params.sliceId);
    if (!slice) {
      guardError = `slice not found: ${params.milestoneId}/${params.sliceId}`;
      return;
    }
    if (!isClosedStatus(slice.status)) {
      guardError = `slice ${params.sliceId} is not complete (status: ${slice.status}) — nothing to reopen`;
      return;
    }

    // Fetch tasks inside txn so the list is consistent with the slice status check
    const tasks = getSliceTasks(params.milestoneId, params.sliceId);
    tasksResetCount = tasks.length;

    updateSliceStatus(params.milestoneId, params.sliceId, "in_progress");
    for (const task of tasks) {
      updateTaskStatus(params.milestoneId, params.sliceId, task.id, "pending");
    }
  });

  if (guardError) {
    return { error: guardError };
  }

  // ── Invalidate caches ────────────────────────────────────────────────────
  invalidateStateCache();

  // ── Post-mutation hook ───────────────────────────────────────────────────
  try {
    await renderAllProjections(basePath, params.milestoneId);
    writeManifest(basePath);
    appendEvent(basePath, {
      cmd: "reopen-slice",
      params: {
        milestoneId: params.milestoneId,
        sliceId: params.sliceId,
        reason: params.reason ?? null,
        tasksReset: tasksResetCount,
      },
      ts: new Date().toISOString(),
      actor: "agent",
      actor_name: params.actorName,
      trigger_reason: params.triggerReason,
    });
  } catch (hookErr) {
    logWarning("tool", `reopen-slice post-mutation hook warning: ${(hookErr as Error).message}`);
  }

  return {
    milestoneId: params.milestoneId,
    sliceId: params.sliceId,
    tasksReset: tasksResetCount,
  };
}
