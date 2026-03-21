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
import { loadFile, parseSummary, resolveAllOverrides } from "./files.js";
import { loadPrompt } from "./prompt-loader.js";
import {
  resolveSliceFile,
  resolveTaskFile,
  resolveMilestoneFile,
} from "./paths.js";
import { invalidateAllCaches } from "./cache.js";
import { closeoutUnit, type CloseoutOptions } from "./auto-unit-closeout.js";
import {
  autoCommitCurrentBranch,
  type TaskCommitContext,
} from "./worktree.js";
import {
  verifyExpectedArtifact,
} from "./auto-recovery.js";
import { writeUnitRuntimeRecord, clearUnitRuntimeRecord } from "./unit-runtime.js";
import { runGSDDoctor, rebuildState, summarizeDoctorIssues } from "./doctor.js";
import { recordHealthSnapshot, checkHealEscalation } from "./doctor-proactive.js";
import { syncStateToProjectRoot } from "./auto-worktree-sync.js";
import { isDbAvailable } from "./gsd-db.js";
import { consumeSignal } from "./session-status-io.js";
import {
  checkPostUnitHooks,
  isRetryPending,
  consumeRetryTrigger,
  persistHookState,
} from "./post-unit-hooks.js";
import { hasPendingCaptures, loadPendingCaptures } from "./captures.js";
import { debugLog } from "./debug-logger.js";
import type { AutoSession } from "./auto/session.js";
import {
  updateProgressWidget as _updateProgressWidget,
  updateSliceProgressCache,
  unitVerb,
  hideFooter,
} from "./auto-dashboard.js";
import { join } from "node:path";

/** Throttle STATE.md rebuilds — at most once per 30 seconds */
const STATE_REBUILD_MIN_INTERVAL_MS = 30_000;

export interface PreVerificationOpts {
  skipSettleDelay?: boolean;
  skipDoctor?: boolean;
  skipStateRebuild?: boolean;
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
 * Returns "dispatched" if a signal caused stop/pause, "continue" to proceed.
 */
export async function postUnitPreVerification(pctx: PostUnitContext, opts?: PreVerificationOpts): Promise<"dispatched" | "continue"> {
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
    try {
      let taskContext: TaskCommitContext | undefined;

      if (s.currentUnit.type === "execute-task") {
        const parts = s.currentUnit.id.split("/");
        const [mid, sid, tid] = parts;
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
                } catch {
                  // GitHub sync not available — skip
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

      const commitMsg = autoCommitCurrentBranch(s.basePath, s.currentUnit.type, s.currentUnit.id, taskContext);
      if (commitMsg) {
        ctx.ui.notify(`Committed: ${commitMsg.split("\n")[0]}`, "info");
      }
    } catch (e) {
      debugLog("postUnit", { phase: "auto-commit", error: String(e) });
    }

    // GitHub sync (non-blocking, opt-in)
    try {
      const { runGitHubSync } = await import("../github-sync/sync.js");
      await runGitHubSync(s.basePath, s.currentUnit.type, s.currentUnit.id);
    } catch (e) {
      debugLog("postUnit", { phase: "github-sync", error: String(e) });
    }

    // Doctor: fix mechanical bookkeeping (skipped for lightweight sidecars)
    if (!opts?.skipDoctor) try {
      const scopeParts = s.currentUnit.id.split("/").slice(0, 2);
      const doctorScope = scopeParts.join("/");
      const sliceTerminalUnits = new Set(["complete-slice", "run-uat"]);
      const effectiveFixLevel = sliceTerminalUnits.has(s.currentUnit.type) ? "all" as const : "task" as const;
      const report = await runGSDDoctor(s.basePath, { fix: true, scope: doctorScope, fixLevel: effectiveFixLevel });
      // Human-readable fix notification with details
      if (report.fixesApplied.length > 0) {
        const fixSummary = report.fixesApplied.length <= 2
          ? report.fixesApplied.join("; ")
          : `${report.fixesApplied[0]}; +${report.fixesApplied.length - 1} more`;
        ctx.ui.notify(`Doctor: ${fixSummary}`, "info");
      }

      // Proactive health tracking — filter to current milestone to avoid
      // cross-milestone stale errors inflating the escalation counter
      const currentMilestoneId = s.currentUnit.id.split("/")[0];
      const milestoneIssues = currentMilestoneId
        ? report.issues.filter(i =>
            i.unitId === currentMilestoneId ||
            i.unitId.startsWith(`${currentMilestoneId}/`))
        : report.issues;
      const summary = summarizeDoctorIssues(milestoneIssues);
      // Pass issue details + scope for real-time visibility in the progress widget
      const issueDetails = milestoneIssues
        .filter(i => i.severity === "error" || i.severity === "warning")
        .map(i => ({ code: i.code, message: i.message, severity: i.severity, unitId: i.unitId }));
      recordHealthSnapshot(summary.errors, summary.warnings, report.fixesApplied.length, issueDetails, report.fixesApplied, doctorScope);

      // Check if we should escalate to LLM-assisted heal
      if (summary.errors > 0) {
        const unresolvedErrors = milestoneIssues
          .filter(i => i.severity === "error" && !i.fixable)
          .map(i => ({ code: i.code, message: i.message, unitId: i.unitId }));
        const escalation = checkHealEscalation(summary.errors, unresolvedErrors);
        if (escalation.shouldEscalate) {
          ctx.ui.notify(
            `Doctor heal escalation: ${escalation.reason}. Dispatching LLM-assisted heal.`,
            "warning",
          );
          try {
            const { formatDoctorIssuesForPrompt, formatDoctorReport } = await import("./doctor.js");
            const { dispatchDoctorHeal } = await import("./commands-handlers.js");
            const actionable = report.issues.filter(i => i.severity === "error");
            const reportText = formatDoctorReport(report, { scope: doctorScope, includeWarnings: true });
            const structuredIssues = formatDoctorIssuesForPrompt(actionable);
            dispatchDoctorHeal(pi, doctorScope, reportText, structuredIssues);
            return "dispatched";
          } catch (e) {
            debugLog("postUnit", { phase: "doctor-heal-dispatch", error: String(e) });
          }
        }
      }
    } catch (e) {
      debugLog("postUnit", { phase: "doctor", error: String(e) });
    }

    // Throttled STATE.md rebuild (skipped for lightweight sidecars)
    if (!opts?.skipStateRebuild) {
      const now = Date.now();
      if (now - s.lastStateRebuildAt >= STATE_REBUILD_MIN_INTERVAL_MS) {
        try {
          await rebuildState(s.basePath);
          s.lastStateRebuildAt = now;
          autoCommitCurrentBranch(s.basePath, "state-rebuild", s.currentUnit.id);
        } catch (e) {
          debugLog("postUnit", { phase: "state-rebuild", error: String(e) });
        }
      }
    }

    // Prune dead bg-shell processes
    try {
      const { pruneDeadProcesses } = await import("../bg-shell/process-manager.js");
      pruneDeadProcesses();
    } catch (e) {
      debugLog("postUnit", { phase: "prune-bg-shell", error: String(e) });
    }

    // Sync worktree state back to project root (skipped for lightweight sidecars)
    if (!opts?.skipWorktreeSync && s.originalBasePath && s.originalBasePath !== s.basePath) {
      try {
        syncStateToProjectRoot(s.basePath, s.originalBasePath, s.currentMilestoneId);
      } catch (e) {
        debugLog("postUnit", { phase: "worktree-sync", error: String(e) });
      }
    }

    // Rewrite-docs completion
    if (s.currentUnit.type === "rewrite-docs") {
      try {
        await resolveAllOverrides(s.basePath);
        s.rewriteAttemptCount = 0;
        ctx.ui.notify("Override(s) resolved — rewrite-docs completed.", "info");
      } catch (e) {
        debugLog("postUnit", { phase: "rewrite-docs-resolve", error: String(e) });
      }
    }

    // Reactive state cleanup on slice completion
    if (s.currentUnit.type === "complete-slice") {
      try {
        const parts = s.currentUnit.id.split("/");
        const [mid, sid] = parts;
        if (mid && sid) {
          const { clearReactiveState } = await import("./reactive-graph.js");
          clearReactiveState(s.basePath, mid, sid);
        }
      } catch (e) {
        debugLog("postUnit", { phase: "reactive-state-cleanup", error: String(e) });
      }
    }

    // Post-triage: execute actionable resolutions
    if (s.currentUnit.type === "triage-captures") {
      try {
        const { executeTriageResolutions } = await import("./triage-resolution.js");
        const state = await deriveState(s.basePath);
        const mid = state.activeMilestone?.id;
        const sid = state.activeSlice?.id;

        if (mid && sid) {
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
            process.stderr.write(`gsd-triage: ${action}\n`);
          }
        }
      } catch (err) {
        process.stderr.write(`gsd-triage: resolution execution failed: ${(err as Error).message}\n`);
      }
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
    } else {
      // Hook unit completed — finalize its runtime record
      try {
        writeUnitRuntimeRecord(s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, {
          phase: "finalized",
          progressCount: 1,
          lastProgressKind: "hook-completed",
        });
        clearUnitRuntimeRecord(s.basePath, s.currentUnit.type, s.currentUnit.id);
      } catch (e) {
        debugLog("postUnit", { phase: "hook-finalize", error: String(e) });
      }
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

  // ── DB dual-write ──
  if (isDbAvailable()) {
    try {
      const { migrateFromMarkdown } = await import("./md-importer.js");
      migrateFromMarkdown(s.basePath);
    } catch (err) {
      process.stderr.write(`gsd-db: re-import failed: ${(err as Error).message}\n`);
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

      s.sidecarQueue.push({
        kind: "hook",
        unitType: hookUnit.unitType,
        unitId: hookUnit.unitId,
        prompt: hookUnit.prompt,
        model: hookUnit.model,
      });

      debugLog("postUnitPostVerification", {
        phase: "sidecar-enqueue",
        kind: "hook",
        unitType: hookUnit.unitType,
        unitId: hookUnit.unitId,
        hookName: hookUnit.hookName,
      });

      return "continue";
    }

    // Check if a hook requested a retry of the trigger unit
    if (isRetryPending()) {
      const trigger = consumeRetryTrigger();
      if (trigger) {
        ctx.ui.notify(
          `Hook requested retry of ${trigger.unitType} ${trigger.unitId}.`,
          "info",
        );
        // Fall through to normal dispatch — deriveState will re-derive the unit
      }
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
            s.sidecarQueue.push({
              kind: "triage",
              unitType: "triage-captures",
              unitId: triageUnitId,
              prompt,
            });

            debugLog("postUnitPostVerification", {
              phase: "sidecar-enqueue",
              kind: "triage",
              unitId: triageUnitId,
              pendingCount: pending.length,
            });

            ctx.ui.notify(
              `Triaging ${pending.length} pending capture${pending.length === 1 ? "" : "s"}...`,
              "info",
            );

            return "continue";
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
      s.sidecarQueue.push({
        kind: "quick-task",
        unitType: "quick-task",
        unitId: qtUnitId,
        prompt,
        captureId: capture.id,
      });

      debugLog("postUnitPostVerification", {
        phase: "sidecar-enqueue",
        kind: "quick-task",
        unitId: qtUnitId,
        captureId: capture.id,
      });

      ctx.ui.notify(
        `Executing quick-task: ${capture.id} — "${capture.text}"`,
        "info",
      );

      return "continue";
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
