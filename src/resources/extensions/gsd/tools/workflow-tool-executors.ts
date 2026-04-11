import { ensureDbOpen } from "../bootstrap/dynamic-tools.js";
import { sanitizeCompleteMilestoneParams } from "../bootstrap/sanitize-complete-milestone.js";
import { loadWriteGateSnapshot, shouldBlockContextArtifactSaveInSnapshot } from "../bootstrap/write-gate.js";
import {
  getMilestone,
  getSliceStatusSummary,
  getSliceTaskCounts,
  _getAdapter,
  saveGateResult,
} from "../gsd-db.js";
import { saveArtifactToDb } from "../db-writer.js";
import type { CompleteMilestoneParams } from "./complete-milestone.js";
import { handleCompleteMilestone } from "./complete-milestone.js";
import { handleCompleteTask } from "./complete-task.js";
import type { CompleteSliceParams } from "../types.js";
import { handleCompleteSlice } from "./complete-slice.js";
import type { PlanMilestoneParams } from "./plan-milestone.js";
import { handlePlanMilestone } from "./plan-milestone.js";
import type { PlanSliceParams } from "./plan-slice.js";
import { handlePlanSlice } from "./plan-slice.js";
import type { ReplanSliceParams } from "./replan-slice.js";
import { handleReplanSlice } from "./replan-slice.js";
import type { ReassessRoadmapParams } from "./reassess-roadmap.js";
import { handleReassessRoadmap } from "./reassess-roadmap.js";
import type { ValidateMilestoneParams } from "./validate-milestone.js";
import { handleValidateMilestone } from "./validate-milestone.js";
import { logError, logWarning } from "../workflow-logger.js";
import { invalidateStateCache } from "../state.js";

export const SUPPORTED_SUMMARY_ARTIFACT_TYPES = ["SUMMARY", "RESEARCH", "CONTEXT", "ASSESSMENT", "CONTEXT-DRAFT"] as const;

export function isSupportedSummaryArtifactType(
  artifactType: string,
): artifactType is (typeof SUPPORTED_SUMMARY_ARTIFACT_TYPES)[number] {
  return (SUPPORTED_SUMMARY_ARTIFACT_TYPES as readonly string[]).includes(artifactType);
}

export interface ToolExecutionResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

export interface SummarySaveParams {
  milestone_id: string;
  slice_id?: string;
  task_id?: string;
  artifact_type: string;
  content: string;
}

export async function executeSummarySave(
  params: SummarySaveParams,
  basePath: string = process.cwd(),
): Promise<ToolExecutionResult> {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot save artifact." }],
      details: { operation: "save_summary", error: "db_unavailable" },
    };
  }
  if (!isSupportedSummaryArtifactType(params.artifact_type)) {
    return {
      content: [{ type: "text", text: `Error: Invalid artifact_type "${params.artifact_type}". Must be one of: ${SUPPORTED_SUMMARY_ARTIFACT_TYPES.join(", ")}` }],
      details: { operation: "save_summary", error: "invalid_artifact_type" },
    };
  }
  const contextGuard = shouldBlockContextArtifactSaveInSnapshot(
    loadWriteGateSnapshot(basePath),
    params.artifact_type,
    params.milestone_id ?? null,
    params.slice_id ?? null,
  );
  if (contextGuard.block) {
    return {
      content: [{ type: "text", text: `Error saving artifact: ${contextGuard.reason ?? "context write blocked"}` }],
      details: { operation: "save_summary", error: "context_write_blocked" },
    };
  }
  try {
    let relativePath: string;
    if (params.task_id && params.slice_id) {
      relativePath = `milestones/${params.milestone_id}/slices/${params.slice_id}/tasks/${params.task_id}-${params.artifact_type}.md`;
    } else if (params.slice_id) {
      relativePath = `milestones/${params.milestone_id}/slices/${params.slice_id}/${params.slice_id}-${params.artifact_type}.md`;
    } else {
      relativePath = `milestones/${params.milestone_id}/${params.milestone_id}-${params.artifact_type}.md`;
    }

    await saveArtifactToDb(
      {
        path: relativePath,
        artifact_type: params.artifact_type,
        content: params.content,
        milestone_id: params.milestone_id,
        slice_id: params.slice_id,
        task_id: params.task_id,
      },
      basePath,
    );
    return {
      content: [{ type: "text", text: `Saved ${params.artifact_type} artifact to ${relativePath}` }],
      details: { operation: "save_summary", path: relativePath, artifact_type: params.artifact_type },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `gsd_summary_save tool failed: ${msg}`, { tool: "gsd_summary_save", error: String(err) });
    return {
      content: [{ type: "text", text: `Error saving artifact: ${msg}` }],
      details: { operation: "save_summary", error: msg },
    };
  }
}

type VerificationEvidenceInput =
  | {
      command: string;
      exitCode: number;
      verdict: string;
      durationMs: number;
    }
  | string;

export interface TaskCompleteParams {
  taskId: string;
  sliceId: string;
  milestoneId: string;
  oneLiner: string;
  narrative: string;
  verification: string;
  deviations?: string;
  knownIssues?: string;
  keyFiles?: string[];
  keyDecisions?: string[];
  blockerDiscovered?: boolean;
  verificationEvidence?: VerificationEvidenceInput[];
}

export type CompleteMilestoneExecutorParams = Partial<CompleteMilestoneParams> & Record<string, unknown>;
export type SliceCompleteExecutorParams = CompleteSliceParams;
export type PlanMilestoneExecutorParams = PlanMilestoneParams;
export type PlanSliceExecutorParams = PlanSliceParams;
export type ReplanSliceExecutorParams = ReplanSliceParams;
export type ValidateMilestoneExecutorParams = ValidateMilestoneParams;
export type ReassessRoadmapExecutorParams = ReassessRoadmapParams;

export interface SaveGateResultParams {
  milestoneId: string;
  sliceId: string;
  gateId: string;
  taskId?: string;
  verdict: "pass" | "flag" | "omitted";
  rationale: string;
  findings?: string;
}

export async function executeTaskComplete(
  params: TaskCompleteParams,
  basePath: string = process.cwd(),
): Promise<ToolExecutionResult> {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot complete task." }],
      details: { operation: "complete_task", error: "db_unavailable" },
    };
  }
  try {
    const coerced = { ...params };
    coerced.verificationEvidence = (params.verificationEvidence ?? []).map((v) =>
      typeof v === "string" ? { command: v, exitCode: -1, verdict: "unknown (coerced from string)", durationMs: 0 } : v,
    );

    const result = await handleCompleteTask(coerced as any, basePath);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error completing task: ${result.error}` }],
        details: { operation: "complete_task", error: result.error },
      };
    }
    return {
      content: [{ type: "text", text: `Completed task ${result.taskId} (${result.sliceId}/${result.milestoneId})` }],
      details: {
        operation: "complete_task",
        taskId: result.taskId,
        sliceId: result.sliceId,
        milestoneId: result.milestoneId,
        summaryPath: result.summaryPath,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `complete_task tool failed: ${msg}`, { tool: "gsd_task_complete", error: String(err) });
    return {
      content: [{ type: "text", text: `Error completing task: ${msg}` }],
      details: { operation: "complete_task", error: msg },
    };
  }
}

export async function executeSliceComplete(
  params: SliceCompleteExecutorParams,
  basePath: string = process.cwd(),
): Promise<ToolExecutionResult> {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot complete slice." }],
      details: { operation: "complete_slice", error: "db_unavailable" },
    };
  }
  try {
    const splitPair = (s: string): [string, string] => {
      const m = s.match(/^(.+?)\s*(?:—|-)\s+(.+)$/);
      return m ? [m[1].trim(), m[2].trim()] : [s.trim(), ""];
    };
    const wrapArray = (v: unknown): unknown[] =>
      v == null ? [] : Array.isArray(v) ? v : [v];

    const coerced = { ...params } as CompleteSliceParams & Record<string, unknown>;
    coerced.provides = wrapArray(params.provides) as string[];
    coerced.keyFiles = wrapArray(params.keyFiles) as string[];
    coerced.keyDecisions = wrapArray(params.keyDecisions) as string[];
    coerced.patternsEstablished = wrapArray(params.patternsEstablished) as string[];
    coerced.observabilitySurfaces = wrapArray(params.observabilitySurfaces) as string[];
    coerced.requirementsSurfaced = wrapArray(params.requirementsSurfaced) as string[];
    coerced.drillDownPaths = wrapArray(params.drillDownPaths) as string[];
    coerced.affects = wrapArray(params.affects) as string[];
    coerced.filesModified = wrapArray(params.filesModified).map((f) => {
      if (typeof f !== "string") return f;
      const [path, description] = splitPair(f);
      return { path, description };
    }) as Array<{ path: string; description: string }>;
    coerced.requires = wrapArray(params.requires).map((r) => {
      if (typeof r !== "string") return r;
      const [slice, provides] = splitPair(r);
      return { slice, provides };
    }) as Array<{ slice: string; provides: string }>;
    coerced.requirementsAdvanced = wrapArray(params.requirementsAdvanced).map((r) => {
      if (typeof r !== "string") return r;
      const [id, how] = splitPair(r);
      return { id, how };
    }) as Array<{ id: string; how: string }>;
    coerced.requirementsValidated = wrapArray(params.requirementsValidated).map((r) => {
      if (typeof r !== "string") return r;
      const [id, proof] = splitPair(r);
      return { id, proof };
    }) as Array<{ id: string; proof: string }>;
    coerced.requirementsInvalidated = wrapArray(params.requirementsInvalidated).map((r) => {
      if (typeof r !== "string") return r;
      const [id, what] = splitPair(r);
      return { id, what };
    }) as Array<{ id: string; what: string }>;

    const result = await handleCompleteSlice(coerced as CompleteSliceParams, basePath);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error completing slice: ${result.error}` }],
        details: { operation: "complete_slice", error: result.error },
      };
    }
    return {
      content: [{ type: "text", text: `Completed slice ${result.sliceId} (${result.milestoneId})` }],
      details: {
        operation: "complete_slice",
        sliceId: result.sliceId,
        milestoneId: result.milestoneId,
        summaryPath: result.summaryPath,
        uatPath: result.uatPath,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `complete_slice tool failed: ${msg}`, { tool: "gsd_slice_complete", error: String(err) });
    return {
      content: [{ type: "text", text: `Error completing slice: ${msg}` }],
      details: { operation: "complete_slice", error: msg },
    };
  }
}

export async function executeCompleteMilestone(
  params: CompleteMilestoneExecutorParams,
  basePath: string = process.cwd(),
): Promise<ToolExecutionResult> {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot complete milestone." }],
      details: { operation: "complete_milestone", error: "db_unavailable" },
    };
  }
  try {
    const sanitized = sanitizeCompleteMilestoneParams(params);
    const result = await handleCompleteMilestone(sanitized, basePath);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error completing milestone: ${result.error}` }],
        details: { operation: "complete_milestone", error: result.error },
      };
    }
    return {
      content: [{ type: "text", text: `Completed milestone ${result.milestoneId}. Summary written to ${result.summaryPath}` }],
      details: {
        operation: "complete_milestone",
        milestoneId: result.milestoneId,
        summaryPath: result.summaryPath,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `complete_milestone tool failed: ${msg}`, { tool: "gsd_complete_milestone", error: String(err) });
    return {
      content: [{ type: "text", text: `Error completing milestone: ${msg}` }],
      details: { operation: "complete_milestone", error: msg },
    };
  }
}

export async function executeValidateMilestone(
  params: ValidateMilestoneExecutorParams,
  basePath: string = process.cwd(),
): Promise<ToolExecutionResult> {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot validate milestone." }],
      details: { operation: "validate_milestone", error: "db_unavailable" },
    };
  }
  try {
    const result = await handleValidateMilestone(params, basePath);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error validating milestone: ${result.error}` }],
        details: { operation: "validate_milestone", error: result.error },
      };
    }
    return {
      content: [{ type: "text", text: `Validated milestone ${result.milestoneId} — verdict: ${result.verdict}. Written to ${result.validationPath}` }],
      details: {
        operation: "validate_milestone",
        milestoneId: result.milestoneId,
        verdict: result.verdict,
        validationPath: result.validationPath,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `validate_milestone tool failed: ${msg}`, { tool: "gsd_validate_milestone", error: String(err) });
    return {
      content: [{ type: "text", text: `Error validating milestone: ${msg}` }],
      details: { operation: "validate_milestone", error: msg },
    };
  }
}

export async function executeReassessRoadmap(
  params: ReassessRoadmapExecutorParams,
  basePath: string = process.cwd(),
): Promise<ToolExecutionResult> {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot reassess roadmap." }],
      details: { operation: "reassess_roadmap", error: "db_unavailable" },
    };
  }
  try {
    const result = await handleReassessRoadmap(params, basePath);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error reassessing roadmap: ${result.error}` }],
        details: { operation: "reassess_roadmap", error: result.error },
      };
    }
    return {
      content: [{ type: "text", text: `Reassessed roadmap for milestone ${result.milestoneId} after ${result.completedSliceId}` }],
      details: {
        operation: "reassess_roadmap",
        milestoneId: result.milestoneId,
        completedSliceId: result.completedSliceId,
        assessmentPath: result.assessmentPath,
        roadmapPath: result.roadmapPath,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `reassess_roadmap tool failed: ${msg}`, { tool: "gsd_reassess_roadmap", error: String(err) });
    return {
      content: [{ type: "text", text: `Error reassessing roadmap: ${msg}` }],
      details: { operation: "reassess_roadmap", error: msg },
    };
  }
}

export async function executeSaveGateResult(
  params: SaveGateResultParams,
  basePath: string = process.cwd(),
): Promise<ToolExecutionResult> {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available." }],
      details: { operation: "save_gate_result", error: "db_unavailable" },
    };
  }

  const validGates = ["Q3", "Q4", "Q5", "Q6", "Q7", "Q8"];
  if (!validGates.includes(params.gateId)) {
    return {
      content: [{ type: "text", text: `Error: Invalid gateId "${params.gateId}". Must be one of: ${validGates.join(", ")}` }],
      details: { operation: "save_gate_result", error: "invalid_gate_id" },
    };
  }

  const validVerdicts = ["pass", "flag", "omitted"];
  if (!validVerdicts.includes(params.verdict)) {
    return {
      content: [{ type: "text", text: `Error: Invalid verdict "${params.verdict}". Must be one of: ${validVerdicts.join(", ")}` }],
      details: { operation: "save_gate_result", error: "invalid_verdict" },
    };
  }

  try {
    saveGateResult({
      milestoneId: params.milestoneId,
      sliceId: params.sliceId,
      gateId: params.gateId,
      taskId: params.taskId ?? "",
      verdict: params.verdict,
      rationale: params.rationale,
      findings: params.findings ?? "",
    });
    invalidateStateCache();
    return {
      content: [{ type: "text", text: `Gate ${params.gateId} result saved: verdict=${params.verdict}` }],
      details: { operation: "save_gate_result", gateId: params.gateId, verdict: params.verdict },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `gsd_save_gate_result failed: ${msg}`, { tool: "gsd_save_gate_result", error: String(err) });
    return {
      content: [{ type: "text", text: `Error saving gate result: ${msg}` }],
      details: { operation: "save_gate_result", error: msg },
    };
  }
}

export async function executePlanMilestone(
  params: PlanMilestoneExecutorParams,
  basePath: string = process.cwd(),
): Promise<ToolExecutionResult> {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot plan milestone." }],
      details: { operation: "plan_milestone", error: "db_unavailable" },
    };
  }
  try {
    const result = await handlePlanMilestone(params, basePath);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error planning milestone: ${result.error}` }],
        details: { operation: "plan_milestone", error: result.error },
      };
    }
    return {
      content: [{ type: "text", text: `Planned milestone ${result.milestoneId}` }],
      details: {
        operation: "plan_milestone",
        milestoneId: result.milestoneId,
        roadmapPath: result.roadmapPath,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `plan_milestone tool failed: ${msg}`, { tool: "gsd_plan_milestone", error: String(err) });
    return {
      content: [{ type: "text", text: `Error planning milestone: ${msg}` }],
      details: { operation: "plan_milestone", error: msg },
    };
  }
}

export async function executePlanSlice(
  params: PlanSliceExecutorParams,
  basePath: string = process.cwd(),
): Promise<ToolExecutionResult> {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot plan slice." }],
      details: { operation: "plan_slice", error: "db_unavailable" },
    };
  }
  try {
    const result = await handlePlanSlice(params, basePath);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error planning slice: ${result.error}` }],
        details: { operation: "plan_slice", error: result.error },
      };
    }
    return {
      content: [{ type: "text", text: `Planned slice ${result.sliceId} (${result.milestoneId})` }],
      details: {
        operation: "plan_slice",
        milestoneId: result.milestoneId,
        sliceId: result.sliceId,
        planPath: result.planPath,
        taskPlanPaths: result.taskPlanPaths,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `plan_slice tool failed: ${msg}`, { tool: "gsd_plan_slice", error: String(err) });
    return {
      content: [{ type: "text", text: `Error planning slice: ${msg}` }],
      details: { operation: "plan_slice", error: msg },
    };
  }
}

export async function executeReplanSlice(
  params: ReplanSliceExecutorParams,
  basePath: string = process.cwd(),
): Promise<ToolExecutionResult> {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot replan slice." }],
      details: { operation: "replan_slice", error: "db_unavailable" },
    };
  }
  try {
    const result = await handleReplanSlice(params, basePath);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error replanning slice: ${result.error}` }],
        details: { operation: "replan_slice", error: result.error },
      };
    }
    return {
      content: [{ type: "text", text: `Replanned slice ${result.sliceId} (${result.milestoneId})` }],
      details: {
        operation: "replan_slice",
        milestoneId: result.milestoneId,
        sliceId: result.sliceId,
        replanPath: result.replanPath,
        planPath: result.planPath,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `replan_slice tool failed: ${msg}`, { tool: "gsd_replan_slice", error: String(err) });
    return {
      content: [{ type: "text", text: `Error replanning slice: ${msg}` }],
      details: { operation: "replan_slice", error: msg },
    };
  }
}

export interface MilestoneStatusParams {
  milestoneId: string;
}

export async function executeMilestoneStatus(
  params: MilestoneStatusParams,
  basePath: string = process.cwd(),
): Promise<ToolExecutionResult> {
  try {
    const dbAvailable = await ensureDbOpen(basePath);
    if (!dbAvailable) {
      return {
        content: [{ type: "text", text: "Error: GSD database is not available." }],
        details: { operation: "milestone_status", error: "db_unavailable" },
      };
    }

    const adapter = _getAdapter()!;
    adapter.exec("BEGIN");
    try {
      const milestone = getMilestone(params.milestoneId);
      if (!milestone) {
        adapter.exec("COMMIT");
        return {
          content: [{ type: "text", text: `Milestone ${params.milestoneId} not found in database.` }],
          details: { operation: "milestone_status", milestoneId: params.milestoneId, found: false },
        };
      }

      const sliceStatuses = getSliceStatusSummary(params.milestoneId);
      const slices = sliceStatuses.map((s) => ({
        id: s.id,
        status: s.status,
        taskCounts: getSliceTaskCounts(params.milestoneId, s.id),
      }));

      adapter.exec("COMMIT");

      const result = {
        milestoneId: milestone.id,
        title: milestone.title,
        status: milestone.status,
        createdAt: milestone.created_at,
        completedAt: milestone.completed_at,
        sliceCount: slices.length,
        slices,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { operation: "milestone_status", milestoneId: milestone.id, sliceCount: slices.length },
      };
    } catch (txErr) {
      try { adapter.exec("ROLLBACK"); } catch { /* swallow */ }
      throw txErr;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarning("tool", `gsd_milestone_status tool failed: ${msg}`);
    return {
      content: [{ type: "text", text: `Error querying milestone status: ${msg}` }],
      details: { operation: "milestone_status", error: msg },
    };
  }
}
