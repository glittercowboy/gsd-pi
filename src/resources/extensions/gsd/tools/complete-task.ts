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
import { isClosedStatus } from "../status-guards.js";
import {
  transaction,
  insertMilestone,
  insertSlice,
  insertTask,
  insertVerificationEvidence,
  getMilestone,
  getSlice,
  getTask,
  updateTaskStatus,
  setTaskSummaryMd,
  deleteVerificationEvidence,
} from "../gsd-db.js";
import { resolveSliceFile, resolveTasksDir, clearPathCache } from "../paths.js";
import { checkOwnership, taskUnitKey } from "../unit-ownership.js";
import { saveFile, clearParseCache } from "../files.js";
import { invalidateStateCache } from "../state.js";
import { renderPlanCheckboxes } from "../markdown-renderer.js";
import { renderAllProjections, renderSummaryContent } from "../workflow-projections.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning, logError } from "../workflow-logger.js";

export interface CompleteTaskResult {
  taskId: string;
  sliceId: string;
  milestoneId: string;
  summaryPath: string;
}

import type { TaskRow } from "../gsd-db.js";

/**
 * Normalize a list parameter that may arrive as a string (newline-delimited
 * bullet list from the LLM) into a string array (#3361).
 */
function normalizeListParam(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim()) {
    return value.split(/\n/).map(s => s.replace(/^[\s\-*•]+/, "").trim()).filter(Boolean);
  }
  return [];
}

/**
 * Build a TaskRow-shaped object from CompleteTaskParams so the unified
 * renderSummaryContent() can be used at completion time (#2720).
 */
function paramsToTaskRow(params: CompleteTaskParams, completedAt: string): TaskRow {
  return {
    milestone_id: params.milestoneId,
    slice_id: params.sliceId,
    id: params.taskId,
    title: params.oneLiner || params.taskId,
    status: "complete",
    one_liner: params.oneLiner,
    narrative: params.narrative,
    verification_result: params.verification,
    duration: "",
    completed_at: completedAt,
    blocker_discovered: params.blockerDiscovered ?? false,
    deviations: params.deviations ?? "",
    known_issues: params.knownIssues ?? "",
    key_files: normalizeListParam(params.keyFiles),
    key_decisions: normalizeListParam(params.keyDecisions),
    full_summary_md: "",
    description: "",
    estimate: "",
    files: [],
    verify: "",
    inputs: [],
    expected_output: [],
    observability_impact: "",
    full_plan_md: "",
    sequence: 0,
  };
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

  // ── Ownership check (opt-in: only enforced when claim file exists) ──────
  const ownershipErr = checkOwnership(
    basePath,
    taskUnitKey(params.milestoneId, params.sliceId, params.taskId),
    params.actorName,
  );
  if (ownershipErr) {
    return { error: ownershipErr };
  }

  // ── Guards + DB writes inside a single transaction (prevents TOCTOU) ───
  const completedAt = new Date().toISOString();
  let guardError: string | null = null;

  transaction(() => {
    // State machine preconditions (inside txn for atomicity).
    // Milestone/slice not existing is OK — insertMilestone/insertSlice below will auto-create.
    // Only block if they exist and are closed.
    const milestone = getMilestone(params.milestoneId);
    if (milestone && isClosedStatus(milestone.status)) {
      guardError = `cannot complete task in a closed milestone: ${params.milestoneId} (status: ${milestone.status})`;
      return;
    }

    const slice = getSlice(params.milestoneId, params.sliceId);
    if (slice && isClosedStatus(slice.status)) {
      guardError = `cannot complete task in a closed slice: ${params.sliceId} (status: ${slice.status})`;
      return;
    }

    const existingTask = getTask(params.milestoneId, params.sliceId, params.taskId);
    if (existingTask && isClosedStatus(existingTask.status)) {
      guardError = `task ${params.taskId} is already complete — use gsd_task_reopen first if you need to redo it`;
      return;
    }

    // All guards passed — perform writes
    insertMilestone({ id: params.milestoneId, title: params.milestoneId });
    insertSlice({ id: params.sliceId, milestoneId: params.milestoneId, title: params.sliceId });
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
      blockerDiscovered: params.blockerDiscovered ?? false,
      deviations: params.deviations ?? "None.",
      knownIssues: params.knownIssues ?? "None.",
      keyFiles: params.keyFiles ?? [],
      keyDecisions: params.keyDecisions ?? [],
    });

    for (const evidence of (params.verificationEvidence ?? [])) {
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

  if (guardError) {
    return { error: guardError };
  }

  // ── Filesystem operations (outside transaction) ─────────────────────────
  // If disk render fails, roll back the DB status so deriveState() and
  // verifyExpectedArtifact() stay consistent (both say "not done").

  // Render summary markdown via the single source of truth (#2720)
  const taskRow = paramsToTaskRow(params, completedAt);
  const summaryMd = renderSummaryContent(taskRow, params.sliceId, params.milestoneId, params.verificationEvidence ?? []);

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
    logWarning("tool", `complete_task — disk render failed, rolling back DB status: ${(renderErr as Error).message}`);
    // Delete orphaned verification_evidence rows first (FK constraint
    // references tasks, so evidence must go before status change).
    // Without this, retries accumulate duplicate evidence rows (#2724).
    deleteVerificationEvidence(params.milestoneId, params.sliceId, params.taskId);
    updateTaskStatus(params.milestoneId, params.sliceId, params.taskId, 'pending');
    invalidateStateCache();
    return { error: `disk render failed: ${(renderErr as Error).message}` };
  }

  // Store rendered markdown in DB for D004 recovery
  setTaskSummaryMd(params.milestoneId, params.sliceId, params.taskId, summaryMd);

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
    logWarning("tool", `complete-task projection warning: ${(projErr as Error).message}`);
  }
  try {
    writeManifest(basePath);
  } catch (mfErr) {
    logWarning("tool", `complete-task manifest warning: ${(mfErr as Error).message}`);
  }
  try {
    appendEvent(basePath, {
      cmd: "complete-task",
      params: { milestoneId: params.milestoneId, sliceId: params.sliceId, taskId: params.taskId },
      ts: new Date().toISOString(),
      actor: "agent",
      actor_name: params.actorName,
      trigger_reason: params.triggerReason,
    });
  } catch (eventErr) {
    logError("tool", `complete-task event log FAILED — completion invisible to reconciliation`, { error: (eventErr as Error).message });
  }

  return {
    taskId: params.taskId,
    sliceId: params.sliceId,
    milestoneId: params.milestoneId,
    summaryPath,
  };
}
