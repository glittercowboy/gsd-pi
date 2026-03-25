/**
 * complete-task handler — the core operation behind gsd_complete_task.
 *
 * Validates inputs, writes task row to DB in a transaction, then (outside
 * the transaction) renders SUMMARY.md to disk, toggles the plan checkbox,
 * stores the rendered markdown in the DB for D004 recovery, and invalidates
 * caches.
 */

import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

import type { CompleteTaskParams } from "../types.js";
import {
  transaction,
  insertMilestone,
  insertSlice,
  insertTask,
  insertVerificationEvidence,
  getMilestone,
  getSlice,
  getTask,
  _getAdapter,
} from "../gsd-db.js";
import { resolveSliceFile, resolveTasksDir, clearPathCache } from "../paths.js";
import { checkOwnership, taskUnitKey } from "../unit-ownership.js";
import { saveFile, clearParseCache } from "../files.js";
import { invalidateStateCache } from "../state.js";
import { renderPlanCheckboxes } from "../markdown-renderer.js";
import { renderAllProjections } from "../workflow-projections.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";

export interface CompleteTaskResult {
  taskId: string;
  sliceId: string;
  milestoneId: string;
  summaryPath: string;
}

/**
 * Render task summary markdown matching the template format.
 * YAML frontmatter uses snake_case keys for parseSummary() compatibility.
 */
function renderSummaryMarkdown(params: CompleteTaskParams): string {
  const now = new Date().toISOString();
  const keyFilesYaml = params.keyFiles.length > 0
    ? params.keyFiles.map(f => `  - ${f}`).join("\n")
    : "  - (none)";
  const keyDecisionsYaml = params.keyDecisions.length > 0
    ? params.keyDecisions.map(d => `  - ${d}`).join("\n")
    : "  - (none)";

  // Build verification evidence table rows
  let evidenceTable = "| # | Command | Exit Code | Verdict | Duration |\n|---|---------|-----------|---------|----------|\n";
  if (params.verificationEvidence.length > 0) {
    params.verificationEvidence.forEach((e, i) => {
      evidenceTable += `| ${i + 1} | \`${e.command}\` | ${e.exitCode} | ${e.verdict} | ${e.durationMs}ms |\n`;
    });
  } else {
    evidenceTable += "| — | No verification commands discovered | — | — | — |\n";
  }

  // Determine verification_result from evidence
  const allPassed = params.verificationEvidence.length > 0 &&
    params.verificationEvidence.every(e => e.exitCode === 0 || e.verdict.includes("✅") || e.verdict.toLowerCase().includes("pass"));
  const verificationResult = allPassed ? "passed" : (params.verificationEvidence.length === 0 ? "untested" : "mixed");

  // Extract a title from the oneLiner or taskId
  const title = params.oneLiner || params.taskId;

  return `---
id: ${params.taskId}
parent: ${params.sliceId}
milestone: ${params.milestoneId}
key_files:
${keyFilesYaml}
key_decisions:
${keyDecisionsYaml}
duration: ""
verification_result: ${verificationResult}
completed_at: ${now}
blocker_discovered: ${params.blockerDiscovered}
---

# ${params.taskId}: ${title}

**${params.oneLiner}**

## What Happened

${params.narrative}

## Verification

${params.verification}

## Verification Evidence

${evidenceTable}

## Deviations

${params.deviations || "None."}

## Known Issues

${params.knownIssues || "None."}

## Files Created/Modified

${params.keyFiles.map(f => `- \`${f}\``).join("\n") || "None."}
`;
}

/**
 * Handle the complete_task operation end-to-end.
 *
 * 1. Validate required fields
 * 2. Write DB in a transaction (milestone, slice, task, verification evidence)
 * 3. Render SUMMARY.md to disk
 * 4. Toggle plan checkbox
 * 5. Store rendered markdown back in DB (for D004 recovery)
 * 6. Invalidate caches
 */
export async function handleCompleteTask(
  params: CompleteTaskParams,
  basePath: string,
): Promise<CompleteTaskResult | { error: string }> {
  // ── Validate required fields ────────────────────────────────────────────
  if (!params.taskId || typeof params.taskId !== "string" || params.taskId.trim() === "") {
    return { error: "taskId is required and must be a non-empty string" };
  }
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
    return { error: `cannot complete task in a closed milestone: ${params.milestoneId} (status: ${milestone.status})` };
  }

  const slice = getSlice(params.milestoneId, params.sliceId);
  if (!slice) {
    return { error: `slice not found: ${params.milestoneId}/${params.sliceId}` };
  }
  if (slice.status === "complete" || slice.status === "done") {
    return { error: `cannot complete task in a closed slice: ${params.sliceId} (status: ${slice.status})` };
  }

  const existingTask = getTask(params.milestoneId, params.sliceId, params.taskId);
  if (existingTask && (existingTask.status === "complete" || existingTask.status === "done")) {
    return { error: `task ${params.taskId} is already complete — use gsd_task_reopen first if you need to redo it` };
  }

  // ── Ownership check (opt-in: only enforced when claim file exists) ──────
  const ownershipErr = checkOwnership(
    basePath,
    taskUnitKey(params.milestoneId, params.sliceId, params.taskId),
    params.actorName,
  );
  if (ownershipErr) {
    return { error: ownershipErr };
  }

  // ── DB writes inside a transaction ──────────────────────────────────────
  const completedAt = new Date().toISOString();

  transaction(() => {
    insertMilestone({ id: params.milestoneId });
    insertSlice({ id: params.sliceId, milestoneId: params.milestoneId });
    insertTask({
      id: params.taskId,
      sliceId: params.sliceId,
      milestoneId: params.milestoneId,
      title: params.oneLiner,
      status: "complete",
      oneLiner: params.oneLiner,
      narrative: params.narrative,
      verificationResult: params.verification,
      duration: "",
      blockerDiscovered: params.blockerDiscovered,
      deviations: params.deviations,
      knownIssues: params.knownIssues,
      keyFiles: params.keyFiles,
      keyDecisions: params.keyDecisions,
    });

    for (const evidence of params.verificationEvidence) {
      insertVerificationEvidence({
        taskId: params.taskId,
        sliceId: params.sliceId,
        milestoneId: params.milestoneId,
        command: evidence.command,
        exitCode: evidence.exitCode,
        verdict: evidence.verdict,
        durationMs: evidence.durationMs,
      });
    }
  });

  // ── Filesystem operations (outside transaction) ─────────────────────────
  // If disk render fails, roll back the DB status so deriveState() and
  // verifyExpectedArtifact() stay consistent (both say "not done").

  // Render summary markdown
  const summaryMd = renderSummaryMarkdown(params);

  // Resolve and write summary to disk
  let summaryPath: string;
  const tasksDir = resolveTasksDir(basePath, params.milestoneId, params.sliceId);
  if (tasksDir) {
    summaryPath = join(tasksDir, `${params.taskId}-SUMMARY.md`);
  } else {
    // Tasks dir doesn't exist on disk yet — build path manually and ensure dirs
    const gsdDir = join(basePath, ".gsd");
    const manualTasksDir = join(gsdDir, "milestones", params.milestoneId, "slices", params.sliceId, "tasks");
    mkdirSync(manualTasksDir, { recursive: true });
    summaryPath = join(manualTasksDir, `${params.taskId}-SUMMARY.md`);
  }

  try {
    await saveFile(summaryPath, summaryMd);

    // Toggle plan checkbox via renderer module
    const planPath = resolveSliceFile(basePath, params.milestoneId, params.sliceId, "PLAN");
    if (planPath) {
      await renderPlanCheckboxes(basePath, params.milestoneId, params.sliceId);
    } else {
      process.stderr.write(
        `gsd-db: complete_task — could not find plan file for ${params.sliceId}/${params.milestoneId}, skipping checkbox toggle\n`,
      );
    }
  } catch (renderErr) {
    // Disk render failed — roll back DB status so state stays consistent
    process.stderr.write(
      `gsd-db: complete_task — disk render failed, rolling back DB status: ${(renderErr as Error).message}\n`,
    );
    const rollbackAdapter = _getAdapter();
    if (rollbackAdapter) {
      rollbackAdapter.prepare(
        `UPDATE tasks SET status = 'pending' WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`,
      ).run({
        ":mid": params.milestoneId,
        ":sid": params.sliceId,
        ":tid": params.taskId,
      });
    }
    invalidateStateCache();
    return { error: `disk render failed: ${(renderErr as Error).message}` };
  }

  // Store rendered markdown in DB for D004 recovery
  const adapter = _getAdapter();
  if (adapter) {
    adapter.prepare(
      `UPDATE tasks SET full_summary_md = :md WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`,
    ).run({
      ":md": summaryMd,
      ":mid": params.milestoneId,
      ":sid": params.sliceId,
      ":tid": params.taskId,
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
      cmd: "complete-task",
      params: { milestoneId: params.milestoneId, sliceId: params.sliceId, taskId: params.taskId },
      ts: new Date().toISOString(),
      actor: "agent",
      actor_name: params.actorName,
      trigger_reason: params.triggerReason,
    });
  } catch (hookErr) {
    process.stderr.write(
      `gsd: complete-task post-mutation hook warning: ${(hookErr as Error).message}\n`,
    );
  }

  return {
    taskId: params.taskId,
    sliceId: params.sliceId,
    milestoneId: params.milestoneId,
    summaryPath,
  };
}
