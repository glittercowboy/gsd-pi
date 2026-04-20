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
  saveGateResult,
  getPendingGatesForTurn,
} from "../gsd-db.js";
import { getGatesForTurn } from "../gate-registry.js";
import { resolveSliceFile, resolveTasksDir, clearPathCache } from "../paths.js";
import { checkOwnership, taskUnitKey } from "../unit-ownership.js";
import { saveFile, clearParseCache } from "../files.js";
import { invalidateStateCache } from "../state.js";
import { renderPlanCheckboxes } from "../markdown-renderer.js";
import { renderAllProjections, renderSummaryContent } from "../workflow-projections.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning, logError } from "../workflow-logger.js";
import { loadEffectiveGSDPreferences } from "../preferences.js";
import { buildEscalationArtifact, writeEscalationArtifact } from "../escalation.js";

export interface CompleteTaskResult {
  taskId: string;
  sliceId: string;
  milestoneId: string;
  summaryPath: string;
}

import type { TaskRow } from "../gsd-db.js";

/**
 * Map an execute-task-owned gate id to the CompleteTaskParams field whose
 * presence drives `pass` vs. `omitted`. Keep in lockstep with the gates
 * declared in gate-registry.ts under ownerTurn "execute-task".
 */
function taskGateFieldForId(
  id: string,
  params: CompleteTaskParams,
): string | undefined {
  switch (id) {
    case "Q5":
      return params.failureModes;
    case "Q6":
      return params.loadProfile;
    case "Q7":
      return params.negativeTests;
    default:
      return undefined;
  }
}

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
    blocker_source: "",
    escalation_pending: 0,
    escalation_awaiting_review: 0,
    escalation_artifact_path: null,
    escalation_override_applied_at: null,
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

  // ── ADR-011 Phase 2: validate escalation payload BEFORE any side effects ─
  // Building the artifact runs the full shape validation (2-4 options, unique
  // ids, recommendation references a real id). If the payload is malformed
  // we must reject the call before marking the task complete, writing
  // SUMMARY.md, flipping the plan checkbox, or closing execute-task gates —
  // otherwise a rejected payload would leave the task marked complete with
  // no escalation recorded, and the loop would silently advance past it.
  // The filesystem write happens later (after side effects) because that's
  // the cheapest ordering and validation is where 99% of failures live.
  let validatedEscalationArtifact: ReturnType<typeof buildEscalationArtifact> | null = null;
  let escalationWriteEnabled = false;
  if (params.escalation) {
    escalationWriteEnabled = loadEffectiveGSDPreferences()?.preferences?.phases?.mid_execution_escalation === true;
    if (escalationWriteEnabled) {
      try {
        validatedEscalationArtifact = buildEscalationArtifact({
          taskId: params.taskId,
          sliceId: params.sliceId,
          milestoneId: params.milestoneId,
          question: params.escalation.question,
          options: params.escalation.options,
          recommendation: params.escalation.recommendation,
          recommendationRationale: params.escalation.recommendationRationale,
          continueWithDefault: params.escalation.continueWithDefault,
        });
      } catch (validationErr) {
        return {
          error: `complete-task escalation payload invalid for ${params.milestoneId}/${params.sliceId}/${params.taskId}: ${(validationErr as Error).message}`,
        };
      }
    }
  }

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

  // ── Close gates owned by execute-task (Q5/Q6/Q7) for this task ────────
  // Each gate id maps to a specific params field via taskGateFieldForId.
  // When the model populates the field, record `pass`; when it's empty,
  // record `omitted`. Task-scoped rows are filtered by taskId so a single
  // task's completion doesn't touch sibling tasks' gate rows.
  try {
    const pendingGates = getPendingGatesForTurn(
      params.milestoneId,
      params.sliceId,
      "execute-task",
      params.taskId,
    );
    if (pendingGates.length > 0) {
      const ownedDefs = new Map(getGatesForTurn("execute-task").map((g) => [g.id, g] as const));
      for (const row of pendingGates) {
        const def = ownedDefs.get(row.gate_id);
        if (!def) continue;
        const field = taskGateFieldForId(def.id, params);
        const hasContent = typeof field === "string" && field.trim().length > 0;
        saveGateResult({
          milestoneId: params.milestoneId,
          sliceId: params.sliceId,
          taskId: params.taskId,
          gateId: def.id,
          verdict: hasContent ? "pass" : "omitted",
          rationale: hasContent
            ? `${def.promptSection} section populated in task summary`
            : `${def.promptSection} section left empty — recorded as omitted`,
          findings: hasContent ? (field as string).trim() : "",
        });
      }
    }
  } catch (gateErr) {
    logWarning(
      "tool",
      `complete-task gate close warning for ${params.milestoneId}/${params.sliceId}/${params.taskId}: ${(gateErr as Error).message}`,
    );
  }

  // ── ADR-011 Phase 2: write escalation artifact (opt-in) ────────────────
  // Validation already happened BEFORE side effects — this block only
  // performs the disk write for a pre-validated artifact. For
  // continueWithDefault=false, a write failure here would otherwise leave
  // the task marked complete with SUMMARY.md + closed gates but no
  // escalation, which silently advances the loop past a pause the user
  // asked for. We compensate by reverting the DB-level completion: set
  // status back to 'pending' and delete the verification_evidence rows
  // (same shape as the disk-render-failure rollback above). SUMMARY.md
  // on disk is left in place because the next complete-task retry will
  // overwrite it; gate rows are UPSERT-keyed per task and will also be
  // overwritten. This restores the invariant that deriveState() sees a
  // consistent "task not done" view so the loop re-dispatches the task.
  if (validatedEscalationArtifact) {
    try {
      writeEscalationArtifact(basePath, validatedEscalationArtifact);
    } catch (escalationErr) {
      const msg = `complete-task escalation write failed for ${params.milestoneId}/${params.sliceId}/${params.taskId}: ${(escalationErr as Error).message}`;
      logWarning("tool", msg);
      if (validatedEscalationArtifact.continueWithDefault === false) {
        // Compensating rollback: revert DB completion so the loop pauses on
        // re-dispatch instead of silently advancing. Mirror the existing
        // renderErr rollback (line ~261).
        try {
          deleteVerificationEvidence(params.milestoneId, params.sliceId, params.taskId);
          updateTaskStatus(params.milestoneId, params.sliceId, params.taskId, 'pending');
          invalidateStateCache();
          logWarning(
            "tool",
            `complete-task rolled back DB completion for ${params.milestoneId}/${params.sliceId}/${params.taskId} after escalation write failure; SUMMARY.md left on disk for retry.`,
          );
        } catch (rollbackErr) {
          logWarning(
            "tool",
            `complete-task rollback failed after escalation write failure for ${params.milestoneId}/${params.sliceId}/${params.taskId}: ${(rollbackErr as Error).message}`,
          );
        }
        return { error: msg };
      }
    }
  } else if (params.escalation && !escalationWriteEnabled) {
    logWarning(
      "tool",
      `complete-task received escalation payload but phases.mid_execution_escalation is not enabled; ignoring (${params.milestoneId}/${params.sliceId}/${params.taskId})`,
    );
  }

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
