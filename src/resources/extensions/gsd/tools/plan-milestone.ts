import { clearParseCache } from "../files.js";
import { isClosedStatus } from "../status-guards.js";
import { isNonEmptyString, validateStringArray } from "../validation.js";
import {
  transaction,
  getMilestone,
  getMilestoneSlices,
  getSlice,
  insertMilestone,
  insertSlice,
  upsertMilestonePlanning,
  upsertSlicePlanning,
} from "../gsd-db.js";
import { invalidateStateCache } from "../state.js";
import { renderRoadmapFromDb } from "../markdown-renderer.js";
import { renderAllProjections } from "../workflow-projections.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning } from "../workflow-logger.js";

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
  vision: string;
  slices: PlanMilestoneSliceInput[];
  status?: string;
  dependsOn?: string[];
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
  /** @optional — defaults to [] when omitted by models with limited tool-calling */
  successCriteria?: string[];
  /** @optional — defaults to [] when omitted */
  keyRisks?: Array<{ risk: string; whyItMatters: string }>;
  /** @optional — defaults to [] when omitted */
  proofStrategy?: Array<{ riskOrUnknown: string; retireIn: string; whatWillBeProven: string }>;
  /** @optional — defaults to "" when omitted */
  verificationContract?: string;
  /** @optional — defaults to "" when omitted */
  verificationIntegration?: string;
  /** @optional — defaults to "" when omitted */
  verificationOperational?: string;
  /** @optional — defaults to "" when omitted */
  verificationUat?: string;
  /** @optional — defaults to [] when omitted */
  definitionOfDone?: string[];
  /** @optional — defaults to "Not provided." when omitted */
  requirementCoverage?: string;
  /** @optional — defaults to "Not provided." when omitted */
  boundaryMapMarkdown?: string;
}

export interface PlanMilestoneResult {
  milestoneId: string;
  roadmapPath: string;
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

  return {
    ...params,
    dependsOn: params.dependsOn ? validateStringArray(params.dependsOn, "dependsOn") : [],
    // Apply defaults for optional enrichment fields (#2771)
    successCriteria: params.successCriteria ? validateStringArray(params.successCriteria, "successCriteria") : [],
    keyRisks: params.keyRisks ? validateRiskEntries(params.keyRisks) : [],
    proofStrategy: params.proofStrategy ? validateProofStrategy(params.proofStrategy) : [],
    verificationContract: params.verificationContract ?? "",
    verificationIntegration: params.verificationIntegration ?? "",
    verificationOperational: params.verificationOperational ?? "",
    verificationUat: params.verificationUat ?? "",
    definitionOfDone: params.definitionOfDone ? validateStringArray(params.definitionOfDone, "definitionOfDone") : [],
    requirementCoverage: params.requirementCoverage ?? "Not provided.",
    boundaryMapMarkdown: params.boundaryMapMarkdown ?? "Not provided.",
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

  // ── Guards + DB writes inside a single transaction (prevents TOCTOU) ───
  // Guards must be inside the transaction so the state they check cannot
  // change between the read and the write (#2723).
  let guardError: string | null = null;

  try {
    transaction(() => {
      const existingMilestone = getMilestone(params.milestoneId);
      if (existingMilestone && isClosedStatus(existingMilestone.status)) {
        guardError = `cannot re-plan milestone ${params.milestoneId}: it is already complete`;
        return;
      }

      // Guard: refuse to re-plan a milestone that would drop completed slices (#2960).
      // Allow re-planning when all completed slices are still present in the
      // incoming plan — their status is preserved below (#2558). Block only when
      // the new plan omits a completed slice, which could shadow completed work.
      const existingSlices = getMilestoneSlices(params.milestoneId);
      const completedSlices = existingSlices.filter(s => isClosedStatus(s.status));
      if (completedSlices.length > 0) {
        const incomingSliceIds = new Set(params.slices.map(s => s.sliceId));
        const droppedCompleted = completedSlices.filter(s => !incomingSliceIds.has(s.id));
        if (droppedCompleted.length > 0) {
          guardError = `cannot re-plan milestone ${params.milestoneId}: ${droppedCompleted.length} completed slice(s) would be dropped (${droppedCompleted.map(s => s.id).join(", ")}). Use gsd_reassess_roadmap to modify the roadmap.`;
          return;
        }
      }

      // Validate depends_on: all dependencies must exist and be complete
      if (params.dependsOn && params.dependsOn.length > 0) {
        for (const depId of params.dependsOn) {
          const dep = getMilestone(depId);
          if (!dep) {
            guardError = `depends_on references unknown milestone: ${depId}`;
            return;
          }
          if (!isClosedStatus(dep.status)) {
            guardError = `depends_on milestone ${depId} is not yet complete (status: ${dep.status})`;
            return;
          }
        }
      }

      insertMilestone({
        id: params.milestoneId,
        title: params.title,
        status: params.status ?? "active",
        depends_on: params.dependsOn ?? [],
      });

      upsertMilestonePlanning(params.milestoneId, {
        title: params.title,
        status: params.status ?? "active",
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

      for (let i = 0; i < params.slices.length; i++) {
        const slice = params.slices[i]!;
        // Preserve completed/done status on re-plan (#2558).
        // Without this, a re-plan after milestone transition would reset
        // already-completed slices back to "pending".
        const existing = getSlice(params.milestoneId, slice.sliceId);
        const status = existing && (existing.status === "complete" || existing.status === "done")
          ? existing.status
          : "pending";
        insertSlice({
          id: slice.sliceId,
          milestoneId: params.milestoneId,
          title: slice.title,
          status,
          risk: slice.risk,
          depends: slice.depends,
          demo: slice.demo,
          sequence: i + 1, // Preserve agent-ordered sequence (#3356)
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

  if (guardError) {
    return { error: guardError };
  }

  let roadmapPath: string;
  try {
    const renderResult = await renderRoadmapFromDb(basePath, params.milestoneId);
    roadmapPath = renderResult.roadmapPath;
  } catch (renderErr) {
    logWarning("tool", `plan_milestone — render failed (DB rows preserved for debugging): ${(renderErr as Error).message}`);
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
    logWarning("tool", `plan-milestone post-mutation hook warning: ${(hookErr as Error).message}`);
  }

  return {
    milestoneId: params.milestoneId,
    roadmapPath,
  };
}
