import { clearParseCache } from "../files.js";
import {
  transaction,
  getMilestone,
  insertMilestone,
  insertSlice,
  upsertMilestonePlanning,
  upsertSlicePlanning,
  _getAdapter,
} from "../gsd-db.js";
import { invalidateStateCache } from "../state.js";
import { renderRoadmapFromDb } from "../markdown-renderer.js";
import { renderAllProjections } from "../workflow-projections.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";

export interface PlanMilestoneSliceInput {
  sliceId: string;
  title: string;
  risk: string;
  depends: string[];
  demo: string;
  goal: string;
  successCriteria: string;
  proofLevel: string;
  integrationClosure: string;
  observabilityImpact: string;
}

export interface PlanMilestoneParams {
  milestoneId: string;
  title: string;
  status?: string;
  dependsOn?: string[];
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
  vision: string;
  successCriteria: string[];
  keyRisks: Array<{ risk: string; whyItMatters: string }>;
  proofStrategy: Array<{ riskOrUnknown: string; retireIn: string; whatWillBeProven: string }>;
  verificationContract: string;
  verificationIntegration: string;
  verificationOperational: string;
  verificationUat: string;
  definitionOfDone: string[];
  requirementCoverage: string;
  boundaryMapMarkdown: string;
  slices: PlanMilestoneSliceInput[];
}

export interface PlanMilestoneResult {
  milestoneId: string;
  roadmapPath: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  if (value.some((item) => !isNonEmptyString(item))) {
    throw new Error(`${field} must contain only non-empty strings`);
  }
  return value;
}

function validateRiskEntries(value: unknown): Array<{ risk: string; whyItMatters: string }> {
  if (!Array.isArray(value)) {
    throw new Error("keyRisks must be an array");
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`keyRisks[${index}] must be an object`);
    }
    const risk = (entry as Record<string, unknown>).risk;
    const whyItMatters = (entry as Record<string, unknown>).whyItMatters;
    if (!isNonEmptyString(risk) || !isNonEmptyString(whyItMatters)) {
      throw new Error(`keyRisks[${index}] must include non-empty risk and whyItMatters`);
    }
    return { risk, whyItMatters };
  });
}

function validateProofStrategy(value: unknown): Array<{ riskOrUnknown: string; retireIn: string; whatWillBeProven: string }> {
  if (!Array.isArray(value)) {
    throw new Error("proofStrategy must be an array");
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`proofStrategy[${index}] must be an object`);
    }
    const riskOrUnknown = (entry as Record<string, unknown>).riskOrUnknown;
    const retireIn = (entry as Record<string, unknown>).retireIn;
    const whatWillBeProven = (entry as Record<string, unknown>).whatWillBeProven;
    if (!isNonEmptyString(riskOrUnknown) || !isNonEmptyString(retireIn) || !isNonEmptyString(whatWillBeProven)) {
      throw new Error(`proofStrategy[${index}] must include non-empty riskOrUnknown, retireIn, and whatWillBeProven`);
    }
    return { riskOrUnknown, retireIn, whatWillBeProven };
  });
}

function validateSlices(value: unknown): PlanMilestoneSliceInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("slices must be a non-empty array");
  }

  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`slices[${index}] must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    const sliceId = obj.sliceId;
    const title = obj.title;
    const risk = obj.risk;
    const depends = obj.depends;
    const demo = obj.demo;
    const goal = obj.goal;
    const successCriteria = obj.successCriteria;
    const proofLevel = obj.proofLevel;
    const integrationClosure = obj.integrationClosure;
    const observabilityImpact = obj.observabilityImpact;

    if (!isNonEmptyString(sliceId)) throw new Error(`slices[${index}].sliceId must be a non-empty string`);
    if (seen.has(sliceId)) throw new Error(`slices[${index}].sliceId must be unique`);
    seen.add(sliceId);
    if (!isNonEmptyString(title)) throw new Error(`slices[${index}].title must be a non-empty string`);
    if (!isNonEmptyString(risk)) throw new Error(`slices[${index}].risk must be a non-empty string`);
    if (!Array.isArray(depends) || depends.some((item) => !isNonEmptyString(item))) {
      throw new Error(`slices[${index}].depends must be an array of non-empty strings`);
    }
    if (!isNonEmptyString(demo)) throw new Error(`slices[${index}].demo must be a non-empty string`);
    if (!isNonEmptyString(goal)) throw new Error(`slices[${index}].goal must be a non-empty string`);
    if (!isNonEmptyString(successCriteria)) throw new Error(`slices[${index}].successCriteria must be a non-empty string`);
    if (!isNonEmptyString(proofLevel)) throw new Error(`slices[${index}].proofLevel must be a non-empty string`);
    if (!isNonEmptyString(integrationClosure)) throw new Error(`slices[${index}].integrationClosure must be a non-empty string`);
    if (!isNonEmptyString(observabilityImpact)) throw new Error(`slices[${index}].observabilityImpact must be a non-empty string`);

    return {
      sliceId,
      title,
      risk,
      depends,
      demo,
      goal,
      successCriteria,
      proofLevel,
      integrationClosure,
      observabilityImpact,
    };
  });
}

function validateParams(params: PlanMilestoneParams): PlanMilestoneParams {
  if (!isNonEmptyString(params?.milestoneId)) throw new Error("milestoneId is required");
  if (!isNonEmptyString(params?.title)) throw new Error("title is required");
  if (!isNonEmptyString(params?.vision)) throw new Error("vision is required");
  if (!isNonEmptyString(params?.verificationContract)) throw new Error("verificationContract is required");
  if (!isNonEmptyString(params?.verificationIntegration)) throw new Error("verificationIntegration is required");
  if (!isNonEmptyString(params?.verificationOperational)) throw new Error("verificationOperational is required");
  if (!isNonEmptyString(params?.verificationUat)) throw new Error("verificationUat is required");
  if (!isNonEmptyString(params?.requirementCoverage)) throw new Error("requirementCoverage is required");
  if (!isNonEmptyString(params?.boundaryMapMarkdown)) throw new Error("boundaryMapMarkdown is required");

  return {
    ...params,
    dependsOn: params.dependsOn ? validateStringArray(params.dependsOn, "dependsOn") : [],
    successCriteria: validateStringArray(params.successCriteria, "successCriteria"),
    keyRisks: validateRiskEntries(params.keyRisks),
    proofStrategy: validateProofStrategy(params.proofStrategy),
    definitionOfDone: validateStringArray(params.definitionOfDone, "definitionOfDone"),
    slices: validateSlices(params.slices),
  };
}

export async function handlePlanMilestone(
  rawParams: PlanMilestoneParams,
  basePath: string,
): Promise<PlanMilestoneResult | { error: string }> {
  let params: PlanMilestoneParams;
  try {
    params = validateParams(rawParams);
  } catch (err) {
    return { error: `validation failed: ${(err as Error).message}` };
  }

  // ── State machine preconditions ─────────────────────────────────────────
  const existingMilestone = getMilestone(params.milestoneId);
  if (existingMilestone && (existingMilestone.status === "complete" || existingMilestone.status === "done")) {
    return { error: `cannot re-plan milestone ${params.milestoneId}: it is already complete` };
  }

  // Validate depends_on: all dependencies must exist and be complete
  if (params.dependsOn && params.dependsOn.length > 0) {
    for (const depId of params.dependsOn) {
      const dep = getMilestone(depId);
      if (!dep) {
        return { error: `depends_on references unknown milestone: ${depId}` };
      }
      if (dep.status !== "complete" && dep.status !== "done") {
        return { error: `depends_on milestone ${depId} is not yet complete (status: ${dep.status})` };
      }
    }
  }

  try {
    transaction(() => {
      insertMilestone({
        id: params.milestoneId,
        title: params.title,
        status: params.status ?? "active",
        depends_on: params.dependsOn ?? [],
      });

      upsertMilestonePlanning(params.milestoneId, {
        vision: params.vision,
        successCriteria: params.successCriteria,
        keyRisks: params.keyRisks,
        proofStrategy: params.proofStrategy,
        verificationContract: params.verificationContract,
        verificationIntegration: params.verificationIntegration,
        verificationOperational: params.verificationOperational,
        verificationUat: params.verificationUat,
        definitionOfDone: params.definitionOfDone,
        requirementCoverage: params.requirementCoverage,
        boundaryMapMarkdown: params.boundaryMapMarkdown,
      });

      for (const slice of params.slices) {
        insertSlice({
          id: slice.sliceId,
          milestoneId: params.milestoneId,
          title: slice.title,
          status: "pending",
          risk: slice.risk,
          depends: slice.depends,
          demo: slice.demo,
        });
        upsertSlicePlanning(params.milestoneId, slice.sliceId, {
          goal: slice.goal,
          successCriteria: slice.successCriteria,
          proofLevel: slice.proofLevel,
          integrationClosure: slice.integrationClosure,
          observabilityImpact: slice.observabilityImpact,
        });
      }
    });
  } catch (err) {
    return { error: `db write failed: ${(err as Error).message}` };
  }

  let roadmapPath: string;
  try {
    const renderResult = await renderRoadmapFromDb(basePath, params.milestoneId);
    roadmapPath = renderResult.roadmapPath;
  } catch (renderErr) {
    process.stderr.write(
      `gsd-db: plan_milestone — render failed (DB rows preserved for debugging): ${(renderErr as Error).message}\n`,
    );
    invalidateStateCache();
    return { error: `render failed: ${(renderErr as Error).message}` };
  }

  invalidateStateCache();
  clearParseCache();

  // ── Post-mutation hook: projections, manifest, event log ───────────────
  try {
    await renderAllProjections(basePath, params.milestoneId);
    writeManifest(basePath);
    appendEvent(basePath, {
      cmd: "plan-milestone",
      params: { milestoneId: params.milestoneId },
      ts: new Date().toISOString(),
      actor: "agent",
      actor_name: params.actorName,
      trigger_reason: params.triggerReason,
    });
  } catch (hookErr) {
    process.stderr.write(
      `gsd: plan-milestone post-mutation hook warning: ${(hookErr as Error).message}\n`,
    );
  }

  return {
    milestoneId: params.milestoneId,
    roadmapPath,
  };
}
