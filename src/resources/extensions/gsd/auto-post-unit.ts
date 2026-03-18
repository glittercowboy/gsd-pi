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

import type { ExtensionContext, ExtensionCommandContext, ExtensionAPI } from "@gsd/pi-coding-agent";
import { deriveState } from "./state.js";
import { loadFile, parseSummary, resolveAllOverrides } from "./files.js";
import { loadPrompt } from "./prompt-loader.js";
import {
  resolveSliceFile,
  resolveTaskFile,
  resolveMilestoneFile,
  gsdRoot,
} from "./paths.js";
import { invalidateAllCaches } from "./cache.js";
import { closeoutUnit, type CloseoutOptions } from "./auto-unit-closeout.js";
import {
  autoCommitCurrentBranch,
  type TaskCommitContext,
} from "./worktree.js";
import {
  verifyExpectedArtifact,
  persistCompletedKey,
  removePersistedKey,
} from "./auto-recovery.js";
import { writeUnitRuntimeRecord, clearUnitRuntimeRecord } from "./unit-runtime.js";
import { resolveAutoSupervisorConfig, loadEffectiveGSDPreferences } from "./preferences.js";
import { runGSDDoctor, rebuildState, summarizeDoctorIssues } from "./doctor.js";
import { recordHealthSnapshot, checkHealEscalation } from "./doctor-proactive.js";
import { syncStateToProjectRoot } from "./auto-worktree-sync.js";
import { resetRewriteCircuitBreaker } from "./auto-dispatch.js";
import { isDbAvailable } from "./gsd-db.js";
import { consumeSignal } from "./session-status-io.js";
import {
  checkPostUnitHooks,
  getActiveHook,
  resetHookState,
  isRetryPending,
  consumeRetryTrigger,
  persistHookState,
} from "./post-unit-hooks.js";
import { hasPendingCaptures, loadPendingCaptures, countPendingCaptures } from "./captures.js";
import { writeLock } from "./crash-recovery.js";
import { debugLog } from "./debug-logger.js";
import type { AutoSession } from "./auto/session.js";
import type { WidgetStateAccessors, AutoDashboardData } from "./auto-dashboard.js";
import {
  updateProgressWidget as _updateProgressWidget,
  updateSliceProgressCache,
  unitVerb,
  hideFooter,
} from "./auto-dashboard.js";
import { join } from "node:path";

/** Throttle STATE.md rebuilds — at most once per 30 seconds */
const STATE_REBUILD_MIN_INTERVAL_MS = 30_000;

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
export async function postUnitPreVerification(pctx: PostUnitContext): Promise<"dispatched" | "continue"> {
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

  // Small delay to let files settle
  await new Promise(r => setTimeout(r, 500));

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
                taskContext = {
                  taskId: `${sid}/${tid}`,
                  taskTitle: summary.title?.replace(/^T\d+:\s*/, "") || tid,
                  oneLiner: summary.oneLiner || undefined,
                  keyFiles: summary.frontmatter.key_files?.filter(f => !f.includes("{{")) || undefined,
                };
              }
            } catch {
              // Non-fatal
            }
          }
        }
      }

      const commitMsg = autoCommitCurrentBranch(s.basePath, s.currentUnit.type, s.currentUnit.id, taskContext);
      if (commitMsg) {
        ctx.ui.notify(`Committed: ${commitMsg.split("\n")[0]}`, "info");
      }
    } catch {
      // Non-fatal
    }

    // Doctor: fix mechanical bookkeeping
    try {
      const scopeParts = s.currentUnit.id.split("/").slice(0, 2);
      const doctorScope = scopeParts.join("/");
      const sliceTerminalUnits = new Set(["complete-slice", "run-uat"]);
      const effectiveFixLevel = sliceTerminalUnits.has(s.currentUnit.type) ? "all" as const : "task" as const;
      const report = await runGSDDoctor(s.basePath, { fix: true, scope: doctorScope, fixLevel: effectiveFixLevel });
      if (report.fixesApplied.length > 0) {
        ctx.ui.notify(`Post-hook: applied ${report.fixesApplied.length} fix(es).`, "info");
      }

      // Proactive health tracking
      const summary = summarizeDoctorIssues(report.issues);
      recordHealthSnapshot(summary.errors, summary.warnings, report.fixesApplied.length);

      // Check if we should escalate to LLM-assisted heal
      if (summary.errors > 0) {
        const unresolvedErrors = report.issues
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
            const { dispatchDoctorHeal } = await import("./commands.js");
            const actionable = report.issues.filter(i => i.severity === "error");
            const reportText = formatDoctorReport(report, { scope: doctorScope, includeWarnings: true });
            const structuredIssues = formatDoctorIssuesForPrompt(actionable);
            dispatchDoctorHeal(pi, doctorScope, reportText, structuredIssues);
          } catch {
            // Non-fatal
          }
        }
      }
    } catch {
      // Non-fatal
    }

    // Throttled STATE.md rebuild
    const now = Date.now();
    if (now - s.lastStateRebuildAt >= STATE_REBUILD_MIN_INTERVAL_MS) {
      try {
        await rebuildState(s.basePath);
        s.lastStateRebuildAt = now;
        autoCommitCurrentBranch(s.basePath, "state-rebuild", s.currentUnit.id);
      } catch {
        // Non-fatal
      }
    }

    // Prune dead bg-shell processes
    try {
      const { pruneDeadProcesses } = await import("../bg-shell/process-manager.js");
      pruneDeadProcesses();
    } catch {
      // Non-fatal
    }

    // Sync worktree state back to project root
    if (s.originalBasePath && s.originalBasePath !== s.basePath) {
      try {
        syncStateToProjectRoot(s.basePath, s.originalBasePath, s.currentMilestoneId);
      } catch {
        // Non-fatal
      }
    }

    // Rewrite-docs completion
    if (s.currentUnit.type === "rewrite-docs") {
      try {
        await resolveAllOverrides(s.basePath);
        resetRewriteCircuitBreaker();
        ctx.ui.notify("Override(s) resolved — rewrite-docs completed.", "info");
      } catch {
        // Non-fatal
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

    // Artifact verification and completion persistence
    let triggerArtifactVerified = false;
    if (!s.currentUnit.type.startsWith("hook/")) {
      try {
        triggerArtifactVerified = verifyExpectedArtifact(s.currentUnit.type, s.currentUnit.id, s.basePath);
        if (triggerArtifactVerified) {
          const completionKey = `${s.currentUnit.type}/${s.currentUnit.id}`;
          if (!s.completedKeySet.has(completionKey)) {
            persistCompletedKey(s.basePath, completionKey);
            s.completedKeySet.add(completionKey);
          }
          invalidateAllCaches();
        }
      } catch {
        // Non-fatal
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
      } catch {
        // Non-fatal
      }
    }
  }

  return "continue";
}

/**
 * Post-verification processing: DB dual-write, post-unit hooks, triage
 * capture dispatch, quick-task dispatch.
 *
 * Returns:
 * - "dispatched" — a hook/triage/quick-task was dispatched (sendMessage sent)
 * - "continue" — proceed to normal dispatchNextUnit
 * - "step-wizard" — step mode, show wizard instead
 * - "stopped" — stopAuto was called
 */
export async function postUnitPostVerification(pctx: PostUnitContext): Promise<"dispatched" | "continue" | "step-wizard" | "stopped"> {
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
      const hookStartedAt = Date.now();
      if (s.currentUnit) {
        await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id));
      }
      s.currentUnit = { type: hookUnit.unitType, id: hookUnit.unitId, startedAt: hookStartedAt };
      writeUnitRuntimeRecord(s.basePath, hookUnit.unitType, hookUnit.unitId, hookStartedAt, {
        phase: "dispatched",
        wrapupWarningSent: false,
        timeoutAt: null,
        lastProgressAt: hookStartedAt,
        progressCount: 0,
        lastProgressKind: "dispatch",
      });

      const state = await deriveState(s.basePath);
      updateProgressWidget(ctx, hookUnit.unitType, hookUnit.unitId, state);
      const hookState = getActiveHook();
      ctx.ui.notify(
        `Running post-unit hook: ${hookUnit.hookName} (cycle ${hookState?.cycle ?? 1})`,
        "info",
      );

      // Switch model if the hook specifies one
      if (hookUnit.model) {
        const availableModels = ctx.modelRegistry.getAvailable();
        const match = availableModels.find(m =>
          m.id === hookUnit.model || `${m.provider}/${m.id}` === hookUnit.model,
        );
        if (match) {
          try {
            await pi.setModel(match);
          } catch { /* non-fatal */ }
        }
      }

      const result = await s.cmdCtx!.newSession();
      if (result.cancelled) {
        resetHookState();
        await stopAuto(ctx, pi, "Hook session cancelled");
        return "stopped";
      }
      const sessionFile = ctx.sessionManager.getSessionFile();
      writeLock(lockBase(), hookUnit.unitType, hookUnit.unitId, s.completedUnits.length, sessionFile);
      persistHookState(s.basePath);

      // Start supervision timers for hook units
      const supervisor = resolveAutoSupervisorConfig();
      const hookHardTimeoutMs = (supervisor.hard_timeout_minutes ?? 30) * 60 * 1000;
      s.unitTimeoutHandle = setTimeout(async () => {
        s.unitTimeoutHandle = null;
        if (!s.active) return;
        if (s.currentUnit) {
          writeUnitRuntimeRecord(s.basePath, hookUnit.unitType, hookUnit.unitId, s.currentUnit.startedAt, {
            phase: "timeout",
            timeoutAt: Date.now(),
          });
        }
        ctx.ui.notify(
          `Hook ${hookUnit.hookName} exceeded ${supervisor.hard_timeout_minutes ?? 30}min timeout. Pausing auto-mode.`,
          "warning",
        );
        resetHookState();
        await pauseAuto(ctx, pi);
      }, hookHardTimeoutMs);

      if (!s.active) return "stopped";
      pi.sendMessage(
        { customType: "gsd-auto", content: hookUnit.prompt, display: s.verbose },
        { triggerTurn: true },
      );
      return "dispatched";
    }

    // Check if a hook requested a retry of the trigger unit
    if (isRetryPending()) {
      const trigger = consumeRetryTrigger();
      if (trigger) {
        const triggerKey = `${trigger.unitType}/${trigger.unitId}`;
        s.completedKeySet.delete(triggerKey);
        removePersistedKey(s.basePath, triggerKey);
        ctx.ui.notify(
          `Hook requested retry of ${trigger.unitType} ${trigger.unitId}.`,
          "info",
        );
        // Fall through to normal dispatch
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

            ctx.ui.notify(
              `Triaging ${pending.length} pending capture${pending.length === 1 ? "" : "s"}...`,
              "info",
            );

            if (s.currentUnit) {
              await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt);
            }

            const triageUnitType = "triage-captures";
            const triageUnitId = `${mid}/${sid}/triage`;
            const triageStartedAt = Date.now();
            s.currentUnit = { type: triageUnitType, id: triageUnitId, startedAt: triageStartedAt };
            writeUnitRuntimeRecord(s.basePath, triageUnitType, triageUnitId, triageStartedAt, {
              phase: "dispatched",
              wrapupWarningSent: false,
              timeoutAt: null,
              lastProgressAt: triageStartedAt,
              progressCount: 0,
              lastProgressKind: "dispatch",
            });
            updateProgressWidget(ctx, triageUnitType, triageUnitId, state);

            const result = await s.cmdCtx!.newSession();
            if (result.cancelled) {
              await stopAuto(ctx, pi);
              return "stopped";
            }
            const sessionFile = ctx.sessionManager.getSessionFile();
            writeLock(lockBase(), triageUnitType, triageUnitId, s.completedUnits.length, sessionFile);

            const supervisor = resolveAutoSupervisorConfig();
            const triageTimeoutMs = (supervisor.hard_timeout_minutes ?? 30) * 60 * 1000;
            s.unitTimeoutHandle = setTimeout(async () => {
              s.unitTimeoutHandle = null;
              if (!s.active) return;
              ctx.ui.notify(
                `Triage unit exceeded timeout. Pausing auto-mode.`,
                "warning",
              );
              await pauseAuto(ctx, pi);
            }, triageTimeoutMs);

            if (!s.active) return "stopped";
            pi.sendMessage(
              { customType: "gsd-auto", content: prompt, display: s.verbose },
              { triggerTurn: true },
            );
            return "dispatched";
          }
        }
      }
    } catch {
      // Triage check failure is non-fatal
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

      ctx.ui.notify(
        `Executing quick-task: ${capture.id} — "${capture.text}"`,
        "info",
      );

      if (s.currentUnit) {
        await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt);
      }

      const qtUnitType = "quick-task";
      const qtUnitId = `${s.currentMilestoneId}/${capture.id}`;
      const qtStartedAt = Date.now();
      s.currentUnit = { type: qtUnitType, id: qtUnitId, startedAt: qtStartedAt };
      writeUnitRuntimeRecord(s.basePath, qtUnitType, qtUnitId, qtStartedAt, {
        phase: "dispatched",
        wrapupWarningSent: false,
        timeoutAt: null,
        lastProgressAt: qtStartedAt,
        progressCount: 0,
        lastProgressKind: "dispatch",
      });
      const state = await deriveState(s.basePath);
      updateProgressWidget(ctx, qtUnitType, qtUnitId, state);

      const result = await s.cmdCtx!.newSession();
      if (result.cancelled) {
        await stopAuto(ctx, pi);
        return "stopped";
      }
      const sessionFile = ctx.sessionManager.getSessionFile();
      writeLock(lockBase(), qtUnitType, qtUnitId, s.completedUnits.length, sessionFile);

      markCaptureExecuted(s.basePath, capture.id);

      const supervisor = resolveAutoSupervisorConfig();
      const qtTimeoutMs = (supervisor.hard_timeout_minutes ?? 30) * 60 * 1000;
      s.unitTimeoutHandle = setTimeout(async () => {
        s.unitTimeoutHandle = null;
        if (!s.active) return;
        ctx.ui.notify(
          `Quick-task ${capture.id} exceeded timeout. Pausing auto-mode.`,
          "warning",
        );
        await pauseAuto(ctx, pi);
      }, qtTimeoutMs);

      if (!s.active) return "stopped";
      pi.sendMessage(
        { customType: "gsd-auto", content: prompt, display: s.verbose },
        { triggerTurn: true },
      );
      return "dispatched";
    } catch {
      // Non-fatal — proceed to normal dispatch
    }
  }

  // Step mode → show wizard instead of dispatch
  if (s.stepMode) {
    return "step-wizard";
  }

  return "continue";
}
