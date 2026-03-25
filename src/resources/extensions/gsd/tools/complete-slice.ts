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
import {
  transaction,
  insertMilestone,
  insertSlice,
  getSlice,
  getSliceTasks,
  getMilestone,
  updateSliceStatus,
  _getAdapter,
} from "../gsd-db.js";
import { resolveSliceFile, resolveSlicePath, clearPathCache } from "../paths.js";
import { checkOwnership, sliceUnitKey } from "../unit-ownership.js";
import { saveFile, clearParseCache } from "../files.js";
import { invalidateStateCache } from "../state.js";
import { renderRoadmapCheckboxes } from "../markdown-renderer.js";
import { renderAllProjections } from "../workflow-projections.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";

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

  const providesYaml = params.provides.length > 0
    ? params.provides.map(p => `  - ${p}`).join("\n")
    : "  - (none)";

  const requiresYaml = params.requires.length > 0
    ? params.requires.map(r => `  - slice: ${r.slice}\n    provides: ${r.provides}`).join("\n")
    : "  []";

  const affectsYaml = params.affects.length > 0
    ? params.affects.map(a => `  - ${a}`).join("\n")
    : "  []";

  const keyFilesYaml = params.keyFiles.length > 0
    ? params.keyFiles.map(f => `  - ${f}`).join("\n")
    : "  - (none)";

  const keyDecisionsYaml = params.keyDecisions.length > 0
    ? params.keyDecisions.map(d => `  - ${d}`).join("\n")
    : "  - (none)";

  const patternsYaml = params.patternsEstablished.length > 0
    ? params.patternsEstablished.map(p => `  - ${p}`).join("\n")
    : "  - (none)";

  const observabilityYaml = params.observabilitySurfaces.length > 0
    ? params.observabilitySurfaces.map(o => `  - ${o}`).join("\n")
    : "  - none";

  const drillDownYaml = params.drillDownPaths.length > 0
    ? params.drillDownPaths.map(d => `  - ${d}`).join("\n")
    : "  []";

  // Requirements sections
  const reqAdvanced = params.requirementsAdvanced.length > 0
    ? params.requirementsAdvanced.map(r => `- ${r.id} — ${r.how}`).join("\n")
    : "None.";

  const reqValidated = params.requirementsValidated.length > 0
    ? params.requirementsValidated.map(r => `- ${r.id} — ${r.proof}`).join("\n")
    : "None.";

  const reqSurfaced = params.requirementsSurfaced.length > 0
    ? params.requirementsSurfaced.map(r => `- ${r}`).join("\n")
    : "None.";

  const reqInvalidated = params.requirementsInvalidated.length > 0
    ? params.requirementsInvalidated.map(r => `- ${r.id} — ${r.what}`).join("\n")
    : "None.";

  // Files modified
  const filesMod = params.filesModified.length > 0
    ? params.filesModified.map(f => `- \`${f.path}\` — ${f.description}`).join("\n")
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

  // ── State machine preconditions ─────────────────────────────────────────
  const milestone = getMilestone(params.milestoneId);
  if (!milestone) {
    return { error: `milestone not found: ${params.milestoneId}` };
  }
  if (milestone.status === "complete" || milestone.status === "done") {
    return { error: `cannot complete slice in a closed milestone: ${params.milestoneId} (status: ${milestone.status})` };
  }

  const slice = getSlice(params.milestoneId, params.sliceId);
  if (!slice) {
    return { error: `slice not found: ${params.milestoneId}/${params.sliceId}` };
  }
  if (slice.status === "complete" || slice.status === "done") {
    return { error: `slice ${params.sliceId} is already complete — use gsd_slice_reopen first if you need to redo it` };
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

  // ── Verify all tasks are complete ───────────────────────────────────────
  const tasks = getSliceTasks(params.milestoneId, params.sliceId);
  if (tasks.length === 0) {
    return { error: `no tasks found for slice ${params.sliceId} in milestone ${params.milestoneId}` };
  }

  const incompleteTasks = tasks.filter(t => t.status !== "complete");
  if (incompleteTasks.length > 0) {
    const incompleteIds = incompleteTasks.map(t => `${t.id} (status: ${t.status})`).join(", ");
    return { error: `incomplete tasks: ${incompleteIds}` };
  }

  // ── DB writes inside a transaction ──────────────────────────────────────
  const completedAt = new Date().toISOString();

  transaction(() => {
    insertMilestone({ id: params.milestoneId });
    insertSlice({ id: params.sliceId, milestoneId: params.milestoneId });
    updateSliceStatus(params.milestoneId, params.sliceId, "complete", completedAt);
  });

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
      process.stderr.write(
        `gsd-db: complete_slice — could not find roadmap for ${params.milestoneId}, skipping checkbox toggle\n`,
      );
    }
  } catch (renderErr) {
    // Disk render failed — roll back DB status so state stays consistent
    process.stderr.write(
      `gsd-db: complete_slice — disk render failed, rolling back DB status: ${(renderErr as Error).message}\n`,
    );
    const rollbackAdapter = _getAdapter();
    if (rollbackAdapter) {
      rollbackAdapter.prepare(
        `UPDATE slices SET status = 'pending' WHERE milestone_id = :mid AND id = :sid`,
      ).run({
        ":mid": params.milestoneId,
        ":sid": params.sliceId,
      });
    }
    invalidateStateCache();
    return { error: `disk render failed: ${(renderErr as Error).message}` };
  }

  // Store rendered markdown in DB for D004 recovery
  const adapter = _getAdapter();
  if (adapter) {
    adapter.prepare(
      `UPDATE slices SET full_summary_md = :summary_md, full_uat_md = :uat_md WHERE milestone_id = :mid AND id = :sid`,
    ).run({
      ":summary_md": summaryMd,
      ":uat_md": uatMd,
      ":mid": params.milestoneId,
      ":sid": params.sliceId,
    });
  }

  // Invalidate all caches
  invalidateStateCache();
  clearPathCache();
  clearParseCache();

  // ── Post-mutation hook: projections, manifest, event log ───────────────
  try {
    await renderAllProjections(basePath, params.milestoneId);
    writeManifest(basePath);
    appendEvent(basePath, {
      cmd: "complete-slice",
      params: { milestoneId: params.milestoneId, sliceId: params.sliceId },
      ts: new Date().toISOString(),
      actor: "agent",
      actor_name: params.actorName,
      trigger_reason: params.triggerReason,
    });
  } catch (hookErr) {
    process.stderr.write(
      `gsd: complete-slice post-mutation hook warning: ${(hookErr as Error).message}\n`,
    );
  }

  return {
    sliceId: params.sliceId,
    milestoneId: params.milestoneId,
    summaryPath,
    uatPath,
  };
}
