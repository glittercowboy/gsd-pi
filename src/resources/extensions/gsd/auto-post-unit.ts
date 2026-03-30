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
} from "./auto-recovery.js";
import { regenerateIfMissing } from "./workflow-projections.js";
import { syncStateToProjectRoot } from "./auto-worktree.js";
import { isDbAvailable, getTask, getSlice, getMilestone, updateTaskStatus, _getAdapter } from "./gsd-db.js";
import { renderPlanCheckboxes } from "./markdown-renderer.js";
import { consumeSignal } from "./session-status-io.js";
import {
  checkPostUnitHooks,
  isRetryPending,
  consumeRetryTrigger,
  persistHookState,
  resolveHookArtifactPath,
} from "./post-unit-hooks.js";
import { hasPendingCaptures, loadPendingCaptures } from "./captures.js";
import { debugLog } from "./debug-logger.js";
import { runSafely } from "./auto-utils.js";
import type { AutoSession, SidecarItem } from "./auto/session.js";


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
      rogues.push({ path: summaryPath, unitType, unitId });
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
          process.stderr.write(`gsd-triage: ${action}\n`);
        }
      } catch (err) {
        process.stderr.write(`gsd-triage: resolution execution failed: ${(err as Error).message}\n`);
      }
    }

    // Rogue file detection — safety net for LLM bypassing completion tools (D003)
    try {
      const rogueFiles = detectRogueFileWrites(s.currentUnit.type, s.currentUnit.id, s.basePath);
      for (const rogue of rogueFiles) {
        process.stderr.write(`gsd-rogue: detected rogue file write: ${rogue.path} (unit: ${rogue.unitId})\n`);
        ctx.ui.notify(`Rogue file write detected: ${rogue.path}`, "warning");
      }
    } catch (e) {
      debugLog("postUnit", { phase: "rogue-detection", error: String(e) });
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
      //
      // HOWEVER, if the DB is unavailable (db_unavailable), the artifact was never
      // written because the completion tool failed at the infra level. Retrying
      // can never succeed and produces a costly re-dispatch loop (#2517).
      if (!triggerArtifactVerified && !isDbAvailable()) {
        // DB infra failure — do NOT retry; the completion tool returned
        // db_unavailable so the artifact was never written. Retrying would
        // produce an infinite re-dispatch loop (#2517).
        debugLog("postUnit", { phase: "artifact-verify-skip-db-unavailable", unitType: s.currentUnit.type, unitId: s.currentUnit.id });
        ctx.ui.notify(
          `Artifact missing for ${s.currentUnit.type} ${s.currentUnit.id} but DB is unavailable — skipping retry to avoid loop (#2517)`,
          "error",
        );
      } else if (!triggerArtifactVerified) {
        const hasExpectedArtifact = resolveExpectedArtifactPath(s.currentUnit.type, s.currentUnit.id, s.basePath) !== null;
        if (hasExpectedArtifact) {
          const retryKey = `${s.currentUnit.type}:${s.currentUnit.id}`;
          const attempt = (s.verificationRetryCount.get(retryKey) ?? 0) + 1;
          s.verificationRetryCount.set(retryKey, attempt);
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
              process.stderr.write(
                `gsd: retry state-reset failed (DB unavailable): ${(dbErr as Error).message}. Run 'gsd recover' to reconcile.\n`,
              );
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
