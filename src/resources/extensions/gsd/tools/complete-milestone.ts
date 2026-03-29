/**
 * complete-milestone handler — the core operation behind gsd_complete_milestone.
 *
 * Validates all slices are complete, updates milestone status in DB,
 * renders MILESTONE-SUMMARY.md to disk, stores rendered markdown in DB
 * for recovery, and invalidates caches.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";

import {
  transaction,
  getMilestone,
  getMilestoneSlices,
  getSliceTasks,
  updateMilestoneStatus,
} from "../gsd-db.js";
import { resolveMilestonePath, clearPathCache } from "../paths.js";
import { isClosedStatus } from "../status-guards.js";
import { saveFile, clearParseCache } from "../files.js";
import { invalidateStateCache } from "../state.js";
import { renderAllProjections, stripIdPrefix } from "../workflow-projections.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";

export interface CompleteMilestoneParams {
  milestoneId: string;
  title: string;
  oneLiner: string;
  narrative: string;
  successCriteriaResults: string;
  definitionOfDoneResults: string;
  requirementOutcomes: string;
  keyDecisions: string[];
  keyFiles: string[];
  lessonsLearned: string[];
  followUps: string;
  deviations: string;
  verificationPassed: boolean;
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
}

export interface CompleteMilestoneResult {
  milestoneId: string;
  summaryPath: string;
}

function renderMilestoneSummaryMarkdown(params: CompleteMilestoneParams): string {
  const now = new Date().toISOString();
  const displayTitle = stripIdPrefix(params.title, params.milestoneId);

  const keyDecisionsYaml = params.keyDecisions.length > 0
    ? params.keyDecisions.map(d => `  - ${d}`).join("\n")
    : "  - (none)";

  const keyFilesYaml = params.keyFiles.length > 0
    ? params.keyFiles.map(f => `  - ${f}`).join("\n")
    : "  - (none)";

  const lessonsYaml = params.lessonsLearned.length > 0
    ? params.lessonsLearned.map(l => `  - ${l}`).join("\n")
    : "  - (none)";

  return `---
id: ${params.milestoneId}
title: "${displayTitle}"
status: complete
completed_at: ${now}
key_decisions:
${keyDecisionsYaml}
key_files:
${keyFilesYaml}
lessons_learned:
${lessonsYaml}
---

# ${params.milestoneId}: ${displayTitle}

**${params.oneLiner}**

## What Happened

${params.narrative}

## Success Criteria Results

${params.successCriteriaResults}

## Definition of Done Results

${params.definitionOfDoneResults}

## Requirement Outcomes

${params.requirementOutcomes}

## Deviations

${params.deviations || "None."}

## Follow-ups

${params.followUps || "None."}
`;
}

export async function handleCompleteMilestone(
  params: CompleteMilestoneParams,
  basePath: string,
): Promise<CompleteMilestoneResult | { error: string }> {
  // ── Validate required fields ────────────────────────────────────────────
  if (!params.milestoneId || typeof params.milestoneId !== "string" || params.milestoneId.trim() === "") {
    return { error: "milestoneId is required and must be a non-empty string" };
  }
  if (!params.title || typeof params.title !== "string" || params.title.trim() === "") {
    return { error: "title is required and must be a non-empty string" };
  }

  // ── Verify that verification passed ─────────────────────────────────────
  if (params.verificationPassed !== true) {
    return { error: "verification did not pass — milestone completion blocked. verificationPassed must be explicitly set to true after all verification steps succeed" };
  }

  // ── Guards + DB writes inside a single transaction (prevents TOCTOU) ───
  const completedAt = new Date().toISOString();
  let guardError: string | null = null;

  transaction(() => {
    // State machine preconditions (inside txn for atomicity)
    const milestone = getMilestone(params.milestoneId);
    if (!milestone) {
      guardError = `milestone not found: ${params.milestoneId}`;
      return;
    }
    if (isClosedStatus(milestone.status)) {
      guardError = `milestone ${params.milestoneId} is already complete`;
      return;
    }

    // Verify all slices are complete
    const slices = getMilestoneSlices(params.milestoneId);
    if (slices.length === 0) {
      guardError = `no slices found for milestone ${params.milestoneId}`;
      return;
    }

    const incompleteSlices = slices.filter(s => !isClosedStatus(s.status));
    if (incompleteSlices.length > 0) {
      const incompleteIds = incompleteSlices.map(s => `${s.id} (status: ${s.status})`).join(", ");
      guardError = `incomplete slices: ${incompleteIds}`;
      return;
    }

    // Deep check: verify all tasks in all slices are complete
    for (const slice of slices) {
      const tasks = getSliceTasks(params.milestoneId, slice.id);
      const incompleteTasks = tasks.filter(t => !isClosedStatus(t.status));
      if (incompleteTasks.length > 0) {
        const ids = incompleteTasks.map(t => `${t.id} (status: ${t.status})`).join(", ");
        guardError = `slice ${slice.id} has incomplete tasks: ${ids}`;
        return;
      }
    }

    // All guards passed — perform write
    updateMilestoneStatus(params.milestoneId, 'complete', completedAt);
  });

  if (guardError) {
    return { error: guardError };
  }

  // ── Filesystem operations (outside transaction) ─────────────────────────
  const summaryMd = renderMilestoneSummaryMarkdown(params);

  let summaryPath: string;
  const milestoneDir = resolveMilestonePath(basePath, params.milestoneId);
  if (milestoneDir) {
    summaryPath = join(milestoneDir, `${params.milestoneId}-SUMMARY.md`);
  } else {
    const gsdDir = join(basePath, ".gsd");
    const manualDir = join(gsdDir, "milestones", params.milestoneId);
    mkdirSync(manualDir, { recursive: true });
    summaryPath = join(manualDir, `${params.milestoneId}-SUMMARY.md`);
  }

  try {
    await saveFile(summaryPath, summaryMd);
  } catch (renderErr) {
    // Disk render failed — roll back DB status so state stays consistent
    process.stderr.write(
      `gsd-db: complete_milestone — disk render failed, rolling back DB status: ${(renderErr as Error).message}\n`,
    );
    updateMilestoneStatus(params.milestoneId, 'active', null);
    invalidateStateCache();
    return { error: `disk render failed: ${(renderErr as Error).message}` };
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
      cmd: "complete-milestone",
      params: { milestoneId: params.milestoneId },
      ts: new Date().toISOString(),
      actor: "agent",
      actor_name: params.actorName,
      trigger_reason: params.triggerReason,
    });
  } catch (hookErr) {
    process.stderr.write(
      `gsd: complete-milestone post-mutation hook warning: ${(hookErr as Error).message}\n`,
    );
  }

  return {
    milestoneId: params.milestoneId,
    summaryPath,
  };
}
