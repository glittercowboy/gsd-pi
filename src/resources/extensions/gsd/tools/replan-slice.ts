import { clearParseCache } from "../files.js";
import {
  transaction,
  getSlice,
  getSliceTasks,
  getTask,
  insertTask,
  upsertTaskPlanning,
  insertReplanHistory,
  deleteTask,
} from "../gsd-db.js";
import { invalidateStateCache } from "../state.js";
import { renderPlanFromDb, renderReplanFromDb } from "../markdown-renderer.js";
import { renderAllProjections } from "../workflow-projections.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";

export interface ReplanSliceTaskInput {
  taskId: string;
  title: string;
  description: string;
  estimate: string;
  files: string[];
  verify: string;
  inputs: string[];
  expectedOutput: string[];
  fullPlanMd?: string;
}

export interface ReplanSliceParams {
  milestoneId: string;
  sliceId: string;
  blockerTaskId: string;
  blockerDescription: string;
  whatChanged: string;
  updatedTasks: ReplanSliceTaskInput[];
  removedTaskIds: string[];
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
}

export interface ReplanSliceResult {
  milestoneId: string;
  sliceId: string;
  replanPath: string;
  planPath: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateParams(params: ReplanSliceParams): ReplanSliceParams {
  if (!isNonEmptyString(params?.milestoneId)) throw new Error("milestoneId is required");
  if (!isNonEmptyString(params?.sliceId)) throw new Error("sliceId is required");
  if (!isNonEmptyString(params?.blockerTaskId)) throw new Error("blockerTaskId is required");
  if (!isNonEmptyString(params?.blockerDescription)) throw new Error("blockerDescription is required");
  if (!isNonEmptyString(params?.whatChanged)) throw new Error("whatChanged is required");

  if (!Array.isArray(params.updatedTasks)) {
    throw new Error("updatedTasks must be an array");
  }

  if (!Array.isArray(params.removedTaskIds)) {
    throw new Error("removedTaskIds must be an array");
  }

  // Validate each updated task
  for (let i = 0; i < params.updatedTasks.length; i++) {
    const t = params.updatedTasks[i];
    if (!t || typeof t !== "object") throw new Error(`updatedTasks[${i}] must be an object`);
    if (!isNonEmptyString(t.taskId)) throw new Error(`updatedTasks[${i}].taskId is required`);
    if (!isNonEmptyString(t.title)) throw new Error(`updatedTasks[${i}].title is required`);
  }

  return params;
}

export async function handleReplanSlice(
  rawParams: ReplanSliceParams,
  basePath: string,
): Promise<ReplanSliceResult | { error: string }> {
  // ── Validate ──────────────────────────────────────────────────────
  let params: ReplanSliceParams;
  try {
    params = validateParams(rawParams);
  } catch (err) {
    return { error: `validation failed: ${(err as Error).message}` };
  }

  // ── Verify parent slice exists and is not closed ─────────────────
  const parentSlice = getSlice(params.milestoneId, params.sliceId);
  if (!parentSlice) {
    return { error: `missing parent slice: ${params.milestoneId}/${params.sliceId}` };
  }
  if (parentSlice.status === "complete" || parentSlice.status === "done") {
    return { error: `cannot replan a closed slice: ${params.sliceId} (status: ${parentSlice.status})` };
  }

  // ── Verify blocker task exists and is complete ────────────────────
  const blockerTask = getTask(params.milestoneId, params.sliceId, params.blockerTaskId);
  if (!blockerTask) {
    return { error: `blockerTaskId not found: ${params.milestoneId}/${params.sliceId}/${params.blockerTaskId}` };
  }
  if (blockerTask.status !== "complete" && blockerTask.status !== "done") {
    return { error: `blockerTaskId ${params.blockerTaskId} is not complete (status: ${blockerTask.status}) — the blocker task must be finished before a replan is triggered` };
  }

  // ── Structural enforcement ────────────────────────────────────────
  const existingTasks = getSliceTasks(params.milestoneId, params.sliceId);
  const completedTaskIds = new Set<string>();
  for (const task of existingTasks) {
    if (task.status === "complete" || task.status === "done") {
      completedTaskIds.add(task.id);
    }
  }

  // Reject updates to completed tasks
  for (const updatedTask of params.updatedTasks) {
    if (completedTaskIds.has(updatedTask.taskId)) {
      return { error: `cannot modify completed task ${updatedTask.taskId}` };
    }
  }

  // Reject removal of completed tasks
  for (const removedId of params.removedTaskIds) {
    if (completedTaskIds.has(removedId)) {
      return { error: `cannot remove completed task ${removedId}` };
    }
  }

  // ── Transaction: DB mutations ─────────────────────────────────────
  const existingTaskIds = new Set(existingTasks.map((t) => t.id));

  try {
    transaction(() => {
      // Record replan history
      insertReplanHistory({
        milestoneId: params.milestoneId,
        sliceId: params.sliceId,
        taskId: params.blockerTaskId,
        summary: params.whatChanged,
      });

      // Apply task updates (upsert existing, insert new)
      for (const updatedTask of params.updatedTasks) {
        if (existingTaskIds.has(updatedTask.taskId)) {
          // Update existing task's planning fields
          upsertTaskPlanning(params.milestoneId, params.sliceId, updatedTask.taskId, {
            title: updatedTask.title,
            description: updatedTask.description || "",
            estimate: updatedTask.estimate || "",
            files: updatedTask.files || [],
            verify: updatedTask.verify || "",
            inputs: updatedTask.inputs || [],
            expectedOutput: updatedTask.expectedOutput || [],
            fullPlanMd: updatedTask.fullPlanMd,
          });
        } else {
          // Insert new task then set planning fields
          insertTask({
            id: updatedTask.taskId,
            sliceId: params.sliceId,
            milestoneId: params.milestoneId,
            title: updatedTask.title,
            status: "pending",
          });
          upsertTaskPlanning(params.milestoneId, params.sliceId, updatedTask.taskId, {
            title: updatedTask.title,
            description: updatedTask.description || "",
            estimate: updatedTask.estimate || "",
            files: updatedTask.files || [],
            verify: updatedTask.verify || "",
            inputs: updatedTask.inputs || [],
            expectedOutput: updatedTask.expectedOutput || [],
            fullPlanMd: updatedTask.fullPlanMd,
          });
        }
      }

      // Delete removed tasks
      for (const removedId of params.removedTaskIds) {
        deleteTask(params.milestoneId, params.sliceId, removedId);
      }
    });
  } catch (err) {
    return { error: `db write failed: ${(err as Error).message}` };
  }

  // ── Render artifacts ──────────────────────────────────────────────
  try {
    const renderResult = await renderPlanFromDb(basePath, params.milestoneId, params.sliceId);
    const replanResult = await renderReplanFromDb(basePath, params.milestoneId, params.sliceId, {
      blockerTaskId: params.blockerTaskId,
      blockerDescription: params.blockerDescription,
      whatChanged: params.whatChanged,
    });

    // ── Invalidate caches ─────────────────────────────────────────
    invalidateStateCache();
    clearParseCache();

    // ── Post-mutation hook: projections, manifest, event log ─────
    try {
      await renderAllProjections(basePath, params.milestoneId);
      writeManifest(basePath);
      appendEvent(basePath, {
        cmd: "replan-slice",
        params: { milestoneId: params.milestoneId, sliceId: params.sliceId, blockerTaskId: params.blockerTaskId },
        ts: new Date().toISOString(),
        actor: "agent",
        actor_name: params.actorName,
        trigger_reason: params.triggerReason,
      });
    } catch (hookErr) {
      process.stderr.write(
        `gsd: replan-slice post-mutation hook warning: ${(hookErr as Error).message}\n`,
      );
    }

    return {
      milestoneId: params.milestoneId,
      sliceId: params.sliceId,
      replanPath: replanResult.replanPath,
      planPath: renderResult.planPath,
    };
  } catch (err) {
    return { error: `render failed: ${(err as Error).message}` };
  }
}
