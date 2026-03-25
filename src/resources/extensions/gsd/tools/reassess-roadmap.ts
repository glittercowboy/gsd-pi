import { clearParseCache } from "../files.js";
import {
  transaction,
  getMilestone,
  getMilestoneSlices,
  getSlice,
  insertSlice,
  updateSliceFields,
  insertAssessment,
  deleteSlice,
} from "../gsd-db.js";
import { invalidateStateCache } from "../state.js";
import { renderRoadmapFromDb, renderAssessmentFromDb } from "../markdown-renderer.js";
import { renderAllProjections } from "../workflow-projections.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { join } from "node:path";

export interface SliceChangeInput {
  sliceId: string;
  title: string;
  risk?: string;
  depends?: string[];
  demo?: string;
}

export interface ReassessRoadmapParams {
  milestoneId: string;
  completedSliceId: string;
  verdict: string;
  assessment: string;
  sliceChanges: {
    modified: SliceChangeInput[];
    added: SliceChangeInput[];
    removed: string[];
  };
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
}

export interface ReassessRoadmapResult {
  milestoneId: string;
  completedSliceId: string;
  assessmentPath: string;
  roadmapPath: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateParams(params: ReassessRoadmapParams): ReassessRoadmapParams {
  if (!isNonEmptyString(params?.milestoneId)) throw new Error("milestoneId is required");
  if (!isNonEmptyString(params?.completedSliceId)) throw new Error("completedSliceId is required");
  if (!isNonEmptyString(params?.verdict)) throw new Error("verdict is required");
  if (!isNonEmptyString(params?.assessment)) throw new Error("assessment is required");

  if (!params.sliceChanges || typeof params.sliceChanges !== "object") {
    throw new Error("sliceChanges must be an object");
  }

  if (!Array.isArray(params.sliceChanges.modified)) {
    throw new Error("sliceChanges.modified must be an array");
  }

  if (!Array.isArray(params.sliceChanges.added)) {
    throw new Error("sliceChanges.added must be an array");
  }

  if (!Array.isArray(params.sliceChanges.removed)) {
    throw new Error("sliceChanges.removed must be an array");
  }

  // Validate each modified slice
  for (let i = 0; i < params.sliceChanges.modified.length; i++) {
    const s = params.sliceChanges.modified[i];
    if (!s || typeof s !== "object") throw new Error(`sliceChanges.modified[${i}] must be an object`);
    if (!isNonEmptyString(s.sliceId)) throw new Error(`sliceChanges.modified[${i}].sliceId is required`);
    if (!isNonEmptyString(s.title)) throw new Error(`sliceChanges.modified[${i}].title is required`);
  }

  // Validate each added slice
  for (let i = 0; i < params.sliceChanges.added.length; i++) {
    const s = params.sliceChanges.added[i];
    if (!s || typeof s !== "object") throw new Error(`sliceChanges.added[${i}] must be an object`);
    if (!isNonEmptyString(s.sliceId)) throw new Error(`sliceChanges.added[${i}].sliceId is required`);
    if (!isNonEmptyString(s.title)) throw new Error(`sliceChanges.added[${i}].title is required`);
  }

  return params;
}

export async function handleReassessRoadmap(
  rawParams: ReassessRoadmapParams,
  basePath: string,
): Promise<ReassessRoadmapResult | { error: string }> {
  // ── Validate ──────────────────────────────────────────────────────
  let params: ReassessRoadmapParams;
  try {
    params = validateParams(rawParams);
  } catch (err) {
    return { error: `validation failed: ${(err as Error).message}` };
  }

  // ── Verify milestone exists and is active ────────────────────────
  const milestone = getMilestone(params.milestoneId);
  if (!milestone) {
    return { error: `milestone not found: ${params.milestoneId}` };
  }
  if (milestone.status === "complete" || milestone.status === "done") {
    return { error: `cannot reassess a closed milestone: ${params.milestoneId} (status: ${milestone.status})` };
  }

  // ── Verify completedSliceId is actually complete ──────────────────
  const completedSlice = getSlice(params.milestoneId, params.completedSliceId);
  if (!completedSlice) {
    return { error: `completedSliceId not found: ${params.milestoneId}/${params.completedSliceId}` };
  }
  if (completedSlice.status !== "complete" && completedSlice.status !== "done") {
    return { error: `completedSliceId ${params.completedSliceId} is not complete (status: ${completedSlice.status}) — reassess can only be called after a slice finishes` };
  }

  // ── Structural enforcement ────────────────────────────────────────
  const existingSlices = getMilestoneSlices(params.milestoneId);
  const completedSliceIds = new Set<string>();
  for (const slice of existingSlices) {
    if (slice.status === "complete" || slice.status === "done") {
      completedSliceIds.add(slice.id);
    }
  }

  // Reject modifications to completed slices
  for (const modifiedSlice of params.sliceChanges.modified) {
    if (completedSliceIds.has(modifiedSlice.sliceId)) {
      return { error: `cannot modify completed slice ${modifiedSlice.sliceId}` };
    }
  }

  // Reject removal of completed slices
  for (const removedId of params.sliceChanges.removed) {
    if (completedSliceIds.has(removedId)) {
      return { error: `cannot remove completed slice ${removedId}` };
    }
  }

  // ── Compute assessment artifact path ──────────────────────────────
  // Assessment lives in the completed slice's directory
  const assessmentRelPath = join(
    ".gsd", "milestones", params.milestoneId,
    "slices", params.completedSliceId,
    `${params.completedSliceId}-ASSESSMENT.md`,
  );

  // ── Transaction: DB mutations ─────────────────────────────────────
  try {
    transaction(() => {
      // Record assessment
      insertAssessment({
        path: assessmentRelPath,
        milestoneId: params.milestoneId,
        sliceId: params.completedSliceId,
        status: params.verdict,
        scope: "roadmap",
        fullContent: params.assessment,
      });

      // Apply slice modifications
      for (const mod of params.sliceChanges.modified) {
        updateSliceFields(params.milestoneId, mod.sliceId, {
          title: mod.title,
          risk: mod.risk,
          depends: mod.depends,
          demo: mod.demo,
        });
      }

      // Insert new slices
      for (const added of params.sliceChanges.added) {
        insertSlice({
          id: added.sliceId,
          milestoneId: params.milestoneId,
          title: added.title,
          status: "pending",
          risk: added.risk,
          depends: added.depends,
          demo: added.demo ?? "",
        });
      }

      // Delete removed slices
      for (const removedId of params.sliceChanges.removed) {
        deleteSlice(params.milestoneId, removedId);
      }
    });
  } catch (err) {
    return { error: `db write failed: ${(err as Error).message}` };
  }

  // ── Render artifacts ──────────────────────────────────────────────
  try {
    const roadmapResult = await renderRoadmapFromDb(basePath, params.milestoneId);
    const assessmentResult = await renderAssessmentFromDb(basePath, params.milestoneId, params.completedSliceId, {
      verdict: params.verdict,
      assessment: params.assessment,
      completedSliceId: params.completedSliceId,
    });

    // ── Invalidate caches ─────────────────────────────────────────
    invalidateStateCache();
    clearParseCache();

    // ── Post-mutation hook: projections, manifest, event log ─────
    try {
      await renderAllProjections(basePath, params.milestoneId);
      writeManifest(basePath);
      appendEvent(basePath, {
        cmd: "reassess-roadmap",
        params: { milestoneId: params.milestoneId, completedSliceId: params.completedSliceId },
        ts: new Date().toISOString(),
        actor: "agent",
        actor_name: params.actorName,
        trigger_reason: params.triggerReason,
      });
    } catch (hookErr) {
      process.stderr.write(
        `gsd: reassess-roadmap post-mutation hook warning: ${(hookErr as Error).message}\n`,
      );
    }

    return {
      milestoneId: params.milestoneId,
      completedSliceId: params.completedSliceId,
      assessmentPath: assessmentResult.assessmentPath,
      roadmapPath: roadmapResult.roadmapPath,
    };
  } catch (err) {
    return { error: `render failed: ${(err as Error).message}` };
  }
}
