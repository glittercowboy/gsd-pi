/**
 * complete-slice handler — the core operation behind gsd_slice_complete.
 *
 * Validates inputs, checks all tasks are complete, writes slice row to DB in
 * a transaction, then (outside the transaction) renders SUMMARY.md + UAT.md
 * to disk, toggles the roadmap checkbox, stores rendered markdown in DB for
 * D004 recovery, and invalidates caches.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";

import type { CompleteSliceParams } from "../types.js";
import { isClosedStatus } from "../status-guards.js";
import {
  transaction,
  insertMilestone,
  insertSlice,
  getSlice,
  getSliceTasks,
  getMilestone,
  updateSliceStatus,
  setSliceSummaryMd,
} from "../gsd-db.js";
import { resolveSliceFile, resolveSlicePath, clearPathCache } from "../paths.js";
import { checkOwnership, sliceUnitKey } from "../unit-ownership.js";
import { saveFile, clearParseCache } from "../files.js";
import { invalidateStateCache } from "../state.js";
import { renderRoadmapCheckboxes } from "../markdown-renderer.js";
import { renderAllProjections } from "../workflow-projections.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning, logError } from "../workflow-logger.js";

export interface CompleteSliceResult {
  sliceId: string;
  milestoneId: string;
  summaryPath: string;
  uatPath: string;
}

/**
 * Render slice summary markdown matching the template format.
 * YAML frontmatter uses snake_case keys for parseSummary() compatibility.
 */
function renderSliceSummaryMarkdown(params: CompleteSliceParams): string {
  const now = new Date().toISOString();

  // Apply defaults for optional enrichment arrays (#2771)
  const provides = params.provides ?? [];
  const requires = params.requires ?? [];
  const affects = params.affects ?? [];
  const keyFiles = params.keyFiles ?? [];
  const keyDecisions = params.keyDecisions ?? [];
  const patternsEstablished = params.patternsEstablished ?? [];
  const observabilitySurfaces = params.observabilitySurfaces ?? [];
  const drillDownPaths = params.drillDownPaths ?? [];
  const requirementsAdvanced = params.requirementsAdvanced ?? [];
  const requirementsValidated = params.requirementsValidated ?? [];
  const requirementsSurfaced = params.requirementsSurfaced ?? [];
  const requirementsInvalidated = params.requirementsInvalidated ?? [];
  const filesModified = params.filesModified ?? [];

  const providesYaml = provides.length > 0
    ? provides.map(p => `  - ${p}`).join("\n")
    : "  - (none)";

  const requiresYaml = requires.length > 0
    ? requires.map(r => `  - slice: ${r.slice}\n    provides: ${r.provides}`).join("\n")
    : "  []";

  const affectsYaml = affects.length > 0
    ? affects.map(a => `  - ${a}`).join("\n")
    : "  []";

  const keyFilesYaml = keyFiles.length > 0
    ? keyFiles.map(f => `  - ${f}`).join("\n")
    : "  - (none)";

  const keyDecisionsYaml = keyDecisions.length > 0
    ? keyDecisions.map(d => `  - ${d}`).join("\n")
    : "  - (none)";

  const patternsYaml = patternsEstablished.length > 0
    ? patternsEstablished.map(p => `  - ${p}`).join("\n")
    : "  - (none)";

  const observabilityYaml = observabilitySurfaces.length > 0
    ? observabilitySurfaces.map(o => `  - ${o}`).join("\n")
    : "  - none";

  const drillDownYaml = drillDownPaths.length > 0
    ? drillDownPaths.map(d => `  - ${d}`).join("\n")
    : "  []";

  // Requirements sections
  const reqAdvanced = requirementsAdvanced.length > 0
    ? requirementsAdvanced.map(r => `- ${r.id} — ${r.how}`).join("\n")
    : "None.";

  const reqValidated = requirementsValidated.length > 0
    ? requirementsValidated.map(r => `- ${r.id} — ${r.proof}`).join("\n")
    : "None.";

  const reqSurfaced = requirementsSurfaced.length > 0
    ? requirementsSurfaced.map(r => `- ${r}`).join("\n")
    : "None.";

  const reqInvalidated = requirementsInvalidated.length > 0
    ? requirementsInvalidated.map(r => `- ${r.id} — ${r.what}`).join("\n")
    : "None.";

  // Files modified
  const filesMod = filesModified.length > 0
    ? filesModified.map(f => `- \`${f.path}\` — ${f.description}`).join("\n")
    : "None.";

  return `---
id: ${params.sliceId}
parent: ${params.milestoneId}
milestone: ${params.milestoneId}
provides:
${providesYaml}
requires:
${requiresYaml}
affects:
${affectsYaml}
key_files:
${keyFilesYaml}
key_decisions:
${keyDecisionsYaml}
patterns_established:
${patternsYaml}
observability_surfaces:
${observabilityYaml}
drill_down_paths:
${drillDownYaml}
duration: ""
verification_result: passed
completed_at: ${now}
blocker_discovered: false
---

# ${params.sliceId}: ${params.sliceTitle}

**${params.oneLiner}**

## What Happened

${params.narrative}

## Verification

${params.verification}

## Requirements Advanced

${reqAdvanced}

## Requirements Validated

${reqValidated}

## New Requirements Surfaced

${reqSurfaced}

## Requirements Invalidated or Re-scoped

${reqInvalidated}

## Deviations

${params.deviations || "None."}

## Known Limitations

${params.knownLimitations || "None."}

## Follow-ups

${params.followUps || "None."}

## Files Created/Modified

${filesMod}
`;
}

/**
 * Render UAT markdown matching the template format.
 */
function renderUatMarkdown(params: CompleteSliceParams): string {
  return `# ${params.sliceId}: ${params.sliceTitle} — UAT

**Milestone:** ${params.milestoneId}
**Written:** ${new Date().toISOString()}

${params.uatContent}
`;
}

/**
 * Handle the complete_slice operation end-to-end.
 *
 * 1. Validate required fields
 * 2. Verify all tasks are complete
 * 3. Write DB in a transaction (milestone, slice upsert, status update)
 * 4. Render SUMMARY.md + UAT.md to disk
 * 5. Toggle roadmap checkbox
 * 6. Store rendered markdown back in DB (for D004 recovery)
 * 7. Invalidate caches
 */
export async function handleCompleteSlice(
  params: CompleteSliceParams,
  basePath: string,
): Promise<CompleteSliceResult | { error: string }> {
  // ── Validate required fields ────────────────────────────────────────────
  if (!params.sliceId || typeof params.sliceId !== "string" || params.sliceId.trim() === "") {
    return { error: "sliceId is required and must be a non-empty string" };
  }
  if (!params.milestoneId || typeof params.milestoneId !== "string" || params.milestoneId.trim() === "") {
    return { error: "milestoneId is required and must be a non-empty string" };
  }

  // ── Ownership check (opt-in: only enforced when claim file exists) ──────
  const ownershipErr = checkOwnership(
    basePath,
    sliceUnitKey(params.milestoneId, params.sliceId),
    params.actorName,
  );
  if (ownershipErr) {
    return { error: ownershipErr };
  }

  // ── Verification content gate (#3580) ──────────────────────────────────
  // Reject completion when the provided verification/UAT clearly indicates
  // the slice is blocked or failed. Prevents prompt regressions from
  // silently advancing blocked slices.
  const BLOCKED_SIGNALS = /\b(status:\s*blocked|verification_result:\s*failed|slice is blocked|cannot complete|verification failed)\b/i;
  if (BLOCKED_SIGNALS.test(params.verification || "") || BLOCKED_SIGNALS.test(params.uatContent || "")) {
    return { error: `slice verification indicates blocked/failed state — do not complete a slice that has not passed verification. Address the blockers and re-verify first.` };
  }

  // ── Guards + DB writes inside a single transaction (prevents TOCTOU) ───
  const completedAt = new Date().toISOString();
  const originalSliceStatus = getSlice(params.milestoneId, params.sliceId)?.status ?? "pending";
  let guardError: string | null = null;

  transaction(() => {
    // State machine preconditions (inside txn for atomicity).
    // Milestone/slice not existing is OK — insertMilestone/insertSlice below will auto-create.
    // Only block if they exist and are closed.
    const milestone = getMilestone(params.milestoneId);
    if (milestone && isClosedStatus(milestone.status)) {
      guardError = `cannot complete slice in a closed milestone: ${params.milestoneId} (status: ${milestone.status})`;
      return;
    }

    const slice = getSlice(params.milestoneId, params.sliceId);
    if (slice && isClosedStatus(slice.status)) {
      guardError = `slice ${params.sliceId} is already complete — use gsd_slice_reopen first if you need to redo it`;
      return;
    }

    // Verify all tasks are complete
    const tasks = getSliceTasks(params.milestoneId, params.sliceId);
    if (tasks.length === 0) {
      guardError = `no tasks found for slice ${params.sliceId} in milestone ${params.milestoneId}`;
      return;
    }

    const incompleteTasks = tasks.filter(t => !isClosedStatus(t.status));
    if (incompleteTasks.length > 0) {
      const incompleteIds = incompleteTasks.map(t => `${t.id} (status: ${t.status})`).join(", ");
      guardError = `incomplete tasks: ${incompleteIds}`;
      return;
    }

    // All guards passed — perform writes
    insertMilestone({ id: params.milestoneId, title: params.milestoneId });
    insertSlice({ id: params.sliceId, milestoneId: params.milestoneId, title: params.sliceId });
    updateSliceStatus(params.milestoneId, params.sliceId, "complete", completedAt);
  });

  if (guardError) {
    return { error: guardError };
  }

  // ── Filesystem operations (outside transaction) ─────────────────────────
  // If disk render fails, roll back the DB status so deriveState() and
  // verifyExpectedArtifact() stay consistent (both say "not done").

  // Render summary markdown
  const summaryMd = renderSliceSummaryMarkdown(params);

  // Resolve and write summary to disk
  let summaryPath: string;
  const sliceDir = resolveSlicePath(basePath, params.milestoneId, params.sliceId);
  if (sliceDir) {
    summaryPath = join(sliceDir, `${params.sliceId}-SUMMARY.md`);
  } else {
    // Slice dir doesn't exist on disk yet — build path manually and ensure dirs
    const gsdDir = join(basePath, ".gsd");
    const manualSliceDir = join(gsdDir, "milestones", params.milestoneId, "slices", params.sliceId);
    mkdirSync(manualSliceDir, { recursive: true });
    summaryPath = join(manualSliceDir, `${params.sliceId}-SUMMARY.md`);
  }

  const uatMd = renderUatMarkdown(params);
  const uatPath = summaryPath.replace(/-SUMMARY\.md$/, "-UAT.md");

  try {
    await saveFile(summaryPath, summaryMd);
    await saveFile(uatPath, uatMd);

    // Toggle roadmap checkbox via renderer module
    const roadmapToggled = await renderRoadmapCheckboxes(basePath, params.milestoneId);
    if (!roadmapToggled) {
      logWarning("tool", `complete_slice — could not find roadmap for ${params.milestoneId}, skipping checkbox toggle`);
    }
  } catch (renderErr) {
    // Disk render failed — roll back DB status so state stays consistent
    logWarning("tool", `complete_slice — disk render failed for ${params.milestoneId}/${params.sliceId}, rolling back DB status`, { error: (renderErr as Error).message });
    updateSliceStatus(params.milestoneId, params.sliceId, originalSliceStatus);
    invalidateStateCache();
    return { error: `disk render failed: ${(renderErr as Error).message}` };
  }

  // Store rendered markdown in DB for D004 recovery
  setSliceSummaryMd(params.milestoneId, params.sliceId, summaryMd, uatMd);

  // Invalidate all caches
  invalidateStateCache();
  clearPathCache();
  clearParseCache();

  // ── Post-mutation hook: projections, manifest, event log ───────────────
  // Separate try/catch per step so a projection failure doesn't prevent
  // the event log entry (critical for worktree reconciliation).
  try {
    await renderAllProjections(basePath, params.milestoneId);
  } catch (projErr) {
    logWarning("tool", `complete-slice projection warning for ${params.milestoneId}/${params.sliceId}: ${(projErr as Error).message}`);
  }
  try {
    writeManifest(basePath);
  } catch (mfErr) {
    logWarning("tool", `complete-slice manifest warning: ${(mfErr as Error).message}`);
  }
  try {
    appendEvent(basePath, {
      cmd: "complete-slice",
      params: { milestoneId: params.milestoneId, sliceId: params.sliceId },
      ts: new Date().toISOString(),
      actor: "agent",
      actor_name: params.actorName,
      trigger_reason: params.triggerReason,
    });
  } catch (eventErr) {
    logError("tool", `complete-slice event log FAILED — completion invisible to reconciliation`, { error: (eventErr as Error).message });
  }

  return {
    sliceId: params.sliceId,
    milestoneId: params.milestoneId,
    summaryPath,
    uatPath,
  };
}
