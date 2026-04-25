import { clearParseCache } from "../files.js";
import { isClosedStatus, isDeferredStatus } from "../status-guards.js";
import { isNonEmptyString, validateStringArray } from "../validation.js";
import {
  transaction,
  getMilestone,
  getSlice,
  insertTask,
  upsertSlicePlanning,
  upsertTaskPlanning,
  insertGateRow,
  updateSliceStatus,
} from "../gsd-db.js";
import type { GateId } from "../types.js";
import { invalidateStateCache } from "../state.js";
import { renderPlanFromDb } from "../markdown-renderer.js";
import { renderAllProjections } from "../workflow-projections.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning } from "../workflow-logger.js";

export interface PlanSliceTaskInput {
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
}

export interface PlanSliceParams {
  milestoneId: string;
  sliceId: string;
  goal: string;
  tasks: PlanSliceTaskInput[];
  /** @optional — defaults to "Not provided." when omitted by models with limited tool-calling */
  successCriteria?: string;
  /** @optional — defaults to "Not provided." when omitted */
  proofLevel?: string;
  /** @optional — defaults to "Not provided." when omitted */
  integrationClosure?: string;
  /** @optional — defaults to "Not provided." when omitted */
  observabilityImpact?: string;
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
}

export interface PlanSliceResult {
  milestoneId: string;
  sliceId: string;
  planPath: string;
  taskPlanPaths: string[];
}

function validateTasks(value: unknown): PlanSliceTaskInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("tasks must be a non-empty array");
  }

  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`tasks[${index}] must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    const taskId = obj.taskId;
    const title = obj.title;
    const description = obj.description;
    const estimate = obj.estimate;
    const files = obj.files;
    const verify = obj.verify;
    const inputs = obj.inputs;
    const expectedOutput = obj.expectedOutput;
    const observabilityImpact = obj.observabilityImpact;

    if (!isNonEmptyString(taskId)) throw new Error(`tasks[${index}].taskId must be a non-empty string`);
    if (seen.has(taskId)) throw new Error(`tasks[${index}].taskId must be unique`);
    seen.add(taskId);
    if (!isNonEmptyString(title)) throw new Error(`tasks[${index}].title must be a non-empty string`);
    if (!isNonEmptyString(description)) throw new Error(`tasks[${index}].description must be a non-empty string`);
    if (!isNonEmptyString(estimate)) throw new Error(`tasks[${index}].estimate must be a non-empty string`);
    if (!Array.isArray(files) || files.some((item) => !isNonEmptyString(item))) {
      throw new Error(`tasks[${index}].files must be an array of non-empty strings`);
    }
    if (!isNonEmptyString(verify)) throw new Error(`tasks[${index}].verify must be a non-empty string`);
    if (!Array.isArray(inputs) || inputs.some((item) => !isNonEmptyString(item))) {
      throw new Error(`tasks[${index}].inputs must be an array of non-empty strings`);
    }
    if (!Array.isArray(expectedOutput) || expectedOutput.some((item) => !isNonEmptyString(item))) {
      throw new Error(`tasks[${index}].expectedOutput must be an array of non-empty strings`);
    }
    if (observabilityImpact !== undefined && !isNonEmptyString(observabilityImpact)) {
      throw new Error(`tasks[${index}].observabilityImpact must be a non-empty string when provided`);
    }

    return {
      taskId,
      title,
      description,
      estimate,
      files,
      verify,
      inputs,
      expectedOutput,
      observabilityImpact: typeof observabilityImpact === "string" ? observabilityImpact : "",
    };
  });
}

function validateParams(params: PlanSliceParams): PlanSliceParams {
  if (!isNonEmptyString(params?.milestoneId)) throw new Error("milestoneId is required");
  if (!isNonEmptyString(params?.sliceId)) throw new Error("sliceId is required");
  if (!isNonEmptyString(params?.goal)) throw new Error("goal is required");

  return {
    ...params,
    // Apply defaults for optional enrichment fields (#2771)
    successCriteria: params.successCriteria ?? "Not provided.",
    proofLevel: params.proofLevel ?? "Not provided.",
    integrationClosure: params.integrationClosure ?? "Not provided.",
    observabilityImpact: params.observabilityImpact ?? "Not provided.",
    tasks: validateTasks(params.tasks),
  };
}

export async function handlePlanSlice(
  rawParams: PlanSliceParams,
  basePath: string,
): Promise<PlanSliceResult | { error: string }> {
  let params: PlanSliceParams;
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
      const parentMilestone = getMilestone(params.milestoneId);
      if (!parentMilestone) {
        guardError = `milestone not found: ${params.milestoneId}`;
        return;
      }
      if (isClosedStatus(parentMilestone.status)) {
        guardError = `cannot plan slice in a closed milestone: ${params.milestoneId} (status: ${parentMilestone.status})`;
        return;
      }

      const parentSlice = getSlice(params.milestoneId, params.sliceId);
      if (!parentSlice) {
        guardError = `missing parent slice: ${params.milestoneId}/${params.sliceId}`;
        return;
      }
      if (isClosedStatus(parentSlice.status)) {
        guardError = `cannot re-plan slice ${params.sliceId}: it is already complete — use gsd_slice_reopen first`;
        return;
      }

      if (isDeferredStatus(parentSlice.status)) {
        updateSliceStatus(params.milestoneId, params.sliceId, "pending");
      }

      upsertSlicePlanning(params.milestoneId, params.sliceId, {
        goal: params.goal,
        successCriteria: params.successCriteria,
        proofLevel: params.proofLevel,
        integrationClosure: params.integrationClosure,
        observabilityImpact: params.observabilityImpact,
      });

      for (const task of params.tasks) {
        insertTask({
          id: task.taskId,
          sliceId: params.sliceId,
          milestoneId: params.milestoneId,
          title: task.title,
          status: "pending",
        });
        upsertTaskPlanning(params.milestoneId, params.sliceId, task.taskId, {
          title: task.title,
          description: task.description,
          estimate: task.estimate,
          files: task.files,
          verify: task.verify,
          inputs: task.inputs,
          expectedOutput: task.expectedOutput,
          observabilityImpact: task.observabilityImpact ?? "",
          fullPlanMd: task.fullPlanMd,
        });
      }

      // Seed quality gate rows inside the transaction — all-or-nothing with
      // the plan data so a crash can't leave orphaned gates without tasks.
      const sliceGates: GateId[] = ["Q3", "Q4"];
      for (const gid of sliceGates) {
        insertGateRow({ milestoneId: params.milestoneId, sliceId: params.sliceId, gateId: gid, scope: "slice" });
      }
      const taskGates: GateId[] = ["Q5", "Q6", "Q7"];
      for (const task of params.tasks) {
        for (const gid of taskGates) {
          insertGateRow({ milestoneId: params.milestoneId, sliceId: params.sliceId, gateId: gid, scope: "task", taskId: task.taskId });
        }
      }
      insertGateRow({ milestoneId: params.milestoneId, sliceId: params.sliceId, gateId: "Q8", scope: "slice" });
    });
  } catch (err) {
    return { error: `db write failed: ${(err as Error).message}` };
  }

  if (guardError) {
    return { error: guardError };
  }

  try {
    const renderResult = await renderPlanFromDb(basePath, params.milestoneId, params.sliceId);
    invalidateStateCache();
    clearParseCache();

    // ── Post-mutation hook: projections, manifest, event log ─────────────
    try {
      await renderAllProjections(basePath, params.milestoneId);
      writeManifest(basePath);
      appendEvent(basePath, {
        cmd: "plan-slice",
        params: { milestoneId: params.milestoneId, sliceId: params.sliceId },
        ts: new Date().toISOString(),
        actor: "agent",
        actor_name: params.actorName,
        trigger_reason: params.triggerReason,
      });
    } catch (hookErr) {
      logWarning("tool", `plan-slice post-mutation hook warning: ${(hookErr as Error).message}`);
    }

    return {
      milestoneId: params.milestoneId,
      sliceId: params.sliceId,
      planPath: renderResult.planPath,
      taskPlanPaths: renderResult.taskPlanPaths,
    };
  } catch (renderErr) {
    logWarning("tool", `plan_slice — render failed (DB rows preserved for debugging): ${(renderErr as Error).message}`);
    invalidateStateCache();
    return { error: `render failed: ${(renderErr as Error).message}` };
  }
}
