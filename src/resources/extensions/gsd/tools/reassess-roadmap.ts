import { join } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { clearParseCache } from "../files.js";
import { isClosedStatus } from "../status-guards.js";
import { isNonEmptyString } from "../validation.js";
import {
  transaction,
  getMilestone,
  getMilestoneSlices,
  getSlice,
  insertSlice,
  updateSliceFields,
  insertAssessment,
  deleteAssessmentByScope,
  deleteSlice,
} from "../gsd-db.js";
import { invalidateStateCache } from "../state.js";
import { renderRoadmapFromDb, renderAssessmentFromDb } from "../markdown-renderer.js";
import { renderAllProjections } from "../workflow-projections.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning } from "../workflow-logger.js";

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

  // ── Compute assessment artifact path ──────────────────────────────
  // Assessment lives in the completed slice's directory
  const assessmentRelPath = join(
    ".gsd", "milestones", params.milestoneId,
    "slices", params.completedSliceId,
    `${params.completedSliceId}-ASSESSMENT.md`,
  );

  // ── Guards + DB writes inside a single transaction (prevents TOCTOU) ───
  // Guards must be inside the transaction so the state they check cannot
  // change between the read and the write (#2723).
  let guardError: string | null = null;

  try {
    transaction(() => {
      // Verify milestone exists and is active
      const milestone = getMilestone(params.milestoneId);
      if (!milestone) {
        guardError = `milestone not found: ${params.milestoneId}`;
        return;
      }
      if (isClosedStatus(milestone.status)) {
        guardError = `cannot reassess a closed milestone: ${params.milestoneId} (status: ${milestone.status})`;
        return;
      }

      // Verify completedSliceId is actually complete
      const completedSlice = getSlice(params.milestoneId, params.completedSliceId);
      if (!completedSlice) {
        guardError = `completedSliceId not found: ${params.milestoneId}/${params.completedSliceId}`;
        return;
      }
      if (!isClosedStatus(completedSlice.status)) {
        guardError = `completedSliceId ${params.completedSliceId} is not complete (status: ${completedSlice.status}) — reassess can only be called after a slice finishes`;
        return;
      }

      // Structural enforcement — reject modifications/removal of completed slices
      const existingSlices = getMilestoneSlices(params.milestoneId);
      const completedSliceIds = new Set<string>();
      for (const slice of existingSlices) {
        if (isClosedStatus(slice.status)) {
          completedSliceIds.add(slice.id);
        }
      }

      for (const modifiedSlice of params.sliceChanges.modified) {
        if (completedSliceIds.has(modifiedSlice.sliceId)) {
          guardError = `cannot modify completed slice ${modifiedSlice.sliceId}`;
          return;
        }
      }

      for (const removedId of params.sliceChanges.removed) {
        if (completedSliceIds.has(removedId)) {
          guardError = `cannot remove completed slice ${removedId}`;
          return;
        }
      }

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

      // Insert new slices — assign sequence after existing slices (#3356)
      const existingCount = getMilestoneSlices(params.milestoneId).length;
      for (let i = 0; i < params.sliceChanges.added.length; i++) {
        const added = params.sliceChanges.added[i]!;
        insertSlice({
          id: added.sliceId,
          milestoneId: params.milestoneId,
          title: added.title,
          status: "pending",
          risk: added.risk,
          depends: added.depends,
          demo: added.demo ?? "",
          sequence: existingCount + i + 1,
        });
      }

      // Delete removed slices
      for (const removedId of params.sliceChanges.removed) {
        deleteSlice(params.milestoneId, removedId);
      }

      // ── Invalidate stale milestone validation (#2957) ──────────────
      // When roadmap structure changes (slices added/modified/removed),
      // any prior milestone-validation verdict is stale. Delete the DB
      // row so deriveState() returns phase: 'validating-milestone' once
      // the new slices complete, rather than advancing directly to
      // 'completing-milestone' with a stale needs-remediation verdict.
      const hasStructuralChanges =
        params.sliceChanges.added.length > 0 ||
        params.sliceChanges.modified.length > 0 ||
        params.sliceChanges.removed.length > 0;

      if (hasStructuralChanges) {
        deleteAssessmentByScope(params.milestoneId, "milestone-validation");
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
    const roadmapResult = await renderRoadmapFromDb(basePath, params.milestoneId);
    const assessmentResult = await renderAssessmentFromDb(basePath, params.milestoneId, params.completedSliceId, {
      verdict: params.verdict,
      assessment: params.assessment,
      completedSliceId: params.completedSliceId,
    });

    // ── Remove stale VALIDATION file from disk (#2957) ────────────
    const hasStructuralChanges =
      params.sliceChanges.added.length > 0 ||
      params.sliceChanges.modified.length > 0 ||
      params.sliceChanges.removed.length > 0;

    if (hasStructuralChanges) {
      const validationFile = join(
        basePath, ".gsd", "milestones", params.milestoneId,
        `${params.milestoneId}-VALIDATION.md`,
      );
      try {
        if (existsSync(validationFile)) unlinkSync(validationFile);
      } catch (e) {
        logWarning("tool", `validation file cleanup failed: ${(e as Error).message}`);
      }
    }

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
      logWarning("tool", `reassess-roadmap post-mutation hook warning: ${(hookErr as Error).message}`);
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
