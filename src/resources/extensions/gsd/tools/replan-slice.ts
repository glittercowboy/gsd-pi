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

  // ── Guards + DB writes inside a single transaction (prevents TOCTOU) ───
  // Guards must be inside the transaction so the state they check cannot
  // change between the read and the write (#2723).
  let guardError: string | null = null;
  let existingTaskIds: Set<string> = new Set();

  try {
    transaction(() => {
      // Verify parent slice exists and is not closed
      const parentSlice = getSlice(params.milestoneId, params.sliceId);
      if (!parentSlice) {
        guardError = `missing parent slice: ${params.milestoneId}/${params.sliceId}`;
        return;
      }
      if (parentSlice.status === "complete" || parentSlice.status === "done") {
        guardError = `cannot replan a closed slice: ${params.sliceId} (status: ${parentSlice.status})`;
        return;
      }

      // Verify blocker task exists and is complete
      const blockerTask = getTask(params.milestoneId, params.sliceId, params.blockerTaskId);
      if (!blockerTask) {
        guardError = `blockerTaskId not found: ${params.milestoneId}/${params.sliceId}/${params.blockerTaskId}`;
        return;
      }
      if (blockerTask.status !== "complete" && blockerTask.status !== "done") {
        guardError = `blockerTaskId ${params.blockerTaskId} is not complete (status: ${blockerTask.status}) — the blocker task must be finished before a replan is triggered`;
        return;
      }

      // Structural enforcement — reject modifications/removal of completed tasks
      const existingTasks = getSliceTasks(params.milestoneId, params.sliceId);
      const completedTaskIds = new Set<string>();
      for (const task of existingTasks) {
        if (task.status === "complete" || task.status === "done") {
          completedTaskIds.add(task.id);
        }
      }

      for (const updatedTask of params.updatedTasks) {
        if (completedTaskIds.has(updatedTask.taskId)) {
          guardError = `cannot modify completed task ${updatedTask.taskId}`;
          return;
        }
      }

      for (const removedId of params.removedTaskIds) {
        if (completedTaskIds.has(removedId)) {
          guardError = `cannot remove completed task ${removedId}`;
          return;
        }
      }

      existingTaskIds = new Set(existingTasks.map((t) => t.id));

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

  if (guardError) {
    return { error: guardError };
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
