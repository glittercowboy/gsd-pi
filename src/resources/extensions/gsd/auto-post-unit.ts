/**
 * Post-unit processing for handleAgentEnd — auto-commit, doctor run,
 * state rebuild, worktree sync, DB dual-write, hooks, triage, and
 * quick-task dispatch.
 *
 * Split into two functions called sequentially by handleAgentEnd with
 * the verification gate between them:
 *   1. postUnitPreVerification() — commit, doctor, state rebuild, worktree sync, artifact verification
 *   2. postUnitPostVerification() — DB dual-write, hooks, triage, quick-tasks
 *
 * Extracted from handleAgentEnd() in auto.ts.
 */

import type { ExtensionContext, ExtensionAPI } from "@gsd/pi-coding-agent";
import { deriveState } from "./state.js";
import { logWarning, logError } from "./workflow-logger.js";
import { loadFile, parseSummary, resolveAllOverrides } from "./files.js";
import { loadPrompt } from "./prompt-loader.js";
import {
  resolveSliceFile,
  resolveSlicePath,
  resolveTaskFile,
  resolveMilestoneFile,
  resolveTasksDir,
  buildTaskFileName,
} from "./paths.js";
import { invalidateAllCaches } from "./cache.js";
import { parseUnitId } from "./unit-id.js";
import { closeoutUnit, type CloseoutOptions } from "./auto-unit-closeout.js";
import {
  autoCommitCurrentBranch,
  type TaskCommitContext,
} from "./worktree.js";
import {
  verifyExpectedArtifact,
  resolveExpectedArtifactPath,
  writeBlockerPlaceholder,
  diagnoseExpectedArtifact,
} from "./auto-recovery.js";
import { regenerateIfMissing } from "./workflow-projections.js";
import { syncStateToProjectRoot } from "./auto-worktree.js";
import { isDbAvailable, getTask, getSlice, getMilestone, updateTaskStatus, updateSliceStatus, _getAdapter } from "./gsd-db.js";
import { renderPlanCheckboxes } from "./markdown-renderer.js";
import { consumeSignal } from "./session-status-io.js";
import {
  checkPostUnitHooks,
  isRetryPending,
  consumeRetryTrigger,
  persistHookState,
  resolveHookArtifactPath,
} from "./post-unit-hooks.js";
import { hasPendingCaptures, loadPendingCaptures, revertExecutorResolvedCaptures } from "./captures.js";
import { debugLog } from "./debug-logger.js";
import { runSafely } from "./auto-utils.js";
import type { AutoSession, SidecarItem } from "./auto/session.js";
import { getEvidence } from "./safety/evidence-collector.js";
import { validateFileChanges } from "./safety/file-change-validator.js";
// crossReferenceEvidence available for future use when verification_evidence is stored in DB
// import { crossReferenceEvidence, type ClaimedEvidence } from "./safety/evidence-cross-ref.js";
import { validateContent } from "./safety/content-validator.js";
import { resolveSafetyHarnessConfig } from "./safety/safety-harness.js";
import { resolveExpectedArtifactPath as resolveArtifactForContent } from "./auto-artifact-paths.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { getSliceTasks } from "./gsd-db.js";
import { runPreExecutionChecks, type PreExecutionResult } from "./pre-execution-checks.js";
import { writePreExecutionEvidence } from "./verification-evidence.js";
import { ensureCodebaseMapFresh } from "./codebase-generator.js";

/** Maximum verification retry attempts before escalating to blocker placeholder (#2653). */
const MAX_VERIFICATION_RETRIES = 3;


/** Enqueue a sidecar item (hook, triage, or quick-task) for the main loop to
 *  drain via runUnit. Logs the enqueue event and notifies the UI. */
function enqueueSidecar(
  s: AutoSession,
  ctx: ExtensionContext,
  entry: SidecarItem,
  debugExtra: Record<string, unknown>,
  notification?: string,
): "continue" {
  s.sidecarQueue.push(entry);
  debugLog("postUnitPostVerification", {
    phase: "sidecar-enqueue",
    kind: entry.kind,
    unitId: entry.unitId,
    ...debugExtra,
  });
  if (notification) ctx.ui.notify(notification, "info");
  return "continue";
}
/** Unit types that only touch `.gsd/` internal state files (no code changes).
 *  Auto-commit is skipped for these — their state files are picked up by the
 *  next actual task commit via `smartStage()`. */
const LIFECYCLE_ONLY_UNITS = new Set([
  "research-milestone", "discuss-milestone", "discuss-slice", "plan-milestone",
  "validate-milestone", "research-slice", "plan-slice",
  "replan-slice", "complete-slice", "run-uat",
  "reassess-roadmap", "rewrite-docs",
]);
import {
  updateProgressWidget as _updateProgressWidget,
  updateSliceProgressCache,
  unitVerb,
  hideFooter,
} from "./auto-dashboard.js";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { _resetHasChangesCache } from "./native-git-bridge.js";

// ─── Rogue File Detection ──────────────────────────────────────────────────

export interface RogueFileWrite {
  path: string;
  unitType: string;
  unitId: string;
}

/**
 * Detect summary files written directly to disk without the LLM calling
 * the completion tool. A "rogue" file is one that exists on disk but has
 * no corresponding DB row with status "complete".
 *
 * This is a safety-net diagnostic (D003). The existing migrateFromMarkdown()
 * in postUnitPostVerification() eventually ingests rogue files, but explicit
 * detection provides immediate diagnostics so operators know the prompt failed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hasNonEmptyFields(row: Record<string, any> | null, fields: string[]): boolean {
  if (!row) return false;
  return fields.some(f => String(row[f] || "").trim().length > 0);
}

const MILESTONE_PLANNING_FIELDS = ["title", "vision", "requirement_coverage", "boundary_map_markdown"];
const SLICE_PLANNING_FIELDS = ["title", "demo", "risk", "depends"];

export function detectRogueFileWrites(
  unitType: string,
  unitId: string,
  basePath: string,
): RogueFileWrite[] {
  if (!isDbAvailable()) return [];

  const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
  const rogues: RogueFileWrite[] = [];

  if (unitType === "execute-task") {
    if (!mid || !sid || !tid) return [];

    const summaryPath = resolveTaskFile(basePath, mid, sid, tid, "SUMMARY");
    if (!summaryPath || !existsSync(summaryPath)) return [];

    const dbRow = getTask(mid, sid, tid);
    if (!dbRow || dbRow.status !== "complete") {
      rogues.push({ path: summaryPath, unitType, unitId });
    }
  } else if (unitType === "complete-slice") {
    if (!mid || !sid) return [];

    const summaryPath = resolveSliceFile(basePath, mid, sid, "SUMMARY");
    if (!summaryPath || !existsSync(summaryPath)) return [];

    const dbRow = getSlice(mid, sid);
    if (!dbRow || dbRow.status !== "complete") {
      // Auto-remediate: SUMMARY exists on disk but DB is stale — sync DB to
      // match filesystem instead of reporting as rogue (#3633).
      try {
        updateSliceStatus(mid, sid, "complete", new Date().toISOString());
      } catch {
        // If DB update fails, fall back to rogue detection so the issue is visible
        rogues.push({ path: summaryPath, unitType, unitId });
      }
    }
  } else if (unitType === "plan-milestone") {
    if (!mid) return [];

    const roadmapPath = resolveMilestoneFile(basePath, mid, "ROADMAP");
    if (!roadmapPath || !existsSync(roadmapPath)) return [];

    const dbRow = getMilestone(mid);
    const hasPlanningState = hasNonEmptyFields(dbRow, MILESTONE_PLANNING_FIELDS);

    if (!hasPlanningState) {
      rogues.push({ path: roadmapPath, unitType, unitId });
    }
  } else if (unitType === "plan-slice" || unitType === "replan-slice") {
    if (!mid || !sid) return [];

    const planPath = resolveSliceFile(basePath, mid, sid, "PLAN");
    if (!planPath || !existsSync(planPath)) return [];

    const dbRow = getSlice(mid, sid);
    const hasPlanningState = hasNonEmptyFields(dbRow, SLICE_PLANNING_FIELDS);

    if (!hasPlanningState) {
      rogues.push({ path: planPath, unitType, unitId });
    }

    // Also check for rogue REPLAN.md
    const replanPath = resolveSliceFile(basePath, mid, sid, "REPLAN");
    if (replanPath && existsSync(replanPath) && !hasPlanningState) {
      rogues.push({ path: replanPath, unitType, unitId });
    }
  } else if (unitType === "reassess-roadmap") {
    if (!mid || !sid) return [];

    const assessPath = resolveSliceFile(basePath, mid, sid, "ASSESSMENT");
    if (!assessPath || !existsSync(assessPath)) return [];

    // Assessment file exists on disk — check if DB knows about it via the artifacts table
    const adapter = _getAdapter();
    if (adapter) {
      const row = adapter.prepare(
        `SELECT 1 FROM artifacts WHERE path LIKE :pattern AND artifact_type = 'ASSESSMENT' LIMIT 1`,
      ).get({ ":pattern": `%${sid}-ASSESSMENT.md` });
      if (!row) {
        rogues.push({ path: assessPath, unitType, unitId });
      }
    }
  } else if (unitType === "plan-task") {
    if (!mid || !sid || !tid) return [];

    const taskPlanPath = resolveTaskFile(basePath, mid, sid, tid, "PLAN");
    if (!taskPlanPath || !existsSync(taskPlanPath)) return [];

    const dbRow = getTask(mid, sid, tid);
    if (!dbRow) {
      rogues.push({ path: taskPlanPath, unitType, unitId });
    }
  }

  return rogues;
}

export interface PreVerificationOpts {
  skipSettleDelay?: boolean;
  skipWorktreeSync?: boolean;
}

export interface PostUnitContext {
  s: AutoSession;
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  buildSnapshotOpts: (unitType: string, unitId: string) => CloseoutOptions & Record<string, unknown>;
  lockBase: () => string;
  stopAuto: (ctx?: ExtensionContext, pi?: ExtensionAPI, reason?: string) => Promise<void>;
  pauseAuto: (ctx?: ExtensionContext, pi?: ExtensionAPI) => Promise<void>;
  updateProgressWidget: (ctx: ExtensionContext, unitType: string, unitId: string, state: import("./types.js").GSDState) => void;
}

/**
 * Pre-verification processing: parallel worker signal check, cache invalidation,
 * auto-commit, doctor run, state rebuild, worktree sync, artifact verification.
 *
 * Returns:
 * - "dispatched" — a signal caused stop/pause
 * - "continue" — proceed normally
 * - "retry" — artifact verification failed, s.pendingVerificationRetry set for loop re-iteration
 */
export async function postUnitPreVerification(pctx: PostUnitContext, opts?: PreVerificationOpts): Promise<"dispatched" | "continue" | "retry"> {
  const { s, ctx, pi, buildSnapshotOpts, stopAuto, pauseAuto } = pctx;

  // ── Parallel worker signal check ──
  const milestoneLock = process.env.GSD_MILESTONE_LOCK;
  if (milestoneLock) {
    const signal = consumeSignal(s.basePath, milestoneLock);
    if (signal) {
      if (signal.signal === "stop") {
        await stopAuto(ctx, pi);
        return "dispatched";
      }
      if (signal.signal === "pause") {
        await pauseAuto(ctx, pi);
        return "dispatched";
      }
    }
  }

  // Invalidate all caches
  invalidateAllCaches();

  // Small delay to let files settle (skipped for sidecars where latency matters more)
  if (!opts?.skipSettleDelay) {
    await new Promise(r => setTimeout(r, 100));
  }

  // Auto-commit
  if (s.currentUnit) {
    const unit = s.currentUnit;
    try {
      let taskContext: TaskCommitContext | undefined;

      if (s.currentUnit.type === "execute-task") {
        const { milestone: mid, slice: sid, task: tid } = parseUnitId(s.currentUnit.id);
        if (mid && sid && tid) {
          const summaryPath = resolveTaskFile(s.basePath, mid, sid, tid, "SUMMARY");
          if (summaryPath) {
            try {
              const summaryContent = await loadFile(summaryPath);
              if (summaryContent) {
                const summary = parseSummary(summaryContent);
                // Look up GitHub issue number for commit linking
                let ghIssueNumber: number | undefined;
                try {
                  const { getTaskIssueNumberForCommit } = await import("../github-sync/sync.js");
                  ghIssueNumber = getTaskIssueNumberForCommit(s.basePath, mid, sid, tid) ?? undefined;
                } catch (err) {
                  // GitHub sync not available — skip
                  logWarning("engine", `GitHub issue lookup failed: ${err instanceof Error ? err.message : String(err)}`);
                }

                taskContext = {
                  taskId: `${sid}/${tid}`,
                  taskTitle: summary.title?.replace(/^T\d+:\s*/, "") || tid,
                  oneLiner: summary.oneLiner || undefined,
                  keyFiles: summary.frontmatter.key_files?.filter(f => !f.includes("{{")) || undefined,
                  issueNumber: ghIssueNumber,
                };
              }
            } catch (e) {
              debugLog("postUnit", { phase: "task-summary-parse", error: String(e) });
            }
          }
        }
      }

      // Invalidate the nativeHasChanges cache before auto-commit (#1853).
      // The cache has a 10-second TTL and is keyed by basePath.  A stale
      // `false` result causes autoCommit to skip staging entirely, leaving
      // code files only in the working tree where they are destroyed by
      // `git worktree remove --force` during teardown.
      _resetHasChangesCache();

      // Skip auto-commit for lifecycle-only units (#2553) — they only touch
      // `.gsd/` internal state files. Those files are picked up by the next
      // actual task commit via smartStage().
      if (!LIFECYCLE_ONLY_UNITS.has(s.currentUnit.type)) {
        const commitMsg = autoCommitCurrentBranch(s.basePath, s.currentUnit.type, s.currentUnit.id, taskContext);
        if (commitMsg) {
          ctx.ui.notify(`Committed: ${commitMsg.split("\n")[0]}`, "info");
        }
      }
    } catch (e) {
      debugLog("postUnit", { phase: "auto-commit", error: String(e) });
      ctx.ui.notify(`Auto-commit failed: ${String(e).split("\n")[0]}`, "warning");
    }

    // GitHub sync (non-blocking, opt-in)
    await runSafely("postUnit", "github-sync", async () => {
      const { runGitHubSync } = await import("../github-sync/sync.js");
      await runGitHubSync(s.basePath, unit.type, unit.id);
    });

    // Prune dead bg-shell processes
    await runSafely("postUnit", "prune-bg-shell", async () => {
      const { pruneDeadProcesses } = await import("../bg-shell/process-manager.js");
      pruneDeadProcesses();
    });

    // Tear down browser between units to prevent Chrome process accumulation (#1733)
    await runSafely("postUnit", "browser-teardown", async () => {
      const { getBrowser } = await import("../browser-tools/state.js");
      if (getBrowser()) {
        const { closeBrowser } = await import("../browser-tools/lifecycle.js");
        await closeBrowser();
        debugLog("postUnit", { phase: "browser-teardown", status: "closed" });
      }
    });

    // Sync worktree state back to project root (skipped for lightweight sidecars)
    if (!opts?.skipWorktreeSync && s.originalBasePath && s.originalBasePath !== s.basePath) {
      await runSafely("postUnit", "worktree-sync", () => {
        syncStateToProjectRoot(s.basePath, s.originalBasePath!, s.currentMilestoneId);
      });
    }

    // Rewrite-docs completion
    if (s.currentUnit.type === "rewrite-docs") {
      await runSafely("postUnit", "rewrite-docs-resolve", async () => {
        await resolveAllOverrides(s.basePath);
        // Reset both disk and in-memory counters. Disk counter is authoritative
        // (survives restarts); in-memory is kept in sync for the current session.
        const { setRewriteCount } = await import("./auto-dispatch.js");
        setRewriteCount(s.basePath, 0);
        s.rewriteAttemptCount = 0;
        ctx.ui.notify("Override(s) resolved — rewrite-docs completed.", "info");
      });
    }

    // Reactive state cleanup on slice completion
    if (s.currentUnit.type === "complete-slice") {
      await runSafely("postUnit", "reactive-state-cleanup", async () => {
        const { milestone: mid, slice: sid } = parseUnitId(unit.id);
        if (mid && sid) {
          const { clearReactiveState } = await import("./reactive-graph.js");
          clearReactiveState(s.basePath, mid, sid);
        }
      });
    }

    // Post-triage: execute actionable resolutions
    if (s.currentUnit.type === "triage-captures") {
      try {
        const { executeTriageResolutions } = await import("./triage-resolution.js");
        const state = await deriveState(s.basePath);
        const mid = state.activeMilestone?.id ?? "";
        const sid = state.activeSlice?.id ?? "";

        // executeTriageResolutions handles defer milestone creation even
        // without an active milestone/slice (the "all milestones complete"
        // scenario from #1562). inject/replan/quick-task still require mid+sid.
        const triageResult = executeTriageResolutions(s.basePath, mid, sid);

        if (triageResult.injected > 0) {
          ctx.ui.notify(
            `Triage: injected ${triageResult.injected} task${triageResult.injected === 1 ? "" : "s"} into ${sid} plan.`,
            "info",
          );
        }
        if (triageResult.replanned > 0) {
          ctx.ui.notify(
            `Triage: replan trigger written for ${sid} — next dispatch will enter replanning.`,
            "info",
          );
        }
        if (triageResult.deferredMilestones > 0) {
          ctx.ui.notify(
            `Triage: created ${triageResult.deferredMilestones} deferred milestone director${triageResult.deferredMilestones === 1 ? "y" : "ies"}.`,
            "info",
          );
        }
        if (triageResult.quickTasks.length > 0) {
          for (const qt of triageResult.quickTasks) {
            s.pendingQuickTasks.push(qt);
          }
          ctx.ui.notify(
            `Triage: ${triageResult.quickTasks.length} quick-task${triageResult.quickTasks.length === 1 ? "" : "s"} queued for execution.`,
            "info",
          );
        }
        for (const action of triageResult.actions) {
          logWarning("engine", `triage resolution: ${action}`);
        }
      } catch (err) {
        logError("engine", "triage resolution failed", { error: (err as Error).message });
      }
    }

    // Rogue file detection — safety net for LLM bypassing completion tools (D003)
    try {
      const rogueFiles = detectRogueFileWrites(s.currentUnit.type, s.currentUnit.id, s.basePath);
      for (const rogue of rogueFiles) {
        logWarning("engine", "rogue file write detected", { path: rogue.path, unitId: rogue.unitId });
        ctx.ui.notify(`Rogue file write detected: ${rogue.path}`, "warning");
      }
    } catch (e) {
      debugLog("postUnit", { phase: "rogue-detection", error: String(e) });
    }

    // ── Safety harness: post-unit validation ──
    try {
      const { loadEffectiveGSDPreferences } = await import("./preferences.js");
      const prefs = loadEffectiveGSDPreferences()?.preferences;
      const safetyConfig = resolveSafetyHarnessConfig(
        prefs?.safety_harness as Record<string, unknown> | undefined,
      );

      if (safetyConfig.enabled) {
        const { milestone: sMid, slice: sSid, task: sTid } = parseUnitId(s.currentUnit.id);

        // File change validation (execute-task only, after auto-commit)
        if (safetyConfig.file_change_validation && s.currentUnit.type === "execute-task" && sMid && sSid && sTid && isDbAvailable()) {
          try {
            const taskRow = getTask(sMid, sSid, sTid);
            if (taskRow) {
              const expectedOutput = taskRow.expected_output ?? [];
              const plannedFiles = taskRow.files ?? [];
              const audit = validateFileChanges(s.basePath, expectedOutput, plannedFiles);
              if (audit && audit.violations.length > 0) {
                const warnings = audit.violations.filter(v => v.severity === "warning");
                for (const v of warnings) {
                  logWarning("safety", `file-change: ${v.file} — ${v.reason}`);
                }
                if (warnings.length > 0) {
                  ctx.ui.notify(
                    `Safety: ${warnings.length} unexpected file change(s) outside task plan`,
                    "warning",
                  );
                }
              }
            }
          } catch (e) {
            debugLog("postUnit", { phase: "safety-file-change", error: String(e) });
          }
        }

        // Evidence cross-reference (execute-task only)
        // Verification evidence is passed via the complete-task tool call and
        // stored in the SUMMARY.md on disk — not available as structured data
        // in the DB. The evidence collector tracks actual bash tool calls, so
        // we can still detect units that claimed success but ran no commands.
        if (safetyConfig.evidence_cross_reference && s.currentUnit.type === "execute-task") {
          try {
            const actual = getEvidence();
            const bashCalls = actual.filter(e => e.kind === "bash");
            // If the task is marked complete but zero bash commands were run,
            // it's suspicious — the LLM may have fabricated results.
            if (sMid && sSid && sTid && isDbAvailable()) {
              const taskRow = getTask(sMid, sSid, sTid);
              if (taskRow?.status === "complete" && taskRow.verify && bashCalls.length === 0) {
                logWarning("safety", "task marked complete with verification commands but no bash calls were executed");
                ctx.ui.notify(
                  `Safety: task ${sTid} has verification commands but no bash calls were recorded`,
                  "warning",
                );
              }
            }
          } catch (e) {
            debugLog("postUnit", { phase: "safety-evidence-xref", error: String(e) });
          }
        }

        // Content validation (plan-slice, plan-milestone)
        if (safetyConfig.content_validation) {
          try {
            const artifactPath = resolveArtifactForContent(s.currentUnit.type, s.currentUnit.id, s.basePath);
            const contentViolations = validateContent(s.currentUnit.type, artifactPath);
            for (const v of contentViolations) {
              logWarning("safety", `content: ${v.reason}`);
              ctx.ui.notify(`Content validation: ${v.reason}`, "warning");
            }
          } catch (e) {
            debugLog("postUnit", { phase: "safety-content-validation", error: String(e) });
          }
        }
      }
    } catch (e) {
      debugLog("postUnit", { phase: "safety-harness", error: String(e) });
    }

    // Artifact verification
    let triggerArtifactVerified = false;
    if (!s.currentUnit.type.startsWith("hook/")) {
      try {
        triggerArtifactVerified = verifyExpectedArtifact(s.currentUnit.type, s.currentUnit.id, s.basePath);
        if (triggerArtifactVerified) {
          invalidateAllCaches();
        }
      } catch (e) {
        debugLog("postUnit", { phase: "artifact-verify", error: String(e) });
      }

      // If verification failed, attempt to regenerate missing projection files
      // from DB data before giving up (e.g. research-slice produces PLAN from engine).
      if (!triggerArtifactVerified) {
        try {
          const { milestone: mid, slice: sid } = parseUnitId(s.currentUnit.id);
          if (mid && sid) {
            const regenerated = regenerateIfMissing(s.basePath, mid, sid, "PLAN");
            if (regenerated) {
              // Re-check after regeneration
              triggerArtifactVerified = verifyExpectedArtifact(s.currentUnit.type, s.currentUnit.id, s.basePath);
              if (triggerArtifactVerified) {
                invalidateAllCaches();
              }
            }
          }
        } catch (e) {
          debugLog("postUnit", { phase: "regenerate-projection", error: String(e) });
        }
      }

      // When artifact verification fails for a unit type that has a known expected
      // artifact, return "retry" so the caller re-dispatches with failure context
      // instead of blindly re-dispatching the same unit (#1571).
      // After MAX_VERIFICATION_RETRIES, escalate to writeBlockerPlaceholder so the
      // pipeline can advance instead of looping forever (#2653).
      //
      // HOWEVER, if the DB is unavailable (db_unavailable), the artifact was never
      // written because the completion tool failed at the infra level. Retrying
      // can never succeed and produces a costly re-dispatch loop (#2517).
      if (!triggerArtifactVerified && !isDbAvailable()) {
        // DB infra failure — do NOT retry; the completion tool returned
        // db_unavailable so the artifact was never written. Retrying would
        // produce an infinite re-dispatch loop (#2517).
        debugLog("postUnit", { phase: "artifact-verify-skip-db-unavailable", unitType: s.currentUnit.type, unitId: s.currentUnit.id });
        const dbSkipDiag = diagnoseExpectedArtifact(s.currentUnit.type, s.currentUnit.id, s.basePath);
        ctx.ui.notify(
          `Artifact missing for ${s.currentUnit.type} ${s.currentUnit.id} — DB unavailable, skipping retry.${dbSkipDiag ? ` Expected: ${dbSkipDiag}` : ""}`,
          "error",
        );
      } else if (!triggerArtifactVerified) {
        // #2883/#3595: If the artifact is missing because the tool invocation
        // failed (malformed JSON) or was skipped (queued user message), retrying
        // will produce the same failure. Pause auto-mode instead of looping.
        if (s.lastToolInvocationError) {
          const isUserSkip = /queued user message/i.test(s.lastToolInvocationError);
          const errMsg = isUserSkip
            ? `Tool skipped for ${s.currentUnit.type}: ${s.lastToolInvocationError}. Queued user message interrupted the turn — pausing auto-mode.`
            : `Tool invocation failed for ${s.currentUnit.type}: ${s.lastToolInvocationError}. Structured argument generation failed — pausing auto-mode.`;
          debugLog("postUnit", { phase: "tool-invocation-error-pause", unitType: s.currentUnit.type, unitId: s.currentUnit.id, error: s.lastToolInvocationError });
          ctx.ui.notify(errMsg, "error");
          s.lastToolInvocationError = null;
          await pauseAuto(ctx, pi);
          return "dispatched";
        }

        const hasExpectedArtifact = resolveExpectedArtifactPath(s.currentUnit.type, s.currentUnit.id, s.basePath) !== null;
        if (hasExpectedArtifact) {
          const retryKey = `${s.currentUnit.type}:${s.currentUnit.id}`;
          const attempt = (s.verificationRetryCount.get(retryKey) ?? 0) + 1;
          s.verificationRetryCount.set(retryKey, attempt);

          if (attempt > MAX_VERIFICATION_RETRIES) {
            // Retries exhausted — write a blocker placeholder so the pipeline
            // can advance past this stuck unit (#2653).
            debugLog("postUnit", {
              phase: "artifact-verify-escalate",
              unitType: s.currentUnit.type,
              unitId: s.currentUnit.id,
              attempt,
              maxRetries: MAX_VERIFICATION_RETRIES,
            });
            const reason = `Artifact verification failed after ${MAX_VERIFICATION_RETRIES} retries for ${s.currentUnit.type} "${s.currentUnit.id}".`;
            writeBlockerPlaceholder(s.currentUnit.type, s.currentUnit.id, s.basePath, reason);
            ctx.ui.notify(
              `${s.currentUnit.type} ${s.currentUnit.id} — verification retries exhausted (${MAX_VERIFICATION_RETRIES}), wrote blocker placeholder to advance pipeline`,
              "warning",
            );
            // Reset retry count and fall through to "continue" so the loop
            // re-derives state with the placeholder in place.
            s.verificationRetryCount.delete(retryKey);
            s.pendingVerificationRetry = null;
            // Do NOT return "retry" — fall through to "continue" below.
          } else {
            s.pendingVerificationRetry = {
              unitId: s.currentUnit.id,
              failureContext: `Artifact verification failed: expected artifact for ${s.currentUnit.type} "${s.currentUnit.id}" was not found on disk after unit execution (attempt ${attempt}).`,
              attempt,
            };
            debugLog("postUnit", { phase: "artifact-verify-retry", unitType: s.currentUnit.type, unitId: s.currentUnit.id, attempt });
            ctx.ui.notify(
              `Artifact missing for ${s.currentUnit.type} ${s.currentUnit.id} — retrying (attempt ${attempt})`,
              "warning",
            );
            return "retry";
          }
        }
      }
    } else {
      // Hook unit completed — no additional processing needed
    }
  }

  return "continue";
}

/**
 * Post-verification processing: DB dual-write, post-unit hooks, triage
 * capture dispatch, quick-task dispatch.
 *
 * Sidecar work (hooks, triage, quick-tasks) is enqueued on `s.sidecarQueue`
 * for the main loop to drain via `runUnit()`.
 *
 * Returns:
 * - "continue" — proceed to sidecar drain / normal dispatch
 * - "step-wizard" — step mode, show wizard instead
 * - "stopped" — stopAuto was called
 */
export async function postUnitPostVerification(pctx: PostUnitContext): Promise<"continue" | "step-wizard" | "stopped"> {
  const { s, ctx, pi, buildSnapshotOpts, lockBase, stopAuto, pauseAuto, updateProgressWidget } = pctx;

  if (s.currentUnit) {
    try {
      const codebasePrefs = loadEffectiveGSDPreferences()?.preferences?.codebase;
      const refresh = ensureCodebaseMapFresh(
        s.basePath,
        codebasePrefs
          ? {
              excludePatterns: codebasePrefs.exclude_patterns,
              maxFiles: codebasePrefs.max_files,
              collapseThreshold: codebasePrefs.collapse_threshold,
            }
          : undefined,
        { force: true, ttlMs: 0 },
      );
      if (refresh.status === "generated" || refresh.status === "updated") {
        debugLog("postUnit", {
          phase: "codebase-refresh",
          unitType: s.currentUnit.type,
          unitId: s.currentUnit.id,
          status: refresh.status,
          fileCount: refresh.fileCount,
          reason: refresh.reason,
        });
      }
    } catch (e) {
      logWarning("engine", `CODEBASE refresh failed: ${(e as Error).message}`);
    }
  }

  // ── Post-unit hooks ──
  if (s.currentUnit && !s.stepMode) {
    const hookUnit = checkPostUnitHooks(s.currentUnit.type, s.currentUnit.id, s.basePath);
    if (hookUnit) {
      if (s.currentUnit) {
        await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id));
      }
      persistHookState(s.basePath);

      return enqueueSidecar(
        s, ctx,
        { kind: "hook", unitType: hookUnit.unitType, unitId: hookUnit.unitId, prompt: hookUnit.prompt, model: hookUnit.model },
        { hookName: hookUnit.hookName },
      );
    }

    // Check if a hook requested a retry of the trigger unit
    if (isRetryPending()) {
      const trigger = consumeRetryTrigger();
      if (trigger) {
        ctx.ui.notify(
          `Hook requested retry of ${trigger.unitType} ${trigger.unitId} — resetting task state.`,
          "info",
        );

        // ── State reset: undo the completion so deriveState re-derives the unit ──
        try {
          const { milestone: mid, slice: sid, task: tid } = parseUnitId(trigger.unitId);

          // 1. Reset task status in DB and re-render plan checkboxes
          if (mid && sid && tid) {
            try {
              updateTaskStatus(mid, sid, tid, "pending");
              await renderPlanCheckboxes(s.basePath, mid, sid);
            } catch (dbErr) {
              // DB unavailable — fail explicitly rather than silently reverting to markdown mutation.
              // Use 'gsd recover' to rebuild DB state from disk if needed.
              logError("engine", `retry state-reset failed (DB unavailable): ${(dbErr as Error).message}. Run 'gsd recover' to reconcile.`);
            }
          }

          // 2. Delete SUMMARY.md for the task
          if (mid && sid && tid) {
            const tasksDir = resolveTasksDir(s.basePath, mid, sid);
            if (tasksDir) {
              const summaryFile = join(tasksDir, buildTaskFileName(tid, "SUMMARY"));
              if (existsSync(summaryFile)) {
                unlinkSync(summaryFile);
              }
            }
          }

          // 3. Delete the retry_on artifact (e.g. NEEDS-REWORK.md)
          if (trigger.retryArtifact) {
            const retryArtifactPath = resolveHookArtifactPath(s.basePath, trigger.unitId, trigger.retryArtifact);
            if (existsSync(retryArtifactPath)) {
              unlinkSync(retryArtifactPath);
            }
          }

          // 5. Invalidate caches so deriveState reads fresh disk state
          invalidateAllCaches();
        } catch (e) {
          debugLog("postUnitPostVerification", { phase: "retry-state-reset", error: String(e) });
        }

        // Fall through to normal dispatch — deriveState will re-derive the unit
      }
    }
  }

  // ── Fast-path stop detection (#3487) ──
  // Before waiting for triage, check if any PENDING captures contain explicit
  // stop/halt language. If so, pause immediately — don't wait for triage.
  if (s.currentUnit && s.currentUnit.type !== "triage-captures") {
    try {
      const pending = loadPendingCaptures(s.basePath);
      // Match only when the capture text starts with a stop/halt directive word,
      // or the entire text is short and dominated by such a word. This avoids
      // false positives on captures like "add a pause button" or "stop the timer
      // from re-rendering" — those are feature descriptions, not halt directives.
      const STOP_PATTERN = /^(stop|halt|abort|don'?t continue|pause|cease)\b/i;
      const stopCapture = pending.find(c => STOP_PATTERN.test(c.text.trim()));
      if (stopCapture) {
        ctx.ui.notify(
          `Stop directive detected in pending capture ${stopCapture.id}: "${stopCapture.text}" — pausing auto-mode.`,
          "warning",
        );
        debugLog("postUnit", { phase: "fast-stop", captureId: stopCapture.id });
        await pauseAuto(ctx, pi);
        return "stopped";
      }
    } catch (e) {
      debugLog("postUnit", { phase: "fast-stop-error", error: String(e) });
    }
  }

  // ── Capture protection: revert executor-silenced captures (#3487) ──
  // Non-triage agents can write **Status:** resolved to CAPTURES.md, bypassing
  // the triage pipeline. Revert those to pending before the triage check.
  if (
    s.currentUnit &&
    s.currentUnit.type !== "triage-captures"
  ) {
    try {
      const reverted = revertExecutorResolvedCaptures(s.basePath);
      if (reverted > 0) {
        debugLog("postUnit", { phase: "capture-protection", reverted });
        ctx.ui.notify(
          `Reverted ${reverted} capture${reverted === 1 ? "" : "s"} silenced by executor — re-queuing for triage.`,
          "warning",
        );
      }
    } catch (e) {
      debugLog("postUnit", { phase: "capture-protection-error", error: String(e) });
    }
  }

  // ── Pre-execution checks (after plan-slice completes) ──
  if (
    s.currentUnit &&
    s.currentUnit.type === "plan-slice"
  ) {
    let preExecPauseNeeded = false;
    await runSafely("postUnitPostVerification", "pre-execution-checks", async () => {
      try {
        // Check preferences — respect enhanced_verification and enhanced_verification_pre
        const prefs = loadEffectiveGSDPreferences()?.preferences;
        const enhancedEnabled = prefs?.enhanced_verification !== false; // default true
        const preEnabled = prefs?.enhanced_verification_pre !== false;  // default true

        if (!enhancedEnabled || !preEnabled) {
          debugLog("postUnitPostVerification", {
            phase: "pre-execution-checks",
            skipped: true,
            reason: "disabled by preferences",
          });
          return;
        }

        // Parse the unit ID to get milestone/slice IDs
        const { milestone: mid, slice: sid } = parseUnitId(s.currentUnit!.id);
        if (!mid || !sid) {
          debugLog("postUnitPostVerification", {
            phase: "pre-execution-checks",
            skipped: true,
            reason: "could not parse milestone/slice from unit ID",
          });
          return;
        }

        // Get tasks for this slice from DB
        const tasks = getSliceTasks(mid, sid);
        if (tasks.length === 0) {
          debugLog("postUnitPostVerification", {
            phase: "pre-execution-checks",
            skipped: true,
            reason: "no tasks found for slice",
          });
          return;
        }

        // Run pre-execution checks
        const result: PreExecutionResult = await runPreExecutionChecks(tasks, s.basePath);

        // Log summary to stderr in existing verification output format
        const emoji = result.status === "pass" ? "✅" : result.status === "warn" ? "⚠️" : "❌";
        process.stderr.write(
          `gsd-pre-exec: ${emoji} Pre-execution checks ${result.status} for ${mid}/${sid} (${result.durationMs}ms)\n`,
        );

        // Log individual check results
        for (const check of result.checks) {
          const checkEmoji = check.passed ? "✓" : check.blocking ? "✗" : "⚠";
          process.stderr.write(
            `gsd-pre-exec:   ${checkEmoji} [${check.category}] ${check.target}: ${check.message}\n`,
          );
        }

        // Write evidence JSON to slice artifacts directory
        const slicePath = resolveSlicePath(s.basePath, mid, sid);
        if (slicePath) {
          writePreExecutionEvidence(result, slicePath, mid, sid);
        }

        // Notify UI
        if (result.status === "fail") {
          const blockingCount = result.checks.filter(c => !c.passed && c.blocking).length;
          ctx.ui.notify(
            `Pre-execution checks failed: ${blockingCount} blocking issue${blockingCount === 1 ? "" : "s"} found`,
            "error",
          );
          preExecPauseNeeded = true;
        } else if (result.status === "warn") {
          ctx.ui.notify(
            `Pre-execution checks passed with warnings`,
            "warning",
          );
          // Strict mode: treat warnings as blocking
          if (prefs?.enhanced_verification_strict === true) {
            preExecPauseNeeded = true;
          }
        }

        debugLog("postUnitPostVerification", {
          phase: "pre-execution-checks",
          status: result.status,
          checkCount: result.checks.length,
          durationMs: result.durationMs,
        });
      } catch (preExecError) {
        // Fail-closed: if runPreExecutionChecks throws, pause auto-mode instead of silently continuing
        const errorMessage = preExecError instanceof Error ? preExecError.message : String(preExecError);
        debugLog("postUnitPostVerification", {
          phase: "pre-execution-checks",
          error: errorMessage,
          failClosed: true,
        });
        logError("engine", `gsd-pre-exec: Pre-execution checks threw an error: ${errorMessage}`);
        ctx.ui.notify(
          `Pre-execution checks error: ${errorMessage} — pausing for human review`,
          "error",
        );
        preExecPauseNeeded = true;
      }
    });

    // Check for blocking failures after runSafely completes
    if (preExecPauseNeeded) {
      debugLog("postUnitPostVerification", { phase: "pre-execution-checks", pausing: true, reason: "blocking failures detected" });
      await pauseAuto(ctx, pi);
      return "stopped";
    }
  }

  // ── Triage check ──
  if (
    !s.stepMode &&
    s.currentUnit &&
    !s.currentUnit.type.startsWith("hook/") &&
    s.currentUnit.type !== "triage-captures" &&
    s.currentUnit.type !== "quick-task"
  ) {
    try {
      if (hasPendingCaptures(s.basePath)) {
        const pending = loadPendingCaptures(s.basePath);
        if (pending.length > 0) {
          const state = await deriveState(s.basePath);
          const mid = state.activeMilestone?.id;
          const sid = state.activeSlice?.id;

          if (mid && sid) {
            let currentPlan = "";
            let roadmapContext = "";
            const planFile = resolveSliceFile(s.basePath, mid, sid, "PLAN");
            if (planFile) currentPlan = (await loadFile(planFile)) ?? "";
            const roadmapFile = resolveMilestoneFile(s.basePath, mid, "ROADMAP");
            if (roadmapFile) roadmapContext = (await loadFile(roadmapFile)) ?? "";

            const capturesList = pending.map(c =>
              `- **${c.id}**: "${c.text}" (captured: ${c.timestamp})`
            ).join("\n");

            const prompt = loadPrompt("triage-captures", {
              pendingCaptures: capturesList,
              currentPlan: currentPlan || "(no active slice plan)",
              roadmapContext: roadmapContext || "(no active roadmap)",
            });

            if (s.currentUnit) {
              await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt);
            }

            const triageUnitId = `${mid}/${sid}/triage`;
            return enqueueSidecar(
              s, ctx,
              { kind: "triage", unitType: "triage-captures", unitId: triageUnitId, prompt },
              { pendingCount: pending.length },
              `Triaging ${pending.length} pending capture${pending.length === 1 ? "" : "s"}...`,
            );
          }
        }
      }
    } catch (e) {
      debugLog("postUnit", { phase: "triage-check", error: String(e) });
    }
  }

  // ── Quick-task dispatch ──
  if (
    !s.stepMode &&
    s.pendingQuickTasks.length > 0 &&
    s.currentUnit &&
    s.currentUnit.type !== "quick-task"
  ) {
    try {
      const capture = s.pendingQuickTasks.shift()!;
      const { buildQuickTaskPrompt } = await import("./triage-resolution.js");
      const { markCaptureExecuted } = await import("./captures.js");
      const prompt = buildQuickTaskPrompt(capture);

      if (s.currentUnit) {
        await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt);
      }

      markCaptureExecuted(s.basePath, capture.id);

      const qtUnitId = `${s.currentMilestoneId}/${capture.id}`;
      return enqueueSidecar(
        s, ctx,
        { kind: "quick-task", unitType: "quick-task", unitId: qtUnitId, prompt, captureId: capture.id },
        { captureId: capture.id },
        `Executing quick-task: ${capture.id} — "${capture.text}"`,
      );
    } catch (e) {
      debugLog("postUnit", { phase: "quick-task-dispatch", error: String(e) });
    }
  }

  // Step mode → show wizard instead of dispatch
  if (s.stepMode) {
    return "step-wizard";
  }

  return "continue";
}
