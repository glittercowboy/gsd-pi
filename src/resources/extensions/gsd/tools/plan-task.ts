import { clearParseCache } from "../files.js";
import { isClosedStatus } from "../status-guards.js";
import { isNonEmptyString, validateStringArray } from "../validation.js";
import { transaction, getSlice, getTask, insertTask, upsertTaskPlanning } from "../gsd-db.js";
import { invalidateStateCache } from "../state.js";
import { renderTaskPlanFromDb } from "../markdown-renderer.js";
import { renderAllProjections } from "../workflow-projections.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning } from "../workflow-logger.js";

export interface PlanTaskParams {
  milestoneId: string;
  sliceId: string;
  taskId: string;
  title: string;
  description: string;
  estimate: string;
  files: string[];
  verify: string;
  inputs: string[];
  expectedOutput: string[];
  observabilityImpact?: string;
  fullPlanMd?: string;
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
}

export interface PlanTaskResult {
  milestoneId: string;
  sliceId: string;
  taskId: string;
  taskPlanPath: string;
}

function validateParams(params: PlanTaskParams): PlanTaskParams {
  if (!isNonEmptyString(params?.milestoneId)) throw new Error("milestoneId is required");
  if (!isNonEmptyString(params?.sliceId)) throw new Error("sliceId is required");
  if (!isNonEmptyString(params?.taskId)) throw new Error("taskId is required");
  if (!isNonEmptyString(params?.title)) throw new Error("title is required");
  if (!isNonEmptyString(params?.description)) throw new Error("description is required");
  if (!isNonEmptyString(params?.estimate)) throw new Error("estimate is required");
  if (!isNonEmptyString(params?.verify)) throw new Error("verify is required");
  if (params.observabilityImpact !== undefined && !isNonEmptyString(params.observabilityImpact)) {
    throw new Error("observabilityImpact must be a non-empty string when provided");
  }

  return {
    ...params,
    files: validateStringArray(params.files, "files"),
    inputs: validateStringArray(params.inputs, "inputs"),
    expectedOutput: validateStringArray(params.expectedOutput, "expectedOutput"),
  };
}

export async function handlePlanTask(
  rawParams: PlanTaskParams,
  basePath: string,
): Promise<PlanTaskResult | { error: string }> {
  let params: PlanTaskParams;
  try {
    params = validateParams(rawParams);
  } catch (err) {
    return { error: `validation failed: ${(err as Error).message}` };
  }

  // ── Guards + DB writes inside a single transaction (prevents TOCTOU) ───
  // Guards must be inside the transaction so the state they check cannot
  // change between the read and the write (#2723).
  let guardError: string | null = null;

  try {
    transaction(() => {
      const parentSlice = getSlice(params.milestoneId, params.sliceId);
      if (!parentSlice) {
        guardError = `missing parent slice: ${params.milestoneId}/${params.sliceId}`;
        return;
      }
      if (isClosedStatus(parentSlice.status)) {
        guardError = `cannot plan task in a closed slice: ${params.sliceId} (status: ${parentSlice.status})`;
        return;
      }

      const existingTask = getTask(params.milestoneId, params.sliceId, params.taskId);
      if (existingTask && isClosedStatus(existingTask.status)) {
        guardError = `cannot re-plan task ${params.taskId}: it is already complete — use gsd_task_reopen first`;
        return;
      }

      if (!existingTask) {
        insertTask({
          id: params.taskId,
          sliceId: params.sliceId,
          milestoneId: params.milestoneId,
          title: params.title,
          status: "pending",
        });
      }
      upsertTaskPlanning(params.milestoneId, params.sliceId, params.taskId, {
        title: params.title,
        description: params.description,
        estimate: params.estimate,
        files: params.files,
        verify: params.verify,
        inputs: params.inputs,
        expectedOutput: params.expectedOutput,
        observabilityImpact: params.observabilityImpact ?? "",
        fullPlanMd: params.fullPlanMd,
      });
    });
  } catch (err) {
    return { error: `db write failed: ${(err as Error).message}` };
  }

  if (guardError) {
    return { error: guardError };
  }

  try {
    const renderResult = await renderTaskPlanFromDb(basePath, params.milestoneId, params.sliceId, params.taskId);
    invalidateStateCache();
    clearParseCache();

    // ── Post-mutation hook: projections, manifest, event log ─────────────
    try {
      await renderAllProjections(basePath, params.milestoneId);
      writeManifest(basePath);
      appendEvent(basePath, {
        cmd: "plan-task",
        params: { milestoneId: params.milestoneId, sliceId: params.sliceId, taskId: params.taskId },
        ts: new Date().toISOString(),
        actor: "agent",
        actor_name: params.actorName,
        trigger_reason: params.triggerReason,
      });
    } catch (hookErr) {
      logWarning("tool", `plan-task post-mutation hook warning: ${(hookErr as Error).message}`);
    }

    return {
      milestoneId: params.milestoneId,
      sliceId: params.sliceId,
      taskId: params.taskId,
      taskPlanPath: renderResult.taskPlanPath,
    };
  } catch (err) {
    return { error: `render failed: ${(err as Error).message}` };
  }
}
