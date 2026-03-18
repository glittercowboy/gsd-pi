/**
 * GSD Auto Mode — Fresh Session Per Unit
 *
 * State machine driven by .gsd/ files on disk. Each "unit" of work
 * (plan slice, execute task, complete slice) gets a fresh session via
 * the stashed ctx.newSession() pattern.
 *
 * The extension reads disk state after each agent_end, determines the
 * next unit type, creates a fresh session, and injects a focused prompt
 * telling the LLM which files to read and what to do.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@gsd/pi-coding-agent";

import { deriveState } from "./state.js";
import type { GSDState } from "./types.js";
import { loadFile, getManifestStatus, resolveAllOverrides, parsePlan, parseSummary } from "./files.js";
import { loadPrompt } from "./prompt-loader.js";
import { runVerificationGate, formatFailureContext, captureRuntimeErrors, runDependencyAudit } from "./verification-gate.js";
import { writeVerificationJSON } from "./verification-evidence.js";
export { inlinePriorMilestoneSummary } from "./files.js";
import { collectSecretsFromManifest } from "../get-secrets-from-user.js";
import {
  gsdRoot, resolveMilestoneFile, resolveSliceFile, resolveSlicePath,
  resolveMilestonePath, resolveDir, resolveTasksDir, resolveTaskFile,
  milestonesDir, buildTaskFileName,
} from "./paths.js";
import { invalidateAllCaches } from "./cache.js";
import { saveActivityLog, clearActivityLogState } from "./activity-log.js";
import { synthesizeCrashRecovery, getDeepDiagnostic } from "./session-forensics.js";
import { writeLock, clearLock, readCrashLock, formatCrashInfo, isLockProcessAlive } from "./crash-recovery.js";
import {
  clearUnitRuntimeRecord,
  inspectExecuteTaskDurability,
  readUnitRuntimeRecord,
  writeUnitRuntimeRecord,
} from "./unit-runtime.js";
import { resolveAutoSupervisorConfig, loadEffectiveGSDPreferences, resolveSkillDiscoveryMode, getIsolationMode } from "./preferences.js";
import { sendDesktopNotification } from "./notifications.js";
import type { GSDPreferences } from "./preferences.js";
import {
  type BudgetAlertLevel,
  getBudgetAlertLevel,
  getNewBudgetAlertLevel,
  getBudgetEnforcementAction,
} from "./auto-budget.js";
import {
  markToolStart as _markToolStart,
  markToolEnd as _markToolEnd,
  getOldestInFlightToolAgeMs as _getOldestInFlightToolAgeMs,
  getInFlightToolCount,
  getOldestInFlightToolStart,
  clearInFlightTools,
} from "./auto-tool-tracking.js";
import {
  collectObservabilityWarnings as _collectObservabilityWarnings,
  buildObservabilityRepairBlock,
} from "./auto-observability.js";
import { closeoutUnit } from "./auto-unit-closeout.js";
import { recoverTimedOutUnit } from "./auto-timeout-recovery.js";
import { selectAndApplyModel } from "./auto-model-selection.js";
import {
  syncProjectRootToWorktree,
  syncStateToProjectRoot,
  readResourceVersion,
  checkResourcesStale,
  escapeStaleWorktree,
} from "./auto-worktree-sync.js";
// complexity-classifier + model-router imports moved to auto-model-selection.ts
import { initRoutingHistory, resetRoutingHistory, recordOutcome } from "./routing-history.js";
import {
  checkPostUnitHooks,
  getActiveHook,
  resetHookState,
  isRetryPending,
  consumeRetryTrigger,
  runPreDispatchHooks,
  persistHookState,
  restoreHookState,
  clearPersistedHookState,
} from "./post-unit-hooks.js";
// observability-validator imports moved to auto-observability.ts
import { ensureGitignore, untrackRuntimeFiles } from "./gitignore.js";
import { runGSDDoctor, rebuildState, summarizeDoctorIssues } from "./doctor.js";
import {
  preDispatchHealthGate,
  recordHealthSnapshot,
  checkHealEscalation,
  resetProactiveHealing,
  formatHealthSummary,
  getConsecutiveErrorUnits,
} from "./doctor-proactive.js";
import { snapshotSkills, clearSkillSnapshot } from "./skill-discovery.js";
import { captureAvailableSkills, getAndClearSkills, resetSkillTelemetry } from "./skill-telemetry.js";
import {
  initMetrics, resetMetrics, getLedger,
  getProjectTotals, formatCost, formatTokenCount,
} from "./metrics.js";
import { computeBudgets, resolveExecutorContextWindow } from "./context-budget.js";
import { GSDError, GSD_ARTIFACT_MISSING } from "./errors.js";
import { join } from "node:path";
import { sep as pathSep } from "node:path";
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { atomicWriteSync } from "./atomic-write.js";
import { nativeIsRepo, nativeInit, nativeAddAll, nativeCommit } from "./native-git-bridge.js";
import {
  autoCommitCurrentBranch,
  captureIntegrationBranch,
  detectWorktreeName,
  getCurrentBranch,
  getMainBranch,
  MergeConflictError,
  parseSliceBranch,
  setActiveMilestoneId,
} from "./worktree.js";
import { GitServiceImpl, type TaskCommitContext } from "./git-service.js";
import { getPriorSliceCompletionBlocker } from "./dispatch-guard.js";
import { formatGitError } from "./git-self-heal.js";
import {
  createAutoWorktree,
  enterAutoWorktree,
  teardownAutoWorktree,
  isInAutoWorktree,
  getAutoWorktreePath,
  getAutoWorktreeOriginalBase,
  mergeMilestoneToMain,
  autoWorktreeBranch,
} from "./auto-worktree.js";
import { pruneQueueOrder } from "./queue-order.js";
import { consumeSignal } from "./session-status-io.js";
import { showNextAction } from "../shared/mod.js";
import { debugLog, debugTime, debugCount, debugPeak, enableDebug, isDebugEnabled, writeDebugSummary, getDebugLogPath } from "./debug-logger.js";
import {
  resolveExpectedArtifactPath,
  verifyExpectedArtifact,
  writeBlockerPlaceholder,
  diagnoseExpectedArtifact,
  skipExecuteTask,
  completedKeysPath,
  persistCompletedKey,
  removePersistedKey,
  loadPersistedKeys,
  selfHealRuntimeRecords,
  buildLoopRemediationSteps,
  reconcileMergeState,
} from "./auto-recovery.js";
import { resolveDispatch, resetRewriteCircuitBreaker } from "./auto-dispatch.js";
// Prompt builders moved to auto-direct-dispatch.ts (only used there now)
import {
  type AutoDashboardData,
  updateProgressWidget as _updateProgressWidget,
  updateSliceProgressCache,
  clearSliceProgressCache,
  describeNextUnit as _describeNextUnit,
  unitVerb,
  formatAutoElapsed as _formatAutoElapsed,
  formatWidgetTokens,
  hideFooter,
  type WidgetStateAccessors,
} from "./auto-dashboard.js";
import {
  registerSigtermHandler as _registerSigtermHandler,
  deregisterSigtermHandler as _deregisterSigtermHandler,
  detectWorkingTreeActivity,
} from "./auto-supervisor.js";
import { isDbAvailable } from "./gsd-db.js";
import { hasPendingCaptures, loadPendingCaptures, countPendingCaptures } from "./captures.js";

// Worktree sync, resource staleness, stale worktree escape → auto-worktree-sync.ts

// ─── Session State ─────────────────────────────────────────────────────────

import {
  AutoSession,
  MAX_UNIT_DISPATCHES, STUB_RECOVERY_THRESHOLD, MAX_LIFETIME_DISPATCHES,
  MAX_CONSECUTIVE_SKIPS, DISPATCH_GAP_TIMEOUT_MS, MAX_SKIP_DEPTH,
} from "./auto/session.js";
import type { CompletedUnit, CurrentUnit, UnitRouting, StartModel, PendingVerificationRetry } from "./auto/session.js";
export {
  MAX_UNIT_DISPATCHES, STUB_RECOVERY_THRESHOLD, MAX_LIFETIME_DISPATCHES,
  MAX_CONSECUTIVE_SKIPS, DISPATCH_GAP_TIMEOUT_MS, MAX_SKIP_DEPTH,
} from "./auto/session.js";
export type { CompletedUnit, CurrentUnit, UnitRouting, StartModel } from "./auto/session.js";

// ── ENCAPSULATION INVARIANT ─────────────────────────────────────────────────
// ALL mutable auto-mode state lives in the AutoSession class (auto/session.ts).
// This file must NOT declare module-level `let` or `var` variables for state.
// The single `s` instance below is the only mutable module-level binding.
//
// When adding features or fixing bugs:
//   - New mutable state → add a property to AutoSession, not a module-level variable
//   - New constants → module-level `const` is fine (immutable)
//   - New state that needs reset on stopAuto → add to AutoSession.reset()
//
// Tests in auto-session-encapsulation.test.ts enforce this invariant.
// ─────────────────────────────────────────────────────────────────────────────
const s = new AutoSession();

/** Throttle STATE.md rebuilds — at most once per 30 seconds */
const STATE_REBUILD_MIN_INTERVAL_MS = 30_000;

export function shouldUseWorktreeIsolation(): boolean {
  const prefs = loadEffectiveGSDPreferences()?.preferences?.git;
  if (prefs?.isolation === "none") return false;
  if (prefs?.isolation === "branch") return false;
  return true; // default: worktree
}

/** Crash recovery prompt — set by startAuto, consumed by first dispatchNextUnit */

/** Pending verification retry — set when gate fails with retries remaining, consumed by dispatchNextUnit */

/** Verification retry count per unitId — separate from s.unitDispatchCount which tracks artifact-missing retries */

/** Session file path captured at pause — used to synthesize recovery briefing on resume */

/** Dashboard tracking */

/** Track dynamic routing decision for the current unit (for metrics) */

/** Queue of quick-task captures awaiting dispatch after triage resolution */

/**
 * Model captured at auto-mode start. Used to prevent model bleed between
 * concurrent GSD instances sharing the same global settings.json (#650).
 * When preferences don't specify a model for a unit type, this ensures
 * the session's original model is re-applied instead of reading from
 * the shared global settings (which another instance may have overwritten).
 */

/** Track current milestone to detect transitions */

/** Model the user had selected before auto-mode started */

/** Progress-aware timeout supervision */

/** Context-pressure continue-here monitor — fires once when context usage >= 70% */

/** Dispatch gap watchdog — detects when the state machine stalls between units.
 *  After handleAgentEnd completes, if auto-mode is still active but no new unit
 *  has been dispatched (sendMessage not called), this timer fires to force a
 *  re-evaluation. Covers the case where dispatchNextUnit silently fails or
 *  an unhandled error kills the dispatch chain. */

/** Prompt character measurement for token savings analysis (R051). */

/** SIGTERM handler registered while auto-mode is active — cleared on stop/pause. */

/**
 * Tool calls currently being executed — prevents false idle detection during long-running tools.
 * Maps toolCallId → start timestamp (ms) so the idle watchdog can detect tools that have been
 * running suspiciously long (e.g., a Bash command hung because `&` kept stdout open).
 */
// Re-export budget utilities for external consumers
export { getBudgetAlertLevel, getNewBudgetAlertLevel, getBudgetEnforcementAction } from "./auto-budget.js";

/** Wrapper: register SIGTERM handler and store reference. */
function registerSigtermHandler(currentBasePath: string): void {
  s.sigtermHandler = _registerSigtermHandler(currentBasePath, s.sigtermHandler);
}

/** Wrapper: deregister SIGTERM handler and clear reference. */
function deregisterSigtermHandler(): void {
  _deregisterSigtermHandler(s.sigtermHandler);
  s.sigtermHandler = null;
}

export { type AutoDashboardData } from "./auto-dashboard.js";

export function getAutoDashboardData(): AutoDashboardData {
  const ledger = getLedger();
  const totals = ledger ? getProjectTotals(ledger.units) : null;
  // Pending capture count — lazy check, non-fatal
  let pendingCaptureCount = 0;
  try {
    if (s.basePath) {
      pendingCaptureCount = countPendingCaptures(s.basePath);
    }
  } catch {
    // Non-fatal — captures module may not be loaded
  }
  return { active: s.active, paused: s.paused,
    stepMode: s.stepMode,
    startTime: s.autoStartTime,
    elapsed: (s.active || s.paused) ? Date.now() - s.autoStartTime : 0,
    currentUnit: s.currentUnit ? { ...s.currentUnit } : null,
    completedUnits: [...s.completedUnits], basePath: s.basePath,
    totalCost: totals?.cost ?? 0,
    totalTokens: totals?.tokens.total ?? 0,
    pendingCaptureCount,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function isAutoActive(): boolean {
  return s.active;
}

export function isAutoPaused(): boolean {
  return s.paused;
}

// Tool tracking — delegates to auto-tool-tracking.ts
export function markToolStart(toolCallId: string): void {
  _markToolStart(toolCallId, s.active);
}

export function markToolEnd(toolCallId: string): void {
  _markToolEnd(toolCallId);
}

export function getOldestInFlightToolAgeMs(): number {
  return _getOldestInFlightToolAgeMs();
}

/**
 * Return the base path to use for the auto.lock file.
 * Always uses the original project root (not the worktree) so that
 * a second terminal can discover and stop a running auto-mode session.
 */
function lockBase(): string {
  return s.originalBasePath || s.basePath;
}

/**
 * Attempt to stop a running auto-mode session from a different process.
 * Reads the lock file at the project root, checks if the PID is alive,
 * and sends SIGTERM to gracefully stop it.
 *
 * Returns true if a remote session was found and signaled, false otherwise.
 */
export function stopAutoRemote(projectRoot: string): { found: boolean; pid?: number; error?: string } {
  const lock = readCrashLock(projectRoot);
  if (!lock) return { found: false };

  if (!isLockProcessAlive(lock)) {
    // Stale lock — clean it up
    clearLock(projectRoot);
    return { found: false };
  }

  // Send SIGTERM — the auto-mode process has a handler that clears the lock and exits
  try {
    process.kill(lock.pid, "SIGTERM");
    return { found: true, pid: lock.pid };
  } catch (err) {
    return { found: false, error: (err as Error).message };
  }
}

export function isStepMode(): boolean {
  return s.stepMode;
}

function clearUnitTimeout(): void {
  if (s.unitTimeoutHandle) {
    clearTimeout(s.unitTimeoutHandle);
    s.unitTimeoutHandle = null;
  }
  if (s.wrapupWarningHandle) {
    clearTimeout(s.wrapupWarningHandle);
    s.wrapupWarningHandle = null;
  }
  if (s.idleWatchdogHandle) {
    clearInterval(s.idleWatchdogHandle);
    s.idleWatchdogHandle = null;
  }
  if (s.continueHereHandle) {
    clearInterval(s.continueHereHandle);
    s.continueHereHandle = null;
  }
  clearInFlightTools();
  clearDispatchGapWatchdog();
}

function clearDispatchGapWatchdog(): void {
  if (s.dispatchGapHandle) {
    clearTimeout(s.dispatchGapHandle);
    s.dispatchGapHandle = null;
  }
}

/** Build snapshot metric opts, enriching with continueHereFired from the runtime record. */
function buildSnapshotOpts(unitType: string, unitId: string): { continueHereFired?: boolean; promptCharCount?: number; baselineCharCount?: number } & Record<string, unknown> {
  const runtime = s.currentUnit ? readUnitRuntimeRecord(s.basePath, unitType, unitId) : null;
  return {
    promptCharCount: s.lastPromptCharCount,
    baselineCharCount: s.lastBaselineCharCount,
    ...(s.currentUnitRouting ?? {}),
    ...(runtime?.continueHereFired ? { continueHereFired: true } : {}),
  };
}

/**
 * Start a watchdog that fires if no new unit is dispatched within DISPATCH_GAP_TIMEOUT_MS
 * after handleAgentEnd completes. This catches the case where the dispatch chain silently
 * breaks (e.g., unhandled exception in dispatchNextUnit) and auto-mode is left s.active but idle.
 *
 * The watchdog is cleared on the next successful unit dispatch (clearUnitTimeout is called
 * at the start of handleAgentEnd, which calls clearDispatchGapWatchdog).
 */
function startDispatchGapWatchdog(ctx: ExtensionContext, pi: ExtensionAPI): void {
  clearDispatchGapWatchdog();
  s.dispatchGapHandle = setTimeout(async () => {
    s.dispatchGapHandle = null;
    if (!s.active || !s.cmdCtx) return;

    // Auto-mode is active but no unit was dispatched — the state machine stalled.
    // Re-derive state and attempt a fresh dispatch.
    if (s.verbose) {
      ctx.ui.notify(
        "Dispatch gap detected — re-evaluating state.",
        "info",
      );
    }

    try {
      await dispatchNextUnit(ctx, pi);
    } catch (retryErr) {
      const message = retryErr instanceof Error ? retryErr.message : String(retryErr);
      await stopAuto(ctx, pi, `Dispatch gap recovery failed: ${message}`);
      return;
    }

    // If dispatchNextUnit returned normally but still didn't dispatch a unit
    // (no sendMessage called → no timeout set), auto-mode is permanently
    // stalled. Stop cleanly instead of leaving it s.active but idle (#537).
    if (s.active && !s.unitTimeoutHandle && !s.wrapupWarningHandle) {
      await stopAuto(ctx, pi, "Stalled — no dispatchable unit after retry");
    }
  }, DISPATCH_GAP_TIMEOUT_MS);
}

export async function stopAuto(ctx?: ExtensionContext, pi?: ExtensionAPI, reason?: string): Promise<void> {
  if (!s.active && !s.paused) return;
  const reasonSuffix = reason ? ` — ${reason}` : "";
  clearUnitTimeout();
  if (lockBase()) clearLock(lockBase());
  clearSkillSnapshot();
  resetSkillTelemetry();
  s.dispatching = false;
  s.skipDepth = 0;

  // Remove SIGTERM handler registered at auto-mode start
  deregisterSigtermHandler();

  // ── Auto-worktree: exit worktree and reset s.basePath on stop ──
  // Preserve the milestone branch so the next /gsd auto can re-enter
  // where it left off. The branch is only deleted during milestone
  // completion (mergeMilestoneToMain) after the work has been squash-merged.
  if (s.currentMilestoneId && isInAutoWorktree(s.basePath)) {
    try {
      // Auto-commit any dirty state before leaving so work isn't lost
      try { autoCommitCurrentBranch(s.basePath, "stop", s.currentMilestoneId); } catch (e) { debugLog("stop-auto-commit-failed", { error: e instanceof Error ? e.message : String(e) }); }
      teardownAutoWorktree(s.originalBasePath, s.currentMilestoneId, { preserveBranch: true });
      s.basePath = s.originalBasePath;
      s.gitService = new GitServiceImpl(s.basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});
      ctx?.ui.notify("Exited auto-worktree (branch preserved for resume).", "info");
    } catch (err) {
      ctx?.ui.notify(
        `Auto-worktree teardown failed: ${err instanceof Error ? err.message : String(err)}`,
        "warning",
      );
    }
  }

  // ── DB cleanup: close the SQLite connection ──
  if (isDbAvailable()) {
    try {
      const { closeDatabase } = await import("./gsd-db.js");
      closeDatabase();
    } catch (e) { debugLog("db-close-failed", { error: e instanceof Error ? e.message : String(e) }); }
  }

  // Always restore cwd to project root on stop (#608).
  // Even if isInAutoWorktree returned false (e.g., module state was already
  // cleared by mergeMilestoneToMain), the process cwd may still be inside
  // the worktree directory. Force it back to s.originalBasePath.
  if (s.originalBasePath) {
    s.basePath = s.originalBasePath;
    try { process.chdir(s.basePath); } catch { /* best-effort */ }
  }

  const ledger = getLedger();
  if (ledger && ledger.units.length > 0) {
    const totals = getProjectTotals(ledger.units);
    ctx?.ui.notify(
      `Auto-mode stopped${reasonSuffix}. Session: ${formatCost(totals.cost)} · ${formatTokenCount(totals.tokens.total)} tokens · ${ledger.units.length} units`,
      "info",
    );
  } else {
    ctx?.ui.notify(`Auto-mode stopped${reasonSuffix}.`, "info");
  }

  // Sync disk state so next resume starts from accurate state
  if (s.basePath) {
    try { await rebuildState(s.basePath); } catch (e) { debugLog("stop-rebuild-state-failed", { error: e instanceof Error ? e.message : String(e) }); }
  }

  // Write debug summary before resetting state
  if (isDebugEnabled()) {
    const logPath = writeDebugSummary();
    if (logPath) {
      ctx?.ui.notify(`Debug log written → ${logPath}`, "info");
    }
  }

  resetMetrics();
  resetRoutingHistory();
  resetHookState();
  if (s.basePath) clearPersistedHookState(s.basePath);
  s.active = false;
  s.paused = false;
  s.stepMode = false;
  s.unitDispatchCount.clear();
  s.unitRecoveryCount.clear();
  s.unitConsecutiveSkips.clear();
  clearInFlightTools();
  s.lastBudgetAlertLevel = 0;
  s.lastStateRebuildAt = 0;
  s.unitLifetimeDispatches.clear();
  s.currentUnit = null;
  s.autoModeStartModel = null;
  s.currentMilestoneId = null;
  s.originalBasePath = "";
  s.completedUnits = [];
  s.pendingQuickTasks = [];
  clearSliceProgressCache();
  clearActivityLogState();
  resetProactiveHealing();
  s.recentlyEvictedKeys.clear();
  s.pendingCrashRecovery = null;
  s.pendingVerificationRetry = null;
  s.verificationRetryCount.clear();
  s.pausedSessionFile = null;
  s.handlingAgentEnd = false;
  ctx?.ui.setStatus("gsd-auto", undefined);
  ctx?.ui.setWidget("gsd-progress", undefined);
  ctx?.ui.setFooter(undefined);

  // Restore the user's original model
  if (pi && ctx && s.originalModelId && s.originalModelProvider) {
    const original = ctx.modelRegistry.find(s.originalModelProvider, s.originalModelId);
    if (original) await pi.setModel(original);
    s.originalModelId = null;
    s.originalModelProvider = null;
  }

  s.cmdCtx = null;
}

/**
 * Pause auto-mode without destroying state. Context is preserved.
 * The user can interact with the agent, then `/gsd auto` resumes
 * from disk state. Called when the user presses Escape during auto-mode.
 */
export async function pauseAuto(ctx?: ExtensionContext, _pi?: ExtensionAPI): Promise<void> {
  if (!s.active) return;
  clearUnitTimeout();

  // Capture the current session file before clearing state — used for
  // recovery briefing on resume so the next agent knows what already happened.
  s.pausedSessionFile = ctx?.sessionManager?.getSessionFile() ?? null;

  if (lockBase()) clearLock(lockBase());

  // Remove SIGTERM handler registered at auto-mode start
  deregisterSigtermHandler();

  s.active = false;
  s.paused = true;
  s.pendingVerificationRetry = null;
  s.verificationRetryCount.clear();
  // Preserve: s.unitDispatchCount, s.currentUnit, s.basePath, s.verbose, s.cmdCtx,
  // s.completedUnits, s.autoStartTime, s.currentMilestoneId, s.originalModelId
  // — all needed for resume and dashboard display
  ctx?.ui.setStatus("gsd-auto", "paused");
  ctx?.ui.setWidget("gsd-progress", undefined);
  ctx?.ui.setFooter(undefined);
  const resumeCmd = s.stepMode ? "/gsd next" : "/gsd auto";
  ctx?.ui.notify(
    `${s.stepMode ? "Step" : "Auto"}-mode paused (Escape). Type to interact, or ${resumeCmd} to resume.`,
    "info",
  );
}


export async function startAuto(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  base: string,
  verboseMode: boolean,
  options?: { step?: boolean },
): Promise<void> {
  const requestedStepMode = options?.step ?? false;

  // Escape stale worktree cwd from a previous milestone (#608).
  // After milestone merge + worktree removal, the process cwd may still point
  // inside .gsd/worktrees/<MID>/ — detect and chdir back to project root.
  base = escapeStaleWorktree(base);

  // If resuming from paused state, just re-activate and dispatch next unit.
  // The conversation is still intact — no need to reinitialize everything.
  if (s.paused) {
    s.paused = false;
    s.active = true;
    s.verbose = verboseMode;
    // Allow switching between step/auto on resume
    s.stepMode = requestedStepMode;
    s.cmdCtx = ctx;
    s.basePath = base;
    s.unitDispatchCount.clear();
    s.unitLifetimeDispatches.clear();
    s.unitConsecutiveSkips.clear();
    // Re-initialize metrics in case ledger was lost during pause
    if (!getLedger()) initMetrics(base);
    // Ensure milestone ID is set on git service for integration branch resolution
    if (s.currentMilestoneId) setActiveMilestoneId(base, s.currentMilestoneId);

    // ── Auto-worktree: re-enter worktree on resume if not already inside ──
    // Skip if already inside a worktree (manual /worktree) to prevent nesting.
    // Skip entirely in branch or none isolation mode (#531).
    if (s.currentMilestoneId && shouldUseWorktreeIsolation() && s.originalBasePath && !isInAutoWorktree(s.basePath) && !detectWorktreeName(s.basePath) && !detectWorktreeName(s.originalBasePath)) {
      try {
        const existingWtPath = getAutoWorktreePath(s.originalBasePath, s.currentMilestoneId);
        if (existingWtPath) {
          const wtPath = enterAutoWorktree(s.originalBasePath, s.currentMilestoneId);
          s.basePath = wtPath;
          s.gitService = new GitServiceImpl(s.basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});
          ctx.ui.notify(`Re-entered auto-worktree at ${wtPath}`, "info");
        } else {
          // Worktree was deleted while paused — recreate it.
          const wtPath = createAutoWorktree(s.originalBasePath, s.currentMilestoneId);
          s.basePath = wtPath;
          s.gitService = new GitServiceImpl(s.basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});
          ctx.ui.notify(`Recreated auto-worktree at ${wtPath}`, "info");
        }
      } catch (err) {
        ctx.ui.notify(
          `Auto-worktree re-entry failed: ${err instanceof Error ? err.message : String(err)}. Continuing at current path.`,
          "warning",
        );
      }
    }

    // Re-register SIGTERM handler for the resumed session (use original base for lock)
    registerSigtermHandler(lockBase());

    ctx.ui.setStatus("gsd-auto", s.stepMode ? "next" : "auto");
    ctx.ui.setFooter(hideFooter);
    ctx.ui.notify(s.stepMode ? "Step-mode resumed." : "Auto-mode resumed.", "info");
    // Restore hook state from disk in case session was interrupted
    restoreHookState(s.basePath);
    // Rebuild disk state before resuming — user interaction during pause may have changed files
    try { await rebuildState(s.basePath); } catch (e) { debugLog("resume-rebuild-state-failed", { error: e instanceof Error ? e.message : String(e) }); }
    try {
      const report = await runGSDDoctor(s.basePath, { fix: true });
      if (report.fixesApplied.length > 0) {
        ctx.ui.notify(`Resume: applied ${report.fixesApplied.length} fix(es) to state.`, "info");
      }
    } catch (e) { debugLog("resume-doctor-failed", { error: e instanceof Error ? e.message : String(e) }); }
    // Self-heal: clear stale runtime records where artifacts already exist
    await selfHealRuntimeRecords(s.basePath, ctx, s.completedKeySet);
    invalidateAllCaches();

    // Synthesize recovery briefing from the paused session so the next agent
    // knows what already happened (reuses crash recovery infrastructure).
    if (s.pausedSessionFile) {
      const activityDir = join(gsdRoot(s.basePath), "activity");
      const recovery = synthesizeCrashRecovery(
        s.basePath,
        s.currentUnit?.type ?? "unknown",
        s.currentUnit?.id ?? "unknown", s.pausedSessionFile ?? undefined,
        activityDir,
      );
      if (recovery && recovery.trace.toolCallCount > 0) {
        s.pendingCrashRecovery = recovery.prompt;
        ctx.ui.notify(
          `Recovered ${recovery.trace.toolCallCount} tool calls from paused session. Resuming with context.`,
          "info",
        );
      }
      s.pausedSessionFile = null;
    }

    // Write lock on resume so cross-process status detection works (#723).
    writeLock(lockBase(), "resuming", s.currentMilestoneId ?? "unknown", s.completedUnits.length);

    await dispatchNextUnit(ctx, pi);
    return;
  }

  // Ensure git repo exists — GSD needs it for commits and state tracking
  if (!nativeIsRepo(base)) {
    const mainBranch = loadEffectiveGSDPreferences()?.preferences?.git?.main_branch || "main";
    nativeInit(base, mainBranch);
  }

  // Ensure .gitignore has baseline patterns
  const gitPrefs = loadEffectiveGSDPreferences()?.preferences?.git;
  const commitDocs = gitPrefs?.commit_docs;
  const manageGitignore = gitPrefs?.manage_gitignore;
  ensureGitignore(base, { commitDocs, manageGitignore });
  if (manageGitignore !== false) untrackRuntimeFiles(base);

  // Bootstrap .gsd/ if it doesn't exist
  const gsdDir = join(base, ".gsd");
  if (!existsSync(gsdDir)) {
    mkdirSync(join(gsdDir, "milestones"), { recursive: true });
    // Only commit .gsd/ init when commit_docs is not explicitly false
    if (commitDocs !== false) {
      try {
        nativeAddAll(base);
        nativeCommit(base, "chore: init gsd");
      } catch { /* nothing to commit */ }
    }
  }

  // Initialize GitServiceImpl — s.basePath is set and git repo confirmed
  s.gitService = new GitServiceImpl(s.basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});

  // Check for crash from previous session
  const crashLock = readCrashLock(base);
  if (crashLock) {
    if (isLockProcessAlive(crashLock)) {
      // The lock belongs to a process that is still running — not a crash.
      // Warn the user and abort to avoid two concurrent auto-mode sessions.
      ctx.ui.notify(
        `Another auto-mode session (PID ${crashLock.pid}) appears to be running.\nStop it with \`kill ${crashLock.pid}\` before starting a new session.`,
        "error",
      );
      return;
    }
    // Stale lock from a dead process — validate before synthesizing recovery context.
    // If the recovered unit belongs to a fully-completed milestone (SUMMARY exists),
    // discard recovery context to prevent phantom skip loops (#790).
    const recoveredMid = crashLock.unitId.split("/")[0];
    const milestoneAlreadyComplete = recoveredMid
      ? !!resolveMilestoneFile(base, recoveredMid, "SUMMARY")
      : false;

    if (milestoneAlreadyComplete) {
      ctx.ui.notify(
        `Crash recovery: discarding stale context for ${crashLock.unitId} — milestone ${recoveredMid} is already complete.`,
        "info",
      );
    } else {
      const activityDir = join(gsdRoot(base), "activity");
      const recovery = synthesizeCrashRecovery(
        base, crashLock.unitType, crashLock.unitId,
        crashLock.sessionFile, activityDir,
      );
      if (recovery && recovery.trace.toolCallCount > 0) {
        s.pendingCrashRecovery = recovery.prompt;
        ctx.ui.notify(
          `${formatCrashInfo(crashLock)}\nRecovered ${recovery.trace.toolCallCount} tool calls from crashed session. Resuming with full context.`,
          "warning",
        );
      } else {
        ctx.ui.notify(
          `${formatCrashInfo(crashLock)}\nNo session data recovered. Resuming from disk state.`,
          "warning",
        );
      }
    }
    clearLock(base);
  }

  // ── Debug mode: env-var activation ──────────────────────────────────────
  if (!isDebugEnabled() && process.env.GSD_DEBUG === "1") {
    enableDebug(base);
  }
  if (isDebugEnabled()) {
    const { isNativeParserAvailable } = await import("./native-parser-bridge.js");
    debugLog("debug-start", {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      model: ctx.model?.id ?? "unknown",
      provider: ctx.model?.provider ?? "unknown",
      nativeParser: isNativeParserAvailable(),
      cwd: base,
    });
    ctx.ui.notify(`Debug logging enabled → ${getDebugLogPath()}`, "info");
  }

  // Invalidate all caches before initial state derivation to ensure we read
  // fresh disk state. Without this, a stale cache from a prior session (e.g.
  // after a discussion that wrote new artifacts) may cause deriveState to
  // return pre-planning when the roadmap already exists (#800).
  invalidateAllCaches();

  // ── Clean stale runtime unit files for completed milestones (#887) ───────
  // After resource-update restart, stale runtime/units/*.json files from
  // previously completed milestones can cause deriveState to resume the wrong
  // milestone. If a milestone has a SUMMARY file, its unit files are stale.
  try {
    const runtimeUnitsDir = join(gsdRoot(base), "runtime", "units");
    if (existsSync(runtimeUnitsDir)) {
      for (const file of readdirSync(runtimeUnitsDir)) {
        if (!file.endsWith(".json")) continue;
        const midMatch = file.match(/(M\d+(?:-[a-z0-9]{6})?)/);
        if (!midMatch) continue;
        const mid = midMatch[1];
        if (resolveMilestoneFile(base, mid, "SUMMARY")) {
          try { unlinkSync(join(runtimeUnitsDir, file)); } catch (e) { debugLog("stale-unit-cleanup-failed", { file, error: e instanceof Error ? e.message : String(e) }); }
        }
      }
    }
  } catch (e) { debugLog("stale-unit-dir-cleanup-failed", { error: e instanceof Error ? e.message : String(e) }); }

  let state = await deriveState(base);

  // ── Stale worktree state recovery (#654) ─────────────────────────────────
  // When auto-mode was previously stopped and restarted, the project root's
  // .gsd/ directory may have stale metadata (completed units showing as
  // incomplete). If an auto-worktree exists for the active milestone, it has
  // the current state — re-derive from there to avoid re-dispatching
  // finished work.
  if (
    state.activeMilestone &&
    shouldUseWorktreeIsolation() &&
    !detectWorktreeName(base)
  ) {
    const wtPath = getAutoWorktreePath(base, state.activeMilestone.id);
    if (wtPath) {
      state = await deriveState(wtPath);
    }
  }

  // ── Milestone branch recovery (#601) ─────────────────────────────────────
  // When auto-mode was previously stopped, the milestone branch is preserved
  // but the worktree is removed. The project root (integration branch) may
  // not have the roadmap/artifacts — they live on the milestone branch.
  // If state looks like pre-planning but a milestone branch exists with prior
  // work, skip the early-return checks and let worktree setup + dispatch
  // handle it correctly from the branch's state.
  let hasSurvivorBranch = false;
  if (
    state.activeMilestone &&
    (state.phase === "pre-planning" || state.phase === "needs-discussion") &&
    shouldUseWorktreeIsolation() &&
    !detectWorktreeName(base) &&
    !base.includes(`${pathSep}.gsd${pathSep}worktrees${pathSep}`)
  ) {
    const milestoneBranch = `milestone/${state.activeMilestone.id}`;
    const { nativeBranchExists } = await import("./native-git-bridge.js");
    hasSurvivorBranch = nativeBranchExists(base, milestoneBranch);
    if (hasSurvivorBranch) {
      ctx.ui.notify(
        `Found prior session branch ${milestoneBranch}. Resuming.`,
        "info",
      );
    }
  }

  if (!hasSurvivorBranch) {
    // No active work at all — start a new milestone via the discuss flow.
    // After discussion completes, checkAutoStartAfterDiscuss() (fired from
    // agent_end) will detect the new CONTEXT.md and restart auto mode.
    // If the LLM didn't follow the discussion protocol (e.g. started editing
    // files directly for a simple task), we re-derive state and either proceed
    // with what was created or notify the user clearly (#609).
    if (!state.activeMilestone || state.phase === "complete") {
      const { showSmartEntry } = await import("./guided-flow.js");
      await showSmartEntry(ctx, pi, base, { step: requestedStepMode });

      // Re-derive state after discussion — the LLM may have created artifacts
      // even if it didn't follow the full protocol.
      invalidateAllCaches();
      const postState = await deriveState(base);
      if (postState.activeMilestone && postState.phase !== "complete" && postState.phase !== "pre-planning") {
        state = postState;
      } else if (postState.activeMilestone && postState.phase === "pre-planning") {
        const contextFile = resolveMilestoneFile(base, postState.activeMilestone.id, "CONTEXT");
        const hasContext = !!(contextFile && await loadFile(contextFile));
        if (hasContext) {
          state = postState;
        } else {
          ctx.ui.notify(
            "Discussion completed but no milestone context was written. Run /gsd to try the discussion again, or /gsd auto after creating the milestone manually.",
            "warning",
          );
          return;
        }
      } else {
        return;
      }
    }

    // Active milestone exists but has no roadmap — check if context exists.
    // If context was pre-written (multi-milestone planning), auto-mode can
    // research and plan it. If no context either, need user discussion.
    if (state.phase === "pre-planning") {
      const mid = state.activeMilestone!.id;
      const contextFile = resolveMilestoneFile(base, mid, "CONTEXT");
      const hasContext = !!(contextFile && await loadFile(contextFile));
      if (!hasContext) {
        const { showSmartEntry } = await import("./guided-flow.js");
        await showSmartEntry(ctx, pi, base, { step: requestedStepMode });

        // Same re-derive pattern as above
        invalidateAllCaches();
        const postState = await deriveState(base);
        if (postState.activeMilestone && postState.phase !== "pre-planning") {
          state = postState;
        } else {
          ctx.ui.notify(
            "Discussion completed but milestone context is still missing. Run /gsd to try again.",
            "warning",
          );
          return;
        }
      }
      // Has context, no roadmap — auto-mode will research + plan it
    }
  }

  // At this point activeMilestone is guaranteed non-null: either
  // hasSurvivorBranch is true (which requires activeMilestone) or
  // the !activeMilestone early-return above would have fired.
  if (!state.activeMilestone) {
    // Unreachable — satisfies TypeScript's null check
    const { showSmartEntry } = await import("./guided-flow.js");
    await showSmartEntry(ctx, pi, base, { step: requestedStepMode });
    return;
  }

  s.active = true;
  s.stepMode = requestedStepMode;
  s.verbose = verboseMode;
  s.cmdCtx = ctx;
  s.basePath = base;
  s.unitDispatchCount.clear();
  s.unitRecoveryCount.clear();
  s.unitConsecutiveSkips.clear();
  s.lastBudgetAlertLevel = 0;
  s.unitLifetimeDispatches.clear();
  s.completedKeySet.clear();
  loadPersistedKeys(base, s.completedKeySet);
  resetHookState();
  restoreHookState(base);
  resetProactiveHealing();
  s.autoStartTime = Date.now();
  s.resourceVersionOnStart = readResourceVersion();
  s.completedUnits = [];
  s.pendingQuickTasks = [];
  s.currentUnit = null;
  s.currentMilestoneId = state.activeMilestone?.id ?? null;
  s.originalModelId = ctx.model?.id ?? null;
  s.originalModelProvider = ctx.model?.provider ?? null;

  // Register a SIGTERM handler so `kill <pid>` cleans up the lock and exits.
  registerSigtermHandler(base);

  // Capture the integration branch — records the branch the user was on when
  // auto-mode started. Slice branches will merge back to this branch instead
  // of the repo's default (main/master). Idempotent when the branch is the
  // same; updates the record when started from a different branch (#300).
  if (s.currentMilestoneId) {
    if (getIsolationMode() !== "none") {
      captureIntegrationBranch(base, s.currentMilestoneId, { commitDocs });
    }
    setActiveMilestoneId(base, s.currentMilestoneId);
  }

  // ── Auto-worktree: create or enter worktree for the active milestone ──
  // Store the original project root before any chdir so we can restore on stop.
  // Skip if already inside a worktree (manual /worktree or another auto-worktree)
  // to prevent nested worktree creation.
  s.originalBasePath = base;

  const isUnderGsdWorktrees = (p: string): boolean => {
    // Prevent creating nested auto-worktrees when running from within any
    // `.gsd/worktrees/...` directory (including manual worktrees).
    const marker = `${pathSep}.gsd${pathSep}worktrees${pathSep}`;
    if (p.includes(marker)) {
      return true;
    }
    const worktreesSuffix = `${pathSep}.gsd${pathSep}worktrees`;
    return p.endsWith(worktreesSuffix);
  };

  if (s.currentMilestoneId && shouldUseWorktreeIsolation() && !detectWorktreeName(base) && !isUnderGsdWorktrees(base)) {
    try {
      const existingWtPath = getAutoWorktreePath(base, s.currentMilestoneId);
      if (existingWtPath) {
        // Worktree already exists (e.g., previous session created it) — enter it.
        const wtPath = enterAutoWorktree(base, s.currentMilestoneId);
        s.basePath = wtPath;
        s.gitService = new GitServiceImpl(s.basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});
        ctx.ui.notify(`Entered auto-worktree at ${wtPath}`, "info");
      } else {
        // Fresh start — create worktree and enter it.
        const wtPath = createAutoWorktree(base, s.currentMilestoneId);
        s.basePath = wtPath;
        s.gitService = new GitServiceImpl(s.basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});
        ctx.ui.notify(`Created auto-worktree at ${wtPath}`, "info");
      }
      // Re-register SIGTERM handler with the original s.basePath (lock lives there)
      registerSigtermHandler(s.originalBasePath);

      // After worktree entry, load completed keys from BOTH locations (project root
      // + worktree) so the in-memory set is the union. Prevents re-dispatch of units
      // completed in either location after crash/restart (#769).
      if (s.basePath !== s.originalBasePath) {
        loadPersistedKeys(s.basePath, s.completedKeySet);
      }
    } catch (err) {
      // Worktree creation is non-fatal — continue in the project root.
      ctx.ui.notify(
        `Auto-worktree setup failed: ${err instanceof Error ? err.message : String(err)}. Continuing in project root.`,
        "warning",
      );
    }
  }

  // ── DB lifecycle: auto-migrate or open existing database ──
  const gsdDbPath = join(s.basePath, ".gsd", "gsd.db");
  const gsdDirPath = join(s.basePath, ".gsd");
  if (existsSync(gsdDirPath) && !existsSync(gsdDbPath)) {
    const hasDecisions = existsSync(join(gsdDirPath, "DECISIONS.md"));
    const hasRequirements = existsSync(join(gsdDirPath, "REQUIREMENTS.md"));
    const hasMilestones = existsSync(join(gsdDirPath, "milestones"));
    if (hasDecisions || hasRequirements || hasMilestones) {
      try {
        const { openDatabase: openDb } = await import("./gsd-db.js");
        const { migrateFromMarkdown } = await import("./md-importer.js");
        openDb(gsdDbPath);
        migrateFromMarkdown(s.basePath);
      } catch (err) {
        process.stderr.write(`gsd-migrate: auto-migration failed: ${(err as Error).message}\n`);
      }
    }
  }
  if (existsSync(gsdDbPath) && !isDbAvailable()) {
    try {
      const { openDatabase: openDb } = await import("./gsd-db.js");
      openDb(gsdDbPath);
    } catch (err) {
      process.stderr.write(`gsd-db: failed to open existing database: ${(err as Error).message}\n`);
    }
  }

  // Initialize metrics — loads existing ledger from disk.
  // Use s.basePath (not base) so worktree-mode reads the worktree ledger (#769).
  initMetrics(s.basePath);

  // Initialize routing history for adaptive learning
  initRoutingHistory(s.basePath);

  // Capture the session's current model at auto-mode start (#650).
  // This prevents model bleed when multiple GSD instances share the
  // same global settings.json — each instance remembers its own model.
  const currentModel = ctx.model;
  if (currentModel) {
    s.autoModeStartModel = { provider: currentModel.provider, id: currentModel.id };
  }

  // Snapshot installed skills so we can detect new ones after research
  if (resolveSkillDiscoveryMode() !== "off") {
    snapshotSkills();
  }

  ctx.ui.setStatus("gsd-auto", s.stepMode ? "next" : "auto");
  ctx.ui.setFooter(hideFooter);
  const modeLabel = s.stepMode ? "Step-mode" : "Auto-mode";
  const pendingCount = state.registry.filter(m => m.status !== 'complete').length;
  const scopeMsg = pendingCount > 1
    ? `Will loop through ${pendingCount} milestones.`
    : "Will loop until milestone complete.";
  ctx.ui.notify(`${modeLabel} started. ${scopeMsg}`, "info");

  // Write initial lock file immediately so cross-process status detection
  // works even before the first unit is dispatched (#723).
  // The lock is updated with unit-specific info on each dispatch and cleared on stop.
  writeLock(lockBase(), "starting", s.currentMilestoneId ?? "unknown", 0);

  // Secrets collection gate — collect pending secrets before first dispatch
  const mid = state.activeMilestone!.id;
  try {
    const manifestStatus = await getManifestStatus(base, mid);
    if (manifestStatus && manifestStatus.pending.length > 0) {
      const result = await collectSecretsFromManifest(base, mid, ctx);
      if (result && result.applied && result.skipped && result.existingSkipped) {
        ctx.ui.notify(
          `Secrets collected: ${result.applied.length} applied, ${result.skipped.length} skipped, ${result.existingSkipped.length} already set.`,
          "info",
        );
      } else {
        ctx.ui.notify("Secrets collection skipped.", "info");
      }
    }
  } catch (err) {
    ctx.ui.notify(
      `Secrets collection error: ${err instanceof Error ? err.message : String(err)}. Continuing with next task.`,
      "warning",
    );
  }

  // Self-heal: clear stale runtime records where artifacts already exist.
  // Use s.basePath (not base) — in worktree mode, s.basePath points to the worktree
  // where runtime records and artifacts actually live (#769).
  await selfHealRuntimeRecords(s.basePath, ctx, s.completedKeySet);

  // Self-heal: remove stale .git/index.lock from prior crash.
  // A stale lock file blocks all git operations (commit, merge, checkout).
  // Only remove if older than 60 seconds (not from a concurrent process).
  try {
    const gitLockFile = join(base, ".git", "index.lock");
    if (existsSync(gitLockFile)) {
      const lockAge = Date.now() - statSync(gitLockFile).mtimeMs;
      if (lockAge > 60_000) {
        unlinkSync(gitLockFile);
        ctx.ui.notify("Removed stale .git/index.lock from prior crash.", "info");
      }
    }
  } catch (e) { debugLog("git-lock-cleanup-failed", { error: e instanceof Error ? e.message : String(e) }); }

  // Pre-flight: validate milestone queue for multi-milestone runs.
  // Warn about issues that will cause auto-mode to pause or block.
  try {
    const msDir = join(base, ".gsd", "milestones");
    if (existsSync(msDir)) {
      const milestoneIds = readdirSync(msDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && /^M\d{3}/.test(d.name))
        .map(d => d.name.match(/^(M\d{3})/)?.[1] ?? d.name);
      if (milestoneIds.length > 1) {
        const issues: string[] = [];
        for (const id of milestoneIds) {
          const draft = resolveMilestoneFile(base, id, "CONTEXT-DRAFT");
          if (draft) issues.push(`${id}: has CONTEXT-DRAFT.md (will pause for discussion)`);
        }
        if (issues.length > 0) {
          ctx.ui.notify(`Pre-flight: ${milestoneIds.length} milestones queued.\n${issues.map(i => `  ⚠ ${i}`).join("\n")}`, "warning");
        } else {
          ctx.ui.notify(`Pre-flight: ${milestoneIds.length} milestones queued. All have full context.`, "info");
        }
      }
    }
  } catch { /* non-fatal — pre-flight should never block auto-mode */ }

  // Dispatch the first unit
  await dispatchNextUnit(ctx, pi);
}

// ─── Agent End Handler ────────────────────────────────────────────────────────

/** Guard against concurrent handleAgentEnd execution. Background job
 *  notifications and other system messages can trigger multiple agent_end
 *  events before the first handler finishes (the handler yields at every
 *  await). Without this guard, concurrent dispatchNextUnit calls race on
 *  newSession(), causing one to cancel the other and silently stopping
 *  auto-mode. */

export async function handleAgentEnd(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> {
  if (!s.active || !s.cmdCtx) return;
  if (s.handlingAgentEnd) return;
  s.handlingAgentEnd = true;

  try {

  // Unit completed — clear its timeout
  clearUnitTimeout();

    // ── Parallel worker signal check ─────────────────────────────────────
    // When running as a parallel worker (GSD_MILESTONE_LOCK set), check for
    // coordinator signals before dispatching the next unit.
    const milestoneLock = process.env.GSD_MILESTONE_LOCK;
    if (milestoneLock) {
      const signal = consumeSignal(s.basePath, milestoneLock);
      if (signal) {
        if (signal.signal === "stop") {
          s.handlingAgentEnd = false;
          await stopAuto(ctx, pi);
          return;
        }
        if (signal.signal === "pause") {
          s.handlingAgentEnd = false;
          await pauseAuto(ctx, pi);
          return;
        }
        // "resume" and "rebase" signals are handled elsewhere or no-op here
      }
    }

  // Invalidate all caches — the unit just completed and may have
  // written planning files (task summaries, roadmap checkboxes, etc.)
  invalidateAllCaches();

  // Small delay to let files settle (git commits, file writes)
  await new Promise(r => setTimeout(r, 500));

  // Commit any dirty files the LLM left behind on the current branch.
  // For execute-task units, build a meaningful commit message from the
  // task summary (one-liner, key_files, inferred type). For other unit
  // types, fall back to the generic chore() message.
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
              // Non-fatal — fall back to generic message
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

    // Post-hook: fix mechanical bookkeeping the LLM may have skipped.
    // 1. Doctor handles: checkbox marking (task-level bookkeeping).
    // 2. STATE.md is always rebuilt from disk state (purely derived, no LLM needed).
    // fixLevel:"task" ensures doctor only fixes task-level issues (e.g. marking
    // checkboxes). Slice/milestone completion transitions (summary stubs,
    // roadmap [x] marking) are left for the complete-slice dispatch unit.
    // Exception: after complete-slice itself, use fixLevel:"all" so roadmap
    // checkboxes get fixed even if complete-slice crashed (#839).
    try {
      const scopeParts = s.currentUnit.id.split("/").slice(0, 2);
      const doctorScope = scopeParts.join("/");
      const effectiveFixLevel = s.currentUnit.type === "complete-slice" ? "all" as const : "task" as const;
      const report = await runGSDDoctor(s.basePath, { fix: true, scope: doctorScope, fixLevel: effectiveFixLevel });
      if (report.fixesApplied.length > 0) {
        ctx.ui.notify(`Post-hook: applied ${report.fixesApplied.length} fix(es).`, "info");
      }

      // ── Proactive health tracking ──────────────────────────────────────
      // Record health snapshot for trend analysis and escalation logic.
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
            // Non-fatal — escalation dispatch failure
          }
        }
      }
    } catch {
      // Non-fatal — doctor failure should never block dispatch
    }
    // Throttle STATE.md rebuilds to reduce I/O spikes on long sessions.
    // STATE.md is a derived diagnostic artifact — skipping a rebuild is safe;
    // the next unit or stop/pause will rebuild it.
    const now = Date.now();
    if (now - s.lastStateRebuildAt >= STATE_REBUILD_MIN_INTERVAL_MS) {
      try {
        await rebuildState(s.basePath);
        s.lastStateRebuildAt = now;
        // State rebuild commit is bookkeeping — generic message is appropriate
        autoCommitCurrentBranch(s.basePath, "state-rebuild", s.currentUnit.id);
      } catch {
        // Non-fatal
      }
    }

    // ── Prune dead bg-shell processes ──────────────────────────────────────
    // Dead processes retain ~500KB-1MB of output buffers each. Without pruning,
    // they accumulate during long auto-mode sessions causing memory pressure.
    try {
      const { pruneDeadProcesses } = await import("../bg-shell/process-manager.js");
      pruneDeadProcesses();
    } catch {
      // Non-fatal — bg-shell may not be available
    }

    // ── Sync worktree state back to project root ──────────────────────────
    // Ensures that if auto-mode restarts, deriveState(projectRoot) reads
    // current milestone progress instead of stale pre-worktree state (#654).
    if (s.originalBasePath && s.originalBasePath !== s.basePath) {
      try {
        syncStateToProjectRoot(s.basePath, s.originalBasePath, s.currentMilestoneId);
      } catch {
        // Non-fatal — stale state is the existing behavior, sync is an improvement
      }
    }

    // ── Rewrite-docs completion: resolve overrides and reset circuit breaker ──
    if (s.currentUnit.type === "rewrite-docs") {
      try {
        await resolveAllOverrides(s.basePath);
        resetRewriteCircuitBreaker();
        ctx.ui.notify("Override(s) resolved — rewrite-docs completed.", "info");
      } catch {
        // Non-fatal — verifyExpectedArtifact will catch unresolved overrides
      }
    }

    // ── Post-triage: execute actionable resolutions (inject, replan, queue quick-tasks) ──
    // After a triage-captures unit completes, the LLM has classified captures and
    // updated CAPTURES.md. Now we execute those classifications: inject tasks into
    // the plan, write replan triggers, and queue quick-tasks for dispatch.
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
            // Queue quick-tasks for dispatch. They'll be picked up by the
            // quick-task dispatch block below the triage check.
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
        // Non-fatal — triage resolution failure shouldn't block dispatch
        process.stderr.write(`gsd-triage: resolution execution failed: ${(err as Error).message}\n`);
      }
    }

    // ── Path A fix: verify artifact and persist completion before re-entering dispatch ──
    // After doctor + rebuildState, check whether the just-completed unit actually
    // produced its expected artifact. If so, persist the completion key now so the
    // idempotency check at the top of dispatchNextUnit() skips it — even if
    // deriveState() still returns this unit as s.active (e.g. branch mismatch).
    //
    // IMPORTANT: For non-hook units, defer persistence until after the hook check.
    // If a post-unit hook requests a retry, we need to remove the completion key
    // so dispatchNextUnit re-dispatches the trigger unit.
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
        // Non-fatal — worst case we fall through to normal dispatch which has its own checks
      }
    } else {
      // Hook unit completed — finalize its runtime record and clear it
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

  // ── Verification gate: run typecheck/lint/test after execute-task ──
  if (s.currentUnit && s.currentUnit.type === "execute-task") {
    try {
      const effectivePrefs = loadEffectiveGSDPreferences();
      const prefs = effectivePrefs?.preferences;

      // Read task plan verify field from the current task's slice plan
      // unitId format is "M001/S01/T03" — extract mid, sid, tid
      const parts = s.currentUnit.id.split("/");
      let taskPlanVerify: string | undefined;
      if (parts.length >= 3) {
        const [mid, sid, tid] = parts;
        const planFile = resolveSliceFile(s.basePath, mid, sid, "PLAN");
        if (planFile) {
          const planContent = await loadFile(planFile);
          if (planContent) {
            const slicePlan = parsePlan(planContent);
            const taskEntry = slicePlan?.tasks?.find(t => t.id === tid);
            taskPlanVerify = taskEntry?.verify;
          }
        }
      }

      const result = runVerificationGate({ basePath: s.basePath,
        unitId: s.currentUnit.id,
        cwd: s.basePath,
        preferenceCommands: prefs?.verification_commands,
        taskPlanVerify,
      });

      // Capture runtime errors from bg-shell and browser console
      const runtimeErrors = await captureRuntimeErrors();
      if (runtimeErrors.length > 0) {
        result.runtimeErrors = runtimeErrors;
        // Blocking runtime errors override gate pass
        if (runtimeErrors.some(e => e.blocking)) {
          result.passed = false;
        }
      }

      // Conditional dependency audit (R008)
      const auditWarnings = runDependencyAudit(s.basePath);
      if (auditWarnings.length > 0) {
        result.auditWarnings = auditWarnings;
        process.stderr.write(`verification-gate: ${auditWarnings.length} audit warning(s)\n`);
        for (const w of auditWarnings) {
          process.stderr.write(`  [${w.severity}] ${w.name}: ${w.title}\n`);
        }
      }

      // Auto-fix retry preferences (R005 / D005)
      const autoFixEnabled = prefs?.verification_auto_fix !== false; // default true
      const maxRetries = typeof prefs?.verification_max_retries === "number" ? prefs.verification_max_retries : 2;
      const completionKey = `${s.currentUnit.type}/${s.currentUnit.id}`;

      if (result.checks.length > 0) {
        const passCount = result.checks.filter(c => c.exitCode === 0).length;
        const total = result.checks.length;
        if (result.passed) {
          ctx.ui.notify(`Verification gate: ${passCount}/${total} checks passed`);
        } else {
          const failures = result.checks.filter(c => c.exitCode !== 0);
          const failNames = failures.map(f => f.command).join(", ");
          ctx.ui.notify(`Verification gate: FAILED — ${failNames}`);
          process.stderr.write(`verification-gate: ${total - passCount}/${total} checks failed\n`);
          for (const f of failures) {
            process.stderr.write(`  ${f.command} exited ${f.exitCode}\n`);
            if (f.stderr) process.stderr.write(`  stderr: ${f.stderr.slice(0, 500)}\n`);
          }
        }
      }

      // Log blocking runtime errors to stderr
      if (result.runtimeErrors?.some(e => e.blocking)) {
        const blockingErrors = result.runtimeErrors.filter(e => e.blocking);
        process.stderr.write(`verification-gate: ${blockingErrors.length} blocking runtime error(s) detected\n`);
        for (const err of blockingErrors) {
          process.stderr.write(`  [${err.source}] ${err.severity}: ${err.message.slice(0, 200)}\n`);
        }
      }

      // Write verification evidence JSON artifact
      const attempt = s.verificationRetryCount.get(s.currentUnit.id) ?? 0;
      if (parts.length >= 3) {
        try {
          const [mid, sid, tid] = parts;
          const sDir = resolveSlicePath(s.basePath, mid, sid);
          if (sDir) {
            const tasksDir = join(sDir, "tasks");
            if (result.passed) {
              writeVerificationJSON(result, tasksDir, tid, s.currentUnit.id);
            } else {
              const nextAttempt = attempt + 1;
              writeVerificationJSON(result, tasksDir, tid, s.currentUnit.id, nextAttempt, maxRetries);
            }
          }
        } catch (evidenceErr) {
          process.stderr.write(`verification-evidence: write error — ${(evidenceErr as Error).message}\n`);
        }
      }

      // ── Auto-fix retry logic ──
      if (result.passed) {
        // Gate passed — clear retry state and continue normal flow
        s.verificationRetryCount.delete(s.currentUnit.id);
        s.pendingVerificationRetry = null;
      } else if (autoFixEnabled && attempt + 1 <= maxRetries) {
        // Gate failed, retries remaining — set up retry and return early
        const nextAttempt = attempt + 1;
        s.verificationRetryCount.set(s.currentUnit.id, nextAttempt);
        s.pendingVerificationRetry = {
          unitId: s.currentUnit.id,
          failureContext: formatFailureContext(result),
          attempt: nextAttempt,
        };
        ctx.ui.notify(`Verification failed — auto-fix attempt ${nextAttempt}/${maxRetries}`, "warning");
        // Remove completion key so dispatchNextUnit re-dispatches this unit
        s.completedKeySet.delete(completionKey);
        removePersistedKey(s.basePath, completionKey);
        // Dispatch retry immediately — without this, handleAgentEnd returns
        // without calling dispatchNextUnit, leaving auto-mode stalled (#978).
        try {
          await dispatchNextUnit(ctx, pi);
        } catch (retryDispatchErr) {
          const msg = retryDispatchErr instanceof Error ? retryDispatchErr.message : String(retryDispatchErr);
          ctx.ui.notify(`Verification retry dispatch error: ${msg}`, "error");
          startDispatchGapWatchdog(ctx, pi);
        }
        return; // ← Critical: exit before DB dual-write and post-unit hooks
      } else {
        // Gate failed, retries exhausted (or auto-fix disabled) — pause for human review
        const exhaustedAttempt = attempt + 1;
        s.verificationRetryCount.delete(s.currentUnit.id);
        s.pendingVerificationRetry = null;
        ctx.ui.notify(
          `Verification gate FAILED after ${exhaustedAttempt > maxRetries ? exhaustedAttempt - 1 : exhaustedAttempt} retries — pausing for human review`,
          "error",
        );
        await pauseAuto(ctx, pi);
        return;
      }
    } catch (err) {
      // Gate errors are non-fatal — log and continue
      process.stderr.write(`verification-gate: error — ${(err as Error).message}\n`);
    }
  }

  // ── DB dual-write: re-import changed markdown files so next unit's prompts use fresh data ──
  if (isDbAvailable()) {
    try {
      const { migrateFromMarkdown } = await import("./md-importer.js");
      migrateFromMarkdown(s.basePath);
    } catch (err) {
      process.stderr.write(`gsd-db: re-import failed: ${(err as Error).message}\n`);
    }
  }

  // ── Post-unit hooks: check if a configured hook should run before normal dispatch ──
  if (s.currentUnit && !s.stepMode) {
    const hookUnit = checkPostUnitHooks(s.currentUnit.type, s.currentUnit.id, s.basePath);
    if (hookUnit) {
      // Dispatch the hook unit instead of normal flow
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
          } catch { /* non-fatal — use current model */ }
        }
      }

      const result = await s.cmdCtx!.newSession();
      if (result.cancelled) {
        resetHookState();
        await stopAuto(ctx, pi, "Hook session cancelled");
        return;
      }
      const sessionFile = ctx.sessionManager.getSessionFile();
      writeLock(lockBase(), hookUnit.unitType, hookUnit.unitId, s.completedUnits.length, sessionFile);
      // Persist hook state so cycle counts survive crashes
      persistHookState(s.basePath);

      // Start supervision timers for hook units — hooks can get stuck just
      // like normal units, and without a watchdog auto-mode would hang forever.
      clearUnitTimeout();
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

      // Guard against race with timeout/pause before sending
      if (!s.active) return;
      pi.sendMessage(
        { customType: "gsd-auto", content: hookUnit.prompt, display: s.verbose },
        { triggerTurn: true },
      );
      return; // handleAgentEnd will fire again when hook session completes
    }

    // Check if a hook requested a retry of the trigger unit
    if (isRetryPending()) {
      const trigger = consumeRetryTrigger();
      if (trigger) {
        // Remove the trigger unit's completion key so dispatchNextUnit
        // will re-dispatch it instead of skipping it as already-complete.
        const triggerKey = `${trigger.unitType}/${trigger.unitId}`;
        s.completedKeySet.delete(triggerKey);
        removePersistedKey(s.basePath, triggerKey);
        ctx.ui.notify(
          `Hook requested retry of ${trigger.unitType} ${trigger.unitId}.`,
          "info",
        );
        // Fall through to normal dispatchNextUnit — state derivation will
        // re-select the same unit since it hasn't been marked complete
      }
    }
  }

  // ── Triage check: dispatch triage unit if pending captures exist ──────────
  // Fires after hooks complete, before normal dispatch. Follows the same
  // early-dispatch-and-return pattern as hooks and fix-merge.
  // Skip for: step mode (shows wizard instead), triage units (prevent triage-on-triage),
  // hook units (hooks run before triage conceptually).
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
            // Build triage prompt with current context
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

            // Close out previous unit metrics
            if (s.currentUnit) {
              await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt);
            }

            // Dispatch triage as a new unit (early-dispatch-and-return)
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
              return;
            }
            const sessionFile = ctx.sessionManager.getSessionFile();
            writeLock(lockBase(), triageUnitType, triageUnitId, s.completedUnits.length, sessionFile);

            // Start unit timeout for triage (use same supervisor config as hooks)
            clearUnitTimeout();
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

            if (!s.active) return;
            pi.sendMessage(
              { customType: "gsd-auto", content: prompt, display: s.verbose },
              { triggerTurn: true },
            );
            return; // handleAgentEnd will fire again when triage session completes
          }
        }
      }
    } catch {
      // Triage check failure is non-fatal — proceed to normal dispatch
    }
  }

  // ── Quick-task dispatch: execute queued quick-tasks from triage resolution ──
  // Quick-tasks are self-contained one-off tasks that don't modify the plan.
  // They're queued during post-triage resolution and dispatched here one at a time.
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

      // Close out previous unit metrics
      if (s.currentUnit) {
        await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt);
      }

      // Dispatch quick-task as a new unit
      const qtUnitType = "quick-task";
      const qtUnitId = `${ s.currentMilestoneId }/${capture.id}`;
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
        return;
      }
      const sessionFile = ctx.sessionManager.getSessionFile();
      writeLock(lockBase(), qtUnitType, qtUnitId, s.completedUnits.length, sessionFile);

      // Mark capture as executed now that the unit is dispatched
      markCaptureExecuted(s.basePath, capture.id);

      // Start unit timeout for quick-task
      clearUnitTimeout();
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

      if (!s.active) return;
      pi.sendMessage(
        { customType: "gsd-auto", content: prompt, display: s.verbose },
        { triggerTurn: true },
      );
      return; // handleAgentEnd will fire again when quick-task session completes
    } catch {
      // Non-fatal — proceed to normal dispatch
    }
  }

  // In step mode, pause and show a wizard instead of immediately dispatching
  if (s.stepMode) {
    await showStepWizard(ctx, pi);
    return;
  }

  try {
    await dispatchNextUnit(ctx, pi);
  } catch (dispatchErr) {
    // dispatchNextUnit threw — without this catch the error would propagate
    // to the pi event emitter which may silently swallow async rejections,
    // leaving auto-mode s.active but permanently stalled (see #381).
    const message = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
    ctx.ui.notify(
      `Dispatch error after unit completion: ${message}. Retrying in ${DISPATCH_GAP_TIMEOUT_MS / 1000}s.`,
      "error",
    );

    // Start the dispatch gap watchdog to retry after a delay.
    // This gives transient issues (dirty working tree, branch state) time to settle.
    startDispatchGapWatchdog(ctx, pi);
    return;
  }

  // If dispatchNextUnit returned normally but auto-mode is still s.active and
  // no new unit timeout was set (meaning sendMessage was never called), start
  // the dispatch gap watchdog as a safety net.
  if (s.active && !s.unitTimeoutHandle && !s.wrapupWarningHandle) {
    startDispatchGapWatchdog(ctx, pi);
  }

  } finally {
    s.handlingAgentEnd = false;
  }
}

// ─── Step Mode Wizard ─────────────────────────────────────────────────────

/**
 * Show the step-mode wizard after a unit completes.
 * Derives the next unit from disk state and presents it to the user.
 * If the user confirms, dispatches the next unit. If not, pauses.
 */
async function showStepWizard(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> {
  if (!s.cmdCtx) return;

  const state = await deriveState(s.basePath);
  const mid = state.activeMilestone?.id;

  // Build summary of what just completed
  const justFinished = s.currentUnit
    ? `${unitVerb(s.currentUnit.type)} ${s.currentUnit.id}`
    : "previous unit";

  // If no active milestone or everything is complete, stop
  if (!mid || state.phase === "complete") {
    const incomplete = state.registry.filter(m => m.status !== "complete");
    if (incomplete.length > 0 && state.phase !== "complete" && state.phase !== "blocked") {
      const ids = incomplete.map(m => m.id).join(", ");
      const diag = `basePath=${s.basePath}, milestones=[${state.registry.map(m => `${m.id}:${m.status}`).join(", ")}], phase=${state.phase}`;
      ctx.ui.notify(`Unexpected: ${incomplete.length} incomplete milestone(s) (${ids}) but no active milestone.\n   Diagnostic: ${diag}`, "error");
      await stopAuto(ctx, pi, `No active milestone — ${incomplete.length} incomplete (${ids})`);
    } else {
      await stopAuto(ctx, pi, state.phase === "complete" ? "All work complete" : "No active milestone");
    }
    return;
  }

  // Peek at what's next by examining state
  const nextDesc = _describeNextUnit(state);

  const choice = await showNextAction(s.cmdCtx, {
    title: `GSD — ${justFinished} complete`,
    summary: [
      `${mid}: ${state.activeMilestone?.title ?? mid}`,
      ...(state.activeSlice ? [`${state.activeSlice.id}: ${state.activeSlice.title}`] : []),
    ],
    actions: [
      {
        id: "continue",
        label: nextDesc.label,
        description: nextDesc.description,
        recommended: true,
      },
      {
        id: "auto",
        label: "Switch to auto",
        description: "Continue without pausing between steps.",
      },
      {
        id: "status",
        label: "View status",
        description: "Open the dashboard.",
      },
    ],
    notYetMessage: "Run /gsd next when ready to continue.",
  });

  if (choice === "continue") {
    await dispatchNextUnit(ctx, pi);
  } else if (choice === "auto") {
    s.stepMode = false;
    ctx.ui.setStatus("gsd-auto", "auto");
    ctx.ui.notify("Switched to auto-mode.", "info");
    await dispatchNextUnit(ctx, pi);
  } else if (choice === "status") {
    // Show status then re-show the wizard
    const { fireStatusViaCommand } = await import("./commands.js");
    await fireStatusViaCommand(ctx as ExtensionCommandContext);
    await showStepWizard(ctx, pi);
  } else {
    // "not_yet" — pause
    await pauseAuto(ctx, pi);
  }
}

// describeNextUnit is imported from auto-dashboard.ts and re-exported
export { describeNextUnit } from "./auto-dashboard.js";

/** Thin wrapper: delegates to auto-dashboard.ts, passing state accessors. */
function updateProgressWidget(
  ctx: ExtensionContext,
  unitType: string,
  unitId: string,
  state: GSDState,
): void {
  const badge = s.currentUnitRouting?.tier
    ? ({ light: "L", standard: "S", heavy: "H" }[s.currentUnitRouting.tier] ?? undefined)
    : undefined;
  _updateProgressWidget(ctx, unitType, unitId, state, widgetStateAccessors, badge);
}

/** State accessors for the widget — closures over module globals. */
const widgetStateAccessors: WidgetStateAccessors = {
  getAutoStartTime: () => s.autoStartTime,
  isStepMode: () => s.stepMode,
  getCmdCtx: () => s.cmdCtx,
  getBasePath: () => s.basePath,
  isVerbose: () => s.verbose,
};

// ─── Core Loop ────────────────────────────────────────────────────────────────

/** Tracks recursive skip depth to prevent TUI freeze on cascading completed-unit skips */

/** Reentrancy guard for dispatchNextUnit itself (not just handleAgentEnd).
 *  Prevents concurrent dispatch from watchdog timers, step wizard, and direct calls
 *  that bypass the s.handlingAgentEnd guard. Recursive calls (from skip paths) are
 *  allowed via s.skipDepth > 0. */

/** Keys recently evicted by skip-loop breaker — prevents re-persistence in the fallback path (#912). */

async function dispatchNextUnit(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> {
  if (!s.active || !s.cmdCtx) {
    debugLog(`dispatchNextUnit early return — active=${s.active}, cmdCtx=${!!s.cmdCtx}`);
    if (s.active && !s.cmdCtx) {
      ctx.ui.notify("Auto-mode session expired. Run /gsd auto to restart.", "info");
    }
    return;
  }

  // Reentrancy guard: allow recursive calls from skip paths (s.skipDepth > 0)
  // but block concurrent external calls (watchdog, step wizard, etc.)
  if (s.dispatching && s.skipDepth === 0) {
    debugLog("dispatchNextUnit reentrancy guard — another dispatch in progress, bailing");
    return; // Another dispatch is in progress — bail silently
  }
  s.dispatching = true;
  try {
  // Recursion depth guard: when many units are skipped in sequence (e.g., after
  // crash recovery with 10+ completed units), recursive dispatchNextUnit calls
  // can freeze the TUI or overflow the stack. Yield generously after MAX_SKIP_DEPTH.
  if (s.skipDepth > MAX_SKIP_DEPTH) {
    s.skipDepth = 0;
    ctx.ui.notify(`Skipped ${MAX_SKIP_DEPTH}+ completed units. Yielding to UI before continuing.`, "info");
    await new Promise(r => setTimeout(r, 200));
  }

  // Resource version guard: detect mid-session resource updates.
  // Templates are read from disk on each dispatch but extension code is loaded
  // once at startup. If resources were re-synced (e.g. /gsd:update, npm update,
  // or dev copy-resources), templates may expect variables the in-memory code
  // doesn't provide. Stop gracefully instead of crashing.
  const staleMsg = checkResourcesStale(s.resourceVersionOnStart);
  if (staleMsg) {
    await stopAuto(ctx, pi, staleMsg);
    return;
  }

  // Clear all caches so deriveState sees fresh disk state (#431).
  // Parse cache is also cleared — doctor may have re-populated it with
  // stale data between handleAgentEnd and this dispatch call (Path B fix).
  invalidateAllCaches();
  s.lastPromptCharCount = undefined;
  s.lastBaselineCharCount = undefined;

  // ── Pre-dispatch health gate ──────────────────────────────────────────
  // Lightweight check for critical issues that would cause the next unit
  // to fail or corrupt state. Auto-heals what it can, blocks on the rest.
  try {
    const healthGate = await preDispatchHealthGate(s.basePath);
    if (healthGate.fixesApplied.length > 0) {
      ctx.ui.notify(`Pre-dispatch: ${healthGate.fixesApplied.join(", ")}`, "info");
    }
    if (!healthGate.proceed) {
      ctx.ui.notify(healthGate.reason ?? "Pre-dispatch health check failed.", "error");
      await pauseAuto(ctx, pi);
      return;
    }
  } catch {
    // Non-fatal — health gate failure should never block dispatch
  }

  // ── Sync project root artifacts into worktree (#853) ─────────────────
  // When the LLM writes artifacts to the main repo filesystem instead of
  // the worktree, the worktree's gsd.db becomes stale. Sync before
  // deriveState to ensure the worktree has the latest artifacts.
  if (s.originalBasePath && s.basePath !== s.originalBasePath && s.currentMilestoneId) {
    syncProjectRootToWorktree(s.originalBasePath, s.basePath, s.currentMilestoneId);
  }

  const stopDeriveTimer = debugTime("derive-state");
  let state = await deriveState(s.basePath);
  stopDeriveTimer({
    phase: state.phase,
    milestone: state.activeMilestone?.id,
    slice: state.activeSlice?.id,
    task: state.activeTask?.id,
  });
  let mid = state.activeMilestone?.id;
  let midTitle = state.activeMilestone?.title;

  // Detect milestone transition
  if (mid && s.currentMilestoneId && mid !== s.currentMilestoneId) {
    ctx.ui.notify(
      `Milestone ${ s.currentMilestoneId } complete. Advancing to ${mid}: ${midTitle}.`,
      "info",
    );
    sendDesktopNotification("GSD", `Milestone ${s.currentMilestoneId} complete!`, "success", "milestone");
    // Hint: visualizer available after milestone transition
    const vizPrefs = loadEffectiveGSDPreferences()?.preferences;
    if (vizPrefs?.auto_visualize) {
      ctx.ui.notify("Run /gsd visualize to see progress overview.", "info");
    }
    // Auto-generate HTML report snapshot on milestone completion (default: on, disable with auto_report: false)
    if (vizPrefs?.auto_report !== false) {
      try {
        const { loadVisualizerData } = await import("./visualizer-data.js");
        const { generateHtmlReport } = await import("./export-html.js");
        const { writeReportSnapshot, reportsDir } = await import("./reports.js");
        const { basename } = await import("node:path");
        const snapData = await loadVisualizerData(s.basePath);
        const completedMs = snapData.milestones.find(m => m.id === s.currentMilestoneId);
        const msTitle = completedMs?.title ?? s.currentMilestoneId;
        const gsdVersion = process.env.GSD_VERSION ?? "0.0.0";
        const projName = basename(s.basePath);
        const doneSlices = snapData.milestones.reduce((s, m) => s + m.slices.filter(sl => sl.done).length, 0);
        const totalSlices = snapData.milestones.reduce((s, m) => s + m.slices.length, 0);
        const outPath = writeReportSnapshot({ basePath: s.basePath,
          html: generateHtmlReport(snapData, {
            projectName: projName,
            projectPath: s.basePath,
            gsdVersion,
            milestoneId: s.currentMilestoneId,
            indexRelPath: "index.html",
          }),
          milestoneId: s.currentMilestoneId,
          milestoneTitle: msTitle,
          kind: "milestone",
          projectName: projName,
          projectPath: s.basePath,
          gsdVersion,
          totalCost: snapData.totals?.cost ?? 0,
          totalTokens: snapData.totals?.tokens.total ?? 0,
          totalDuration: snapData.totals?.duration ?? 0,
          doneSlices,
          totalSlices,
          doneMilestones: snapData.milestones.filter(m => m.status === "complete").length,
          totalMilestones: snapData.milestones.length,
          phase: snapData.phase,
        });
        ctx.ui.notify(
          `Report saved: .gsd/reports/${basename(outPath)} — open index.html to browse progression.`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(
          `Report generation failed: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
    }
    // Reset stuck detection for new milestone
    s.unitDispatchCount.clear();
    s.unitRecoveryCount.clear();
  s.unitConsecutiveSkips.clear();
    s.unitLifetimeDispatches.clear();
    // Clear completed-units.json for the finished milestone
    try {
      const file = completedKeysPath(s.basePath);
      if (existsSync(file)) {
        atomicWriteSync(file, JSON.stringify([]));
      }
      s.completedKeySet.clear();
    } catch (e) { debugLog("completed-keys-reset-failed", { error: e instanceof Error ? e.message : String(e) }); }

    // ── Worktree lifecycle on milestone transition (#616) ──────────────
    // When transitioning from M_old to M_new inside a worktree, we must:
    // 1. Merge the completed milestone's worktree back to main
    // 2. Re-derive state from the project root
    // 3. Create a new worktree for the incoming milestone
    // Without this, M_new runs inside M_old's worktree on the wrong branch,
    // and artifact paths resolve against the wrong .gsd/ directory.
    if (isInAutoWorktree(s.basePath) && s.originalBasePath && shouldUseWorktreeIsolation()) {
      try {
        const roadmapPath = resolveMilestoneFile(s.originalBasePath, s.currentMilestoneId, "ROADMAP");
        if (roadmapPath) {
          const roadmapContent = readFileSync(roadmapPath, "utf-8");
          const mergeResult = mergeMilestoneToMain(s.originalBasePath, s.currentMilestoneId, roadmapContent);
          ctx.ui.notify(
            `Milestone ${ s.currentMilestoneId } merged to main.${mergeResult.pushed ? " Pushed to remote." : ""}`,
            "info",
          );
        } else {
          // No roadmap found — teardown worktree without merge
          teardownAutoWorktree(s.originalBasePath, s.currentMilestoneId);
          ctx.ui.notify(`Exited worktree for ${ s.currentMilestoneId } (no roadmap for merge).`, "info");
        }
      } catch (err) {
        ctx.ui.notify(
          `Milestone merge failed during transition: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
        // Force cwd back to project root even if merge failed
        if (s.originalBasePath) {
          try { process.chdir(s.originalBasePath); } catch { /* best-effort */ }
        }
      }

      // Update s.basePath to project root (mergeMilestoneToMain already chdir'd)
      s.basePath = s.originalBasePath;
      s.gitService = new GitServiceImpl(s.basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});
      invalidateAllCaches();

      // Re-derive state from project root before creating new worktree
      state = await deriveState(s.basePath);
      mid = state.activeMilestone?.id;
      midTitle = state.activeMilestone?.title;

      // Create new worktree for the incoming milestone
      if (mid) {
        captureIntegrationBranch(s.basePath, mid, { commitDocs: loadEffectiveGSDPreferences()?.preferences?.git?.commit_docs });
        try {
          const wtPath = createAutoWorktree(s.basePath, mid);
          s.basePath = wtPath;
          s.gitService = new GitServiceImpl(s.basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});
          ctx.ui.notify(`Created auto-worktree for ${mid} at ${wtPath}`, "info");
        } catch (err) {
          ctx.ui.notify(
            `Auto-worktree creation for ${mid} failed: ${err instanceof Error ? err.message : String(err)}. Continuing in project root.`,
            "warning",
          );
        }
      }
    } else {
      // Not in worktree — capture integration branch for the new milestone (branch mode only).
      // In none mode there's no milestone branch to merge back to, so skip.
      if (getIsolationMode() !== "none") {
        captureIntegrationBranch(s.originalBasePath || s.basePath, mid, { commitDocs: loadEffectiveGSDPreferences()?.preferences?.git?.commit_docs });
      }
    }

    // Prune completed milestone from queue order file
    const pendingIds = state.registry
      .filter(m => m.status !== "complete")
      .map(m => m.id);
    pruneQueueOrder(s.basePath, pendingIds);
  }
  if (mid) {
    s.currentMilestoneId = mid;
    setActiveMilestoneId(s.basePath, mid);
  }

  if (!mid) {
    // Save final session before stopping
    if (s.currentUnit) {
      await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id));
    }

    const incomplete = state.registry.filter(m => m.status !== "complete");
    if (incomplete.length === 0) {
      // Genuinely all complete — merge milestone branch to main before stopping (#962)
      if (s.currentMilestoneId && isInAutoWorktree(s.basePath) && s.originalBasePath) {
        try {
          const roadmapPath = resolveMilestoneFile(s.originalBasePath, s.currentMilestoneId, "ROADMAP");
          if (roadmapPath) {
            const roadmapContent = readFileSync(roadmapPath, "utf-8");
            const mergeResult = mergeMilestoneToMain(s.originalBasePath, s.currentMilestoneId, roadmapContent);
            s.basePath = s.originalBasePath;
            s.gitService = new GitServiceImpl(s.basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});
            ctx.ui.notify(
              `Milestone ${ s.currentMilestoneId } merged to main.${mergeResult.pushed ? " Pushed to remote." : ""}`,
              "info",
            );
          }
        } catch (err) {
          ctx.ui.notify(
            `Milestone merge failed: ${err instanceof Error ? err.message : String(err)}`,
            "warning",
          );
          if (s.originalBasePath) {
            s.basePath = s.originalBasePath;
            try { process.chdir(s.basePath); } catch { /* best-effort */ }
          }
        }
      } else if (s.currentMilestoneId && !isInAutoWorktree(s.basePath) && getIsolationMode() !== "none") {
        // Branch isolation mode: squash-merge milestone branch back before stopping
        try {
          const currentBranch = getCurrentBranch(s.basePath);
          const milestoneBranch = autoWorktreeBranch(s.currentMilestoneId);
          if (currentBranch === milestoneBranch) {
            const roadmapPath = resolveMilestoneFile(s.basePath, s.currentMilestoneId, "ROADMAP");
            if (roadmapPath) {
              const roadmapContent = readFileSync(roadmapPath, "utf-8");
              const mergeResult = mergeMilestoneToMain(s.basePath, s.currentMilestoneId, roadmapContent);
              s.gitService = new GitServiceImpl(s.basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});
              ctx.ui.notify(
                `Milestone ${ s.currentMilestoneId } merged (branch mode).${mergeResult.pushed ? " Pushed to remote." : ""}`,
                "info",
              );
            }
          }
        } catch (err) {
          ctx.ui.notify(
            `Milestone merge failed (branch mode): ${err instanceof Error ? err.message : String(err)}`,
            "warning",
          );
        }
      }
      sendDesktopNotification("GSD", "All milestones complete!", "success", "milestone");
      await stopAuto(ctx, pi, "All milestones complete");
    } else if (state.phase === "blocked") {
      // Milestones exist but are dependency-blocked
      const blockerMsg = `Blocked: ${state.blockers.join(", ")}`;
      await stopAuto(ctx, pi, blockerMsg);
      ctx.ui.notify(`${blockerMsg}. Fix and run /gsd auto.`, "warning");
      sendDesktopNotification("GSD", blockerMsg, "error", "attention");
    } else {
      // Milestones with remaining work exist but none became s.active — unexpected
      const ids = incomplete.map(m => m.id).join(", ");
      const diag = `basePath=${s.basePath}, milestones=[${state.registry.map(m => `${m.id}:${m.status}`).join(", ")}], phase=${state.phase}`;
      ctx.ui.notify(`Unexpected: ${incomplete.length} incomplete milestone(s) (${ids}) but no active milestone.\n   Diagnostic: ${diag}`, "error");
      await stopAuto(ctx, pi, `No active milestone — ${incomplete.length} incomplete (${ids}), see diagnostic above`);
    }
    return;
  }

  // Guard: mid/midTitle must be defined strings from this point onward.
  // The !mid check above returns early if mid is falsy; midTitle comes from
  // the same object so it should always be present when mid is.
  if (!midTitle) {
    midTitle = mid; // Defensive fallback: use milestone ID as title
    ctx.ui.notify(`Milestone ${mid} has no title in roadmap — using ID as fallback.`, "warning");
  }

  // ── Mid-merge safety check: detect leftover merge state from a prior session ──
  if (reconcileMergeState(s.basePath, ctx)) {
    invalidateAllCaches();
    state = await deriveState(s.basePath);
    mid = state.activeMilestone?.id;
    midTitle = state.activeMilestone?.title;
  }

  // After merge guard removal (branchless architecture), mid/midTitle could be undefined
  if (!mid || !midTitle) {
    if (s.currentUnit) {
      await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id));
    }
    const noMilestoneReason = !mid
      ? "No active milestone after merge reconciliation"
      : `Milestone ${mid} has no title after reconciliation`;
    await stopAuto(ctx, pi, noMilestoneReason);
    return;
  }

  // Determine next unit
  let unitType: string;
  let unitId: string;
  let prompt: string;

  if (state.phase === "complete") {
    if (s.currentUnit) {
      await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id));
    }
    // Clear completed-units.json for the finished milestone so it doesn't grow unbounded.
    try {
      const file = completedKeysPath(s.basePath);
      if (existsSync(file)) {
        atomicWriteSync(file, JSON.stringify([]));
      }
      s.completedKeySet.clear();
    } catch (e) { debugLog("completed-keys-reset-failed", { error: e instanceof Error ? e.message : String(e) }); }
    // ── Milestone merge: squash-merge milestone branch to main before stopping ──
    if (s.currentMilestoneId && isInAutoWorktree(s.basePath) && s.originalBasePath) {
      try {
        const roadmapPath = resolveMilestoneFile(s.originalBasePath, s.currentMilestoneId, "ROADMAP");
        if (!roadmapPath) throw new GSDError(GSD_ARTIFACT_MISSING, `Cannot resolve ROADMAP file for milestone ${ s.currentMilestoneId }`);
        const roadmapContent = readFileSync(roadmapPath, "utf-8");
        const mergeResult = mergeMilestoneToMain(s.originalBasePath, s.currentMilestoneId, roadmapContent);
        s.basePath = s.originalBasePath;
        s.gitService = new GitServiceImpl(s.basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});
        ctx.ui.notify(
          `Milestone ${ s.currentMilestoneId } merged to main.${mergeResult.pushed ? " Pushed to remote." : ""}`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(
          `Milestone merge failed: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
        // Ensure cwd is restored even if merge failed partway through (#608).
        // mergeMilestoneToMain may have chdir'd but then thrown, leaving us
        // in an indeterminate location.
        if (s.originalBasePath) {
          s.basePath = s.originalBasePath;
          try { process.chdir(s.basePath); } catch { /* best-effort */ }
        }
      }
    } else if (s.currentMilestoneId && !isInAutoWorktree(s.basePath) && getIsolationMode() !== "none") {
      // Branch isolation mode (#603): no worktree, but we may be on a milestone/* branch.
      // Squash-merge back to the integration branch (or main) before stopping.
      try {
        const currentBranch = getCurrentBranch(s.basePath);
        const milestoneBranch = autoWorktreeBranch(s.currentMilestoneId);
        if (currentBranch === milestoneBranch) {
          const roadmapPath = resolveMilestoneFile(s.basePath, s.currentMilestoneId, "ROADMAP");
          if (roadmapPath) {
            const roadmapContent = readFileSync(roadmapPath, "utf-8");
            // mergeMilestoneToMain handles: auto-commit, checkout integration branch,
            // squash merge, commit, optional push, branch deletion.
            const mergeResult = mergeMilestoneToMain(s.basePath, s.currentMilestoneId, roadmapContent);
            s.gitService = new GitServiceImpl(s.basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});
            ctx.ui.notify(
              `Milestone ${ s.currentMilestoneId } merged (branch mode).${mergeResult.pushed ? " Pushed to remote." : ""}`,
              "info",
            );
          }
        }
      } catch (err) {
        ctx.ui.notify(
          `Milestone merge failed (branch mode): ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
    }
    sendDesktopNotification("GSD", `Milestone ${mid} complete!`, "success", "milestone");
    await stopAuto(ctx, pi, `Milestone ${mid} complete`);
    return;
  }

  if (state.phase === "blocked") {
    if (s.currentUnit) {
      await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id));
    }
    const blockerMsg = `Blocked: ${state.blockers.join(", ")}`;
    await stopAuto(ctx, pi, blockerMsg);
    ctx.ui.notify(`${blockerMsg}. Fix and run /gsd auto.`, "warning");
    sendDesktopNotification("GSD", blockerMsg, "error", "attention");
    return;
  }

  // ── UAT Dispatch: run-uat fires after complete-slice merge, before reassessment ──
  // Ensures the UAT file and slice summary are both on main when UAT runs.
  const prefs = loadEffectiveGSDPreferences()?.preferences;

  // Budget ceiling guard — enforce budget with configurable action
  const budgetCeiling = prefs?.budget_ceiling;
  if (budgetCeiling !== undefined && budgetCeiling > 0) {
    const currentLedger = getLedger();
    const totalCost = currentLedger ? getProjectTotals(currentLedger.units).cost : 0;
    const budgetPct = totalCost / budgetCeiling;
    const budgetAlertLevel = getBudgetAlertLevel(budgetPct);
    const newBudgetAlertLevel = getNewBudgetAlertLevel(s.lastBudgetAlertLevel, budgetPct);
    const enforcement = prefs?.budget_enforcement ?? "pause";

    const budgetEnforcementAction = getBudgetEnforcementAction(enforcement, budgetPct);

    if (newBudgetAlertLevel === 100 && budgetEnforcementAction !== "none") {
      const msg = `Budget ceiling ${formatCost(budgetCeiling)} reached (spent ${formatCost(totalCost)}).`;
      s.lastBudgetAlertLevel = newBudgetAlertLevel;
      if (budgetEnforcementAction === "halt") {
        sendDesktopNotification("GSD", msg, "error", "budget");
        await stopAuto(ctx, pi, "Budget ceiling reached");
        return;
      }
      if (budgetEnforcementAction === "pause") {
        ctx.ui.notify(`${msg} Pausing auto-mode — /gsd auto to override and continue.`, "warning");
        sendDesktopNotification("GSD", msg, "warning", "budget");
        await pauseAuto(ctx, pi);
        return;
      }
      ctx.ui.notify(`${msg} Continuing (enforcement: warn).`, "warning");
      sendDesktopNotification("GSD", msg, "warning", "budget");
    } else if (newBudgetAlertLevel === 90) {
      s.lastBudgetAlertLevel = newBudgetAlertLevel;
      ctx.ui.notify(`Budget 90%: ${formatCost(totalCost)} / ${formatCost(budgetCeiling)}`, "warning");
      sendDesktopNotification("GSD", `Budget 90%: ${formatCost(totalCost)} / ${formatCost(budgetCeiling)}`, "warning", "budget");
    } else if (newBudgetAlertLevel === 80) {
      s.lastBudgetAlertLevel = newBudgetAlertLevel;
      ctx.ui.notify(`Approaching budget ceiling — 80%: ${formatCost(totalCost)} / ${formatCost(budgetCeiling)}`, "warning");
      sendDesktopNotification("GSD", `Approaching budget ceiling — 80%: ${formatCost(totalCost)} / ${formatCost(budgetCeiling)}`, "warning", "budget");
    } else if (newBudgetAlertLevel === 75) {
      s.lastBudgetAlertLevel = newBudgetAlertLevel;
      ctx.ui.notify(`Budget 75%: ${formatCost(totalCost)} / ${formatCost(budgetCeiling)}`, "info");
      sendDesktopNotification("GSD", `Budget 75%: ${formatCost(totalCost)} / ${formatCost(budgetCeiling)}`, "info", "budget");
    } else if (budgetAlertLevel === 0) {
      s.lastBudgetAlertLevel = 0;
    }
  } else {
    s.lastBudgetAlertLevel = 0;
  }

  // Context window guard — pause if approaching context limits
  const contextThreshold = prefs?.context_pause_threshold ?? 0; // 0 = disabled by default
  if (contextThreshold > 0 && s.cmdCtx) {
    const contextUsage = s.cmdCtx.getContextUsage();
    if (contextUsage && contextUsage.percent !== null && contextUsage.percent >= contextThreshold) {
      const msg = `Context window at ${contextUsage.percent}% (threshold: ${contextThreshold}%). Pausing to prevent truncated output.`;
      ctx.ui.notify(`${msg} Run /gsd auto to continue (will start fresh session).`, "warning");
      sendDesktopNotification("GSD", `Context ${contextUsage.percent}% — paused`, "warning", "attention");
      await pauseAuto(ctx, pi);
      return;
    }
  }

  // ── Secrets re-check gate — runs before every dispatch, not just at startAuto ──
  // plan-milestone writes the milestone SECRETS file (e.g., M001-SECRETS.md) during its unit. By the time we
  // reach the next dispatchNextUnit call the manifest exists but hasn't been
  // presented to the user yet. Without this re-check the model would proceed
  // into plan-slice / execute-task with no real credentials and mock everything.
  const runSecretsGate = async () => {
    try {
      const manifestStatus = await getManifestStatus(s.basePath, mid);
      if (manifestStatus && manifestStatus.pending.length > 0) {
        const result = await collectSecretsFromManifest(s.basePath, mid, ctx);
        if (result && result.applied && result.skipped && result.existingSkipped) {
          ctx.ui.notify(
            `Secrets collected: ${result.applied.length} applied, ${result.skipped.length} skipped, ${result.existingSkipped.length} already set.`,
            "info",
          );
        } else {
          ctx.ui.notify("Secrets collection skipped.", "info");
        }
      }
    } catch (err) {
      ctx.ui.notify(
        `Secrets collection error: ${err instanceof Error ? err.message : String(err)}. Continuing with next task.`,
        "warning",
      );
    }
  };

  await runSecretsGate();

  // ── Dispatch table: resolve phase → unit type + prompt ──
  const dispatchResult = await resolveDispatch({ basePath: s.basePath, mid, midTitle: midTitle!, state, prefs,
  });

  if (dispatchResult.action === "stop") {
    if (s.currentUnit) {
      await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id));
    }
    await stopAuto(ctx, pi, dispatchResult.reason);
    return;
  }

  if (dispatchResult.action !== "dispatch") {
    // skip action — yield and re-dispatch
    await new Promise(r => setImmediate(r));
    await dispatchNextUnit(ctx, pi);
    return;
  }

  unitType = dispatchResult.unitType;
  unitId = dispatchResult.unitId;
  prompt = dispatchResult.prompt;
  let pauseAfterUatDispatch = dispatchResult.pauseAfterDispatch ?? false;

  // ── Pre-dispatch hooks: modify, skip, or replace the unit before dispatch ──
  const preDispatchResult = runPreDispatchHooks(unitType, unitId, prompt, s.basePath);
  if (preDispatchResult.firedHooks.length > 0) {
    ctx.ui.notify(
      `Pre-dispatch hook${preDispatchResult.firedHooks.length > 1 ? "s" : ""}: ${preDispatchResult.firedHooks.join(", ")}`,
      "info",
    );
  }
  if (preDispatchResult.action === "skip") {
    ctx.ui.notify(`Skipping ${unitType} ${unitId} (pre-dispatch hook).`, "info");
    // Yield then re-dispatch to advance to next unit
    await new Promise(r => setImmediate(r));
    await dispatchNextUnit(ctx, pi);
    return;
  }
  if (preDispatchResult.action === "replace") {
    prompt = preDispatchResult.prompt ?? prompt;
    if (preDispatchResult.unitType) unitType = preDispatchResult.unitType;
  } else if (preDispatchResult.prompt) {
    prompt = preDispatchResult.prompt;
  }

  const priorSliceBlocker = getPriorSliceCompletionBlocker(s.basePath, getMainBranch(s.basePath), unitType, unitId);
  if (priorSliceBlocker) {
    await stopAuto(ctx, pi, priorSliceBlocker);
    return;
  }

  const observabilityIssues = await _collectObservabilityWarnings(ctx, s.basePath, unitType, unitId);

  // Idempotency: skip units already completed in a prior session.
  const idempotencyKey = `${unitType}/${unitId}`;
  if (s.completedKeySet.has(idempotencyKey)) {
    // Cross-validate: does the expected artifact actually exist?
    const artifactExists = verifyExpectedArtifact(unitType, unitId, s.basePath);
    if (artifactExists) {
      // Guard against infinite skip loops: if deriveState keeps returning the
      // same completed unit, consecutive skips will trip this breaker. Evict the
      // key so the next dispatch forces full reconciliation instead of looping.
      const skipCount = (s.unitConsecutiveSkips.get(idempotencyKey) ?? 0) + 1;
      s.unitConsecutiveSkips.set(idempotencyKey, skipCount);
      if (skipCount > MAX_CONSECUTIVE_SKIPS) {
        // Cross-check: verify deriveState actually returns this unit (#790).
        // If the unit's milestone is already complete, this is a phantom skip
        // loop from stale crash recovery context — don't evict.
        const skippedMid = unitId.split("/")[0];
        const skippedMilestoneComplete = skippedMid
          ? !!resolveMilestoneFile(s.basePath, skippedMid, "SUMMARY")
          : false;
        if (skippedMilestoneComplete) {
          // Milestone is complete — evicting this key would fight self-heal.
          // Clear skip counter and re-dispatch from fresh state.
          s.unitConsecutiveSkips.delete(idempotencyKey);
          invalidateAllCaches();
          ctx.ui.notify(
            `Phantom skip loop cleared: ${unitType} ${unitId} belongs to completed milestone ${skippedMid}. Re-dispatching from fresh state.`,
            "info",
          );
          s.skipDepth++;
          await new Promise(r => setTimeout(r, 50));
          await dispatchNextUnit(ctx, pi);
          s.skipDepth = Math.max(0, s.skipDepth - 1);
          return;
        }
        s.unitConsecutiveSkips.delete(idempotencyKey);
        s.completedKeySet.delete(idempotencyKey);
        s.recentlyEvictedKeys.add(idempotencyKey);
        removePersistedKey(s.basePath, idempotencyKey);
        invalidateAllCaches();
        ctx.ui.notify(
          `Skip loop detected: ${unitType} ${unitId} skipped ${skipCount} times without advancing. Evicting completion record and forcing reconciliation.`,
          "warning",
        );
        if (!s.active) return;
        s.skipDepth++;
        await new Promise(r => setTimeout(r, 150));
        await dispatchNextUnit(ctx, pi);
        s.skipDepth = Math.max(0, s.skipDepth - 1);
        return;
      }
      // Count toward lifetime cap so hard-stop fires during skip loops (#792)
      const lifeSkip = (s.unitLifetimeDispatches.get(idempotencyKey) ?? 0) + 1;
      s.unitLifetimeDispatches.set(idempotencyKey, lifeSkip);
      if (lifeSkip > MAX_LIFETIME_DISPATCHES) {
        await stopAuto(ctx, pi, `Hard loop: ${unitType} ${unitId} (skip cycle)`);
        ctx.ui.notify(
          `Hard loop detected: ${unitType} ${unitId} hit lifetime cap during skip cycle (${lifeSkip} iterations).`,
          "error",
        );
        return;
      }
      ctx.ui.notify(
        `Skipping ${unitType} ${unitId} — already completed in a prior session. Advancing.`,
        "info",
      );
      if (!s.active) return;
      s.skipDepth++;
      await new Promise(r => setTimeout(r, 150));
      await dispatchNextUnit(ctx, pi);
      s.skipDepth = Math.max(0, s.skipDepth - 1);
      return;
    } else {
      // Stale completion record — artifact missing. Remove and re-run.
      s.completedKeySet.delete(idempotencyKey);
      removePersistedKey(s.basePath, idempotencyKey);
      ctx.ui.notify(
        `Re-running ${unitType} ${unitId} — marked complete but expected artifact missing.`,
        "warning",
      );
    }
  }

  // Fallback: if the idempotency key is missing but the expected artifact already
  // exists on disk, the task completed in a prior session without persisting the key.
  // Persist it now and skip re-dispatch. This prevents infinite loops where a task
  // completes successfully but the completion key was never written.
  //
  // EXCEPTION: if the key was just evicted by the skip-loop breaker above, do NOT
  // re-persist — that would recreate the exact loop the breaker was trying to break (#912).
  if (verifyExpectedArtifact(unitType, unitId, s.basePath) && !s.recentlyEvictedKeys.has(idempotencyKey)) {
    persistCompletedKey(s.basePath, idempotencyKey);
    s.completedKeySet.add(idempotencyKey);
    invalidateAllCaches();
    // Same consecutive-skip guard as the idempotency path above.
    const skipCount2 = (s.unitConsecutiveSkips.get(idempotencyKey) ?? 0) + 1;
    s.unitConsecutiveSkips.set(idempotencyKey, skipCount2);
    if (skipCount2 > MAX_CONSECUTIVE_SKIPS) {
      // Cross-check: verify the unit's milestone is still active (#790).
      const skippedMid2 = unitId.split("/")[0];
      const skippedMilestoneComplete2 = skippedMid2
        ? !!resolveMilestoneFile(s.basePath, skippedMid2, "SUMMARY")
        : false;
      if (skippedMilestoneComplete2) {
        s.unitConsecutiveSkips.delete(idempotencyKey);
        invalidateAllCaches();
        ctx.ui.notify(
          `Phantom skip loop cleared: ${unitType} ${unitId} belongs to completed milestone ${skippedMid2}. Re-dispatching from fresh state.`,
          "info",
        );
        s.skipDepth++;
        await new Promise(r => setTimeout(r, 50));
        await dispatchNextUnit(ctx, pi);
        s.skipDepth = Math.max(0, s.skipDepth - 1);
        return;
      }
      s.unitConsecutiveSkips.delete(idempotencyKey);
      s.completedKeySet.delete(idempotencyKey);
      removePersistedKey(s.basePath, idempotencyKey);
      invalidateAllCaches();
      ctx.ui.notify(
        `Skip loop detected: ${unitType} ${unitId} skipped ${skipCount2} times without advancing. Evicting completion record and forcing reconciliation.`,
        "warning",
      );
      if (!s.active) return;
      s.skipDepth++;
      await new Promise(r => setTimeout(r, 150));
      await dispatchNextUnit(ctx, pi);
      s.skipDepth = Math.max(0, s.skipDepth - 1);
      return;
    }
    // Count toward lifetime cap so hard-stop fires during skip loops (#792)
    const lifeSkip2 = (s.unitLifetimeDispatches.get(idempotencyKey) ?? 0) + 1;
    s.unitLifetimeDispatches.set(idempotencyKey, lifeSkip2);
    if (lifeSkip2 > MAX_LIFETIME_DISPATCHES) {
      await stopAuto(ctx, pi, `Hard loop: ${unitType} ${unitId} (skip cycle)`);
      ctx.ui.notify(
        `Hard loop detected: ${unitType} ${unitId} hit lifetime cap during skip cycle (${lifeSkip2} iterations).`,
        "error",
      );
      return;
    }
    ctx.ui.notify(
      `Skipping ${unitType} ${unitId} — artifact exists but completion key was missing. Repaired and advancing.`,
      "info",
    );
    if (!s.active) return;
    s.skipDepth++;
    await new Promise(r => setTimeout(r, 150));
    await dispatchNextUnit(ctx, pi);
    s.skipDepth = Math.max(0, s.skipDepth - 1);
    return;
  }

  // Stuck detection — tracks total dispatches per unit (not just consecutive repeats).
  // Pattern A→B→A→B would reset retryCount every time; this map catches it.
  const dispatchKey = `${unitType}/${unitId}`;
  const prevCount = s.unitDispatchCount.get(dispatchKey) ?? 0;
  // Real dispatch reached — clear the consecutive-skip counter for this unit.
  s.unitConsecutiveSkips.delete(dispatchKey);

  debugLog("dispatch-unit", {
    type: unitType,
    id: unitId,
    cycle: prevCount + 1,
    lifetime: (s.unitLifetimeDispatches.get(dispatchKey) ?? 0) + 1,
  });
  debugCount("dispatches");

  // Hard lifetime cap — survives counter resets from loop-recovery/self-repair.
  // Catches the case where reconciliation "succeeds" (artifacts exist) but
  // deriveState keeps returning the same unit, creating an infinite cycle.
  const lifetimeCount = (s.unitLifetimeDispatches.get(dispatchKey) ?? 0) + 1;
  s.unitLifetimeDispatches.set(dispatchKey, lifetimeCount);
  if (lifetimeCount > MAX_LIFETIME_DISPATCHES) {
    if (s.currentUnit) {
      await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id));
    } else {
      saveActivityLog(ctx, s.basePath, unitType, unitId);
    }
    const expected = diagnoseExpectedArtifact(unitType, unitId, s.basePath);
    await stopAuto(ctx, pi, `Hard loop: ${unitType} ${unitId}`);
    ctx.ui.notify(
      `Hard loop detected: ${unitType} ${unitId} dispatched ${lifetimeCount} times total (across reconciliation cycles).${expected ? `\n   Expected artifact: ${expected}` : ""}\n   This may indicate deriveState() keeps returning the same unit despite artifacts existing.\n   Check .gsd/completed-units.json and the slice plan checkbox state.`,
      "error",
    );
    return;
  }
  if (prevCount >= MAX_UNIT_DISPATCHES) {
    if (s.currentUnit) {
      await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id));
    } else {
      saveActivityLog(ctx, s.basePath, unitType, unitId);
    }

    // Final reconciliation pass for execute-task: write any missing durable
    // artifacts (summary placeholder + [x] checkbox) so the pipeline can
    // advance instead of stopping. This is the last resort before halting.
    if (unitType === "execute-task") {
      const [mid, sid, tid] = unitId.split("/");
      if (mid && sid && tid) {
        const status = await inspectExecuteTaskDurability(s.basePath, unitId);
        if (status) {
          const reconciled = skipExecuteTask(s.basePath, mid, sid, tid, status, "loop-recovery", prevCount);
          // reconciled: skipExecuteTask attempted to write missing artifacts.
          // verifyExpectedArtifact: confirms physical artifacts (summary + [x]) now exist on disk.
          // Both must pass before we clear the dispatch counter and advance.
          if (reconciled && verifyExpectedArtifact(unitType, unitId, s.basePath)) {
            ctx.ui.notify(
              `Loop recovery: ${unitId} reconciled after ${prevCount + 1} dispatches — blocker artifacts written, pipeline advancing.\n   Review ${status.summaryPath} and replace the placeholder with real work.`,
              "warning",
            );
            // Persist completion so idempotency check prevents re-dispatch
            // if deriveState keeps returning this unit (#462).
            const reconciledKey = `${unitType}/${unitId}`;
            persistCompletedKey(s.basePath, reconciledKey);
            s.completedKeySet.add(reconciledKey);
            s.unitDispatchCount.delete(dispatchKey);
            invalidateAllCaches();
            await new Promise(r => setImmediate(r));
            await dispatchNextUnit(ctx, pi);
            return;
          }
        }
      }
    }

    // General reconciliation: if the last attempt DID produce the expected
    // artifact on disk, clear the counter and advance instead of stopping.
    // The execute-task path above handles its special case (writing placeholder
    // summaries). This catch-all covers complete-slice, plan-slice,
    // research-slice, and all other unit types where the Nth attempt at the
    // dispatch limit succeeded but the counter check fires before anyone
    // verifies disk state. Without this, a successful final attempt is
    // indistinguishable from a failed one.
    if (verifyExpectedArtifact(unitType, unitId, s.basePath)) {
      ctx.ui.notify(
        `Loop recovery: ${unitType} ${unitId} — artifact verified after ${prevCount + 1} dispatches. Advancing.`,
        "info",
      );
      // Persist completion so the idempotency check prevents re-dispatch
      // if deriveState keeps returning this unit (see #462).
      persistCompletedKey(s.basePath, dispatchKey);
      s.completedKeySet.add(dispatchKey);
      s.unitDispatchCount.delete(dispatchKey);
      invalidateAllCaches();
      await new Promise(r => setImmediate(r));
      await dispatchNextUnit(ctx, pi);
      return;
    }

    // Last resort for complete-milestone: generate stub summary to unblock pipeline.
    // All slices are done (otherwise we wouldn't be in completing-milestone phase),
    // but the LLM failed to write the summary N times. A stub lets the pipeline advance.
    if (unitType === "complete-milestone") {
      try {
        const mPath = resolveMilestonePath(s.basePath, unitId);
        if (mPath) {
          const stubPath = join(mPath, `${unitId}-SUMMARY.md`);
          if (!existsSync(stubPath)) {
            writeFileSync(stubPath, `# ${unitId} Summary\n\nAuto-generated stub — milestone tasks completed but summary generation failed after ${prevCount + 1} attempts.\nReview and replace this stub with a proper summary.\n`);
            ctx.ui.notify(`Generated stub summary for ${unitId} to unblock pipeline. Review later.`, "warning");
            persistCompletedKey(s.basePath, dispatchKey);
            s.completedKeySet.add(dispatchKey);
            s.unitDispatchCount.delete(dispatchKey);
            invalidateAllCaches();
            await new Promise(r => setImmediate(r));
            await dispatchNextUnit(ctx, pi);
            return;
          }
        }
      } catch { /* non-fatal — fall through to normal stop */ }
    }

    const expected = diagnoseExpectedArtifact(unitType, unitId, s.basePath);
    const remediation = buildLoopRemediationSteps(unitType, unitId, s.basePath);
    await stopAuto(ctx, pi, `Loop: ${unitType} ${unitId}`);
    sendDesktopNotification("GSD", `Loop detected: ${unitType} ${unitId}`, "error", "error");
    ctx.ui.notify(
      `Loop detected: ${unitType} ${unitId} dispatched ${prevCount + 1} times total. Expected artifact not found.${expected ? `\n   Expected: ${expected}` : ""}${remediation ? `\n\n   Remediation steps:\n${remediation}` : "\n   Check branch state and .gsd/ artifacts."}`,
      "error",
    );
    return;
  }
  s.unitDispatchCount.set(dispatchKey, prevCount + 1);
  if (prevCount > 0) {
    // Adaptive self-repair: each retry attempts a different remediation step.
    if (unitType === "execute-task") {
      const status = await inspectExecuteTaskDurability(s.basePath, unitId);
      const [mid, sid, tid] = unitId.split("/");
      if (status && mid && sid && tid) {
        if (status.summaryExists && !status.taskChecked) {
          // Retry 1+: summary exists but checkbox not marked — mark [x] and advance.
          const repaired = skipExecuteTask(s.basePath, mid, sid, tid, status, "self-repair", 0);
          // repaired: skipExecuteTask updated metadata (returned early-true even if regex missed).
          // verifyExpectedArtifact: confirms the physical artifact (summary + [x]) now exists.
          if (repaired && verifyExpectedArtifact(unitType, unitId, s.basePath)) {
            ctx.ui.notify(
              `Self-repaired ${unitId}: summary existed but checkbox was unmarked. Marked [x] and advancing.`,
              "warning",
            );
            // Persist completion so idempotency check prevents re-dispatch (#462).
            const repairedKey = `${unitType}/${unitId}`;
            persistCompletedKey(s.basePath, repairedKey);
            s.completedKeySet.add(repairedKey);
            s.unitDispatchCount.delete(dispatchKey);
            invalidateAllCaches();
            await new Promise(r => setImmediate(r));
            await dispatchNextUnit(ctx, pi);
            return;
          }
        } else if (prevCount >= STUB_RECOVERY_THRESHOLD && !status.summaryExists) {
          // Retry STUB_RECOVERY_THRESHOLD+: summary still missing after multiple attempts.
          // Write a minimal stub summary so the next agent session has a recovery artifact
          // to overwrite, rather than starting from scratch again.
          const tasksDir = resolveTasksDir(s.basePath, mid, sid);
          const sDir = resolveSlicePath(s.basePath, mid, sid);
          const targetDir = tasksDir ?? (sDir ? join(sDir, "tasks") : null);
          if (targetDir) {
            if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
            const summaryPath = join(targetDir, buildTaskFileName(tid, "SUMMARY"));
            if (!existsSync(summaryPath)) {
              const stubContent = [
                `# PARTIAL RECOVERY — attempt ${prevCount + 1} of ${MAX_UNIT_DISPATCHES}`,
                ``,
                `Task \`${tid}\` in slice \`${sid}\` (milestone \`${mid}\`) has not yet produced a real summary.`,
                `This placeholder was written by auto-mode after ${prevCount} dispatch attempts.`,
                ``,
                `The next agent session will retry this task. Replace this file with real work when done.`,
              ].join("\n");
              writeFileSync(summaryPath, stubContent, "utf-8");
              ctx.ui.notify(
                `Stub recovery (attempt ${prevCount + 1}/${MAX_UNIT_DISPATCHES}): ${unitId} stub summary placeholder written. Retrying with recovery context.`,
                "warning",
              );
            }
          }
        }
      }
    }
    ctx.ui.notify(
      `${unitType} ${unitId} didn't produce expected artifact. Retrying (${prevCount + 1}/${MAX_UNIT_DISPATCHES}).`,
      "warning",
    );
  }
  // Snapshot metrics + activity log for the PREVIOUS unit before we reassign.
  // The session still holds the previous unit's data (newSession hasn't fired yet).
  if (s.currentUnit) {
    await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id));

    // Record routing outcome for adaptive learning
    if (s.currentUnitRouting) {
      const isRetry = s.currentUnit.type === unitType && s.currentUnit.id === unitId;
      recordOutcome(
        s.currentUnit.type,
        s.currentUnitRouting.tier as "light" | "standard" | "heavy",
        !isRetry, // success = not being retried
      );
    }

    // Only mark the previous unit as completed if:
    // 1. We're not about to re-dispatch the same unit (retry scenario)
    // 2. The expected artifact actually exists on disk
    // For hook units, skip artifact verification — hooks don't produce standard
    // artifacts and their runtime records were already finalized in handleAgentEnd.
    const closeoutKey = `${s.currentUnit.type}/${s.currentUnit.id}`;
    const incomingKey = `${unitType}/${unitId}`;
    const isHookUnit = s.currentUnit.type.startsWith("hook/");
    const artifactVerified = isHookUnit || verifyExpectedArtifact(s.currentUnit.type, s.currentUnit.id, s.basePath);
    if (closeoutKey !== incomingKey && artifactVerified) {
      if (!isHookUnit) {
        // Only persist completion keys for real units — hook keys are
        // ephemeral and should not pollute the idempotency set.
        persistCompletedKey(s.basePath, closeoutKey);
        s.completedKeySet.add(closeoutKey);
      }

      s.completedUnits.push({
        type: s.currentUnit.type,
        id: s.currentUnit.id,
        startedAt: s.currentUnit.startedAt,
        finishedAt: Date.now(),
      });
      // Cap to last 200 entries to prevent unbounded growth (#611)
      if (s.completedUnits.length > 200) {
        s.completedUnits = s.completedUnits.slice(-200);
      }
      clearUnitRuntimeRecord(s.basePath, s.currentUnit.type, s.currentUnit.id);
      s.unitDispatchCount.delete(`${s.currentUnit.type}/${s.currentUnit.id}`);
      s.unitRecoveryCount.delete(`${s.currentUnit.type}/${s.currentUnit.id}`);
    }
  }
  s.currentUnit = { type: unitType, id: unitId, startedAt: Date.now() };
  captureAvailableSkills(); // Capture skill telemetry at dispatch time (#599)
  writeUnitRuntimeRecord(s.basePath, unitType, unitId, s.currentUnit.startedAt, {
    phase: "dispatched",
    wrapupWarningSent: false,
    timeoutAt: null,
    lastProgressAt: s.currentUnit.startedAt,
    progressCount: 0,
    lastProgressKind: "dispatch",
  });

  // Status bar + progress widget
  ctx.ui.setStatus("gsd-auto", "auto");
  if (mid) updateSliceProgressCache(s.basePath, mid, state.activeSlice?.id);
  updateProgressWidget(ctx, unitType, unitId, state);

  // Ensure preconditions — create directories, branches, etc.
  // so the LLM doesn't have to get these right
  ensurePreconditions(unitType, unitId, s.basePath, state);

  // Fresh session
  const result = await s.cmdCtx!.newSession();
  if (result.cancelled) {
    await stopAuto(ctx, pi, "Session cancelled");
    return;
  }

  // Branchless architecture: all work commits sequentially on the milestone
  // branch — no per-slice branches or slice-level merges. Milestone merge
  // happens when phase === "complete" (see mergeMilestoneToMain above).

  // Write lock AFTER newSession so we capture the session file path.
  // Pi appends entries incrementally via appendFileSync, so on crash the
  // session file survives with every tool call up to the crash point.
  const sessionFile = ctx.sessionManager.getSessionFile();
  writeLock(lockBase(), unitType, unitId, s.completedUnits.length, sessionFile);

  // On crash recovery, prepend the full recovery briefing
  // On retry (stuck detection), prepend deep diagnostic from last attempt
  // Cap injected content to prevent unbounded prompt growth → OOM
  const MAX_RECOVERY_CHARS = 50_000;
  let finalPrompt = prompt;

  // Verification retry — inject failure context so the agent can auto-fix
  if (s.pendingVerificationRetry) {
    const retryCtx = s.pendingVerificationRetry;
    s.pendingVerificationRetry = null;
    const capped = retryCtx.failureContext.length > MAX_RECOVERY_CHARS
      ? retryCtx.failureContext.slice(0, MAX_RECOVERY_CHARS) + "\n\n[...failure context truncated]"
      : retryCtx.failureContext;
    finalPrompt = `**VERIFICATION FAILED — AUTO-FIX ATTEMPT ${retryCtx.attempt}**\n\nThe verification gate ran after your previous attempt and found failures. Fix these issues before completing the task.\n\n${capped}\n\n---\n\n${finalPrompt}`;
  }

  if (s.pendingCrashRecovery) {
    const capped = s.pendingCrashRecovery.length > MAX_RECOVERY_CHARS
      ? s.pendingCrashRecovery.slice(0, MAX_RECOVERY_CHARS) + "\n\n[...recovery briefing truncated to prevent memory exhaustion]"
      : s.pendingCrashRecovery;
    finalPrompt = `${capped}\n\n---\n\n${finalPrompt}`;
    s.pendingCrashRecovery = null;
  } else if ((s.unitDispatchCount.get(`${unitType}/${unitId}`) ?? 0) > 1) {
    const diagnostic = getDeepDiagnostic(s.basePath);
    if (diagnostic) {
      const cappedDiag = diagnostic.length > MAX_RECOVERY_CHARS
        ? diagnostic.slice(0, MAX_RECOVERY_CHARS) + "\n\n[...diagnostic truncated to prevent memory exhaustion]"
        : diagnostic;
      finalPrompt = `**RETRY — your previous attempt did not produce the required artifact.**\n\nDiagnostic from previous attempt:\n${cappedDiag}\n\nFix whatever went wrong and make sure you write the required file this time.\n\n---\n\n${finalPrompt}`;
    }
  }

  // Inject observability repair instructions so the agent fixes gaps before
  // proceeding with the unit (see #174).
  const repairBlock = buildObservabilityRepairBlock(observabilityIssues);
  if (repairBlock) {
    finalPrompt = `${finalPrompt}${repairBlock}`;
  }

  // ── Prompt char measurement (R051) ──
  s.lastPromptCharCount = finalPrompt.length;
  s.lastBaselineCharCount = undefined;
  if (isDbAvailable()) {
    try {
      const { inlineGsdRootFile } = await import("./auto-prompts.js");
      const [decisionsContent, requirementsContent, projectContent] = await Promise.all([
        inlineGsdRootFile(s.basePath, "decisions.md", "Decisions"),
        inlineGsdRootFile(s.basePath, "requirements.md", "Requirements"),
        inlineGsdRootFile(s.basePath, "project.md", "Project"),
      ]);
      s.lastBaselineCharCount =
        (decisionsContent?.length ?? 0) +
        (requirementsContent?.length ?? 0) +
        (projectContent?.length ?? 0);
    } catch {
      // Non-fatal — baseline measurement is best-effort
    }
  }

  // Select and apply model for this unit (dynamic routing, fallback chains, etc.)
  const modelResult = await selectAndApplyModel(ctx, pi, unitType, unitId, s.basePath, prefs, s.verbose, s.autoModeStartModel);
  s.currentUnitRouting = modelResult.routing;

  // Start progress-aware supervision: a soft warning, an idle watchdog, and
  // a larger hard ceiling. Productive long-running tasks may continue past the
  // soft timeout; only idle/stalled tasks pause early.
  clearUnitTimeout();
  const supervisor = resolveAutoSupervisorConfig();
  const softTimeoutMs = (supervisor.soft_timeout_minutes ?? 0) * 60 * 1000;
  const idleTimeoutMs = (supervisor.idle_timeout_minutes ?? 0) * 60 * 1000;
  const hardTimeoutMs = (supervisor.hard_timeout_minutes ?? 0) * 60 * 1000;

  s.wrapupWarningHandle = setTimeout(() => {
    s.wrapupWarningHandle = null;
    if (!s.active || !s.currentUnit) return;
    writeUnitRuntimeRecord(s.basePath, unitType, unitId, s.currentUnit.startedAt, {
      phase: "wrapup-warning-sent",
      wrapupWarningSent: true,
    });
    pi.sendMessage(
      {
        customType: "gsd-auto-wrapup",
        display: s.verbose,
        content: [
          "**TIME BUDGET WARNING — keep going only if progress is real.**",
          "This unit crossed the soft time budget.",
          "If you are making progress, continue. If not, switch to wrap-up mode now:",
          "1. rerun the minimal required verification",
          "2. write or update the required durable artifacts",
          "3. mark task or slice state on disk correctly",
          "4. leave precise resume notes if anything remains unfinished",
        ].join("\n"),
      },
      { triggerTurn: true },
    );
  }, softTimeoutMs);

  s.idleWatchdogHandle = setInterval(async () => {
    try {
    if (!s.active || !s.currentUnit) return;
    const runtime = readUnitRuntimeRecord(s.basePath, unitType, unitId);
    if (!runtime) return;
    if (Date.now() - runtime.lastProgressAt < idleTimeoutMs) return;

    // Agent has tool calls currently executing (await_job, long bash, etc.) —
    // not idle, just waiting for tool completion. But only suppress recovery
    // if the tool started recently. A tool in-flight for longer than the idle
    // timeout is likely stuck — e.g., `python -m http.server 8080 &` keeps the
    // shell's stdout/stderr open, causing the Bash tool to hang indefinitely.
    if (getInFlightToolCount() > 0) {
      const oldestStart = getOldestInFlightToolStart()!;
      const toolAgeMs = Date.now() - oldestStart;
      if (toolAgeMs < idleTimeoutMs) {
        writeUnitRuntimeRecord(s.basePath, unitType, unitId, s.currentUnit.startedAt, {
          lastProgressAt: Date.now(),
          lastProgressKind: "tool-in-flight",
        });
        return;
      }
      // Oldest tool has been running >= idleTimeoutMs — treat as a stuck/hung
      // tool (e.g., background process holding stdout open). Fall through to
      // idle recovery without resetting the progress clock.
      ctx.ui.notify(
        `Stalled tool detected: a tool has been in-flight for ${Math.round(toolAgeMs / 60000)}min. Treating as hung — attempting idle recovery.`,
        "warning",
      );
    }

    // Before triggering recovery, check if the agent is actually producing
    // work on disk.  `git status --porcelain` is cheap and catches any
    // staged/unstaged/untracked changes the agent made since lastProgressAt.
    if (detectWorkingTreeActivity(s.basePath)) {
      writeUnitRuntimeRecord(s.basePath, unitType, unitId, s.currentUnit.startedAt, {
        lastProgressAt: Date.now(),
        lastProgressKind: "filesystem-activity",
      });
      return;
    }

    if (s.currentUnit) {
      await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id));
    } else {
      saveActivityLog(ctx, s.basePath, unitType, unitId);
    }

    const recovery = await recoverTimedOutUnit(ctx, pi, unitType, unitId, "idle", buildRecoveryContext());
    if (recovery === "recovered") return;

    writeUnitRuntimeRecord(s.basePath, unitType, unitId, s.currentUnit.startedAt, {
      phase: "paused",
    });
    ctx.ui.notify(
      `Unit ${unitType} ${unitId} made no meaningful progress for ${supervisor.idle_timeout_minutes}min. Pausing auto-mode.`,
      "warning",
    );
    await pauseAuto(ctx, pi);
    } catch (err) {
      // Guard against unhandled rejections in the async interval callback.
      // Without this, a thrown error leaves the interval running forever
      // while the auto-mode state becomes inconsistent.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[idle-watchdog] Unhandled error: ${message}`);
      try {
        ctx.ui.notify(`Idle watchdog error: ${message}`, "warning");
      } catch { /* best effort */ }
    }
  }, 15000);

  s.unitTimeoutHandle = setTimeout(async () => {
    try {
    s.unitTimeoutHandle = null;
    if (!s.active) return;
    if (s.currentUnit) {
      writeUnitRuntimeRecord(s.basePath, unitType, unitId, s.currentUnit.startedAt, {
        phase: "timeout",
        timeoutAt: Date.now(),
      });
      await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id));
    } else {
      saveActivityLog(ctx, s.basePath, unitType, unitId);
    }

    const recovery = await recoverTimedOutUnit(ctx, pi, unitType, unitId, "hard", buildRecoveryContext());
    if (recovery === "recovered") return;

    ctx.ui.notify(
      `Unit ${unitType} ${unitId} exceeded ${supervisor.hard_timeout_minutes}min hard timeout. Pausing auto-mode.`,
      "warning",
    );
    await pauseAuto(ctx, pi);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[hard-timeout] Unhandled error: ${message}`);
      try {
        ctx.ui.notify(`Hard timeout error: ${message}`, "warning");
      } catch { /* best effort */ }
    }
  }, hardTimeoutMs);

  // ── Continue-here context-pressure monitor ────────────────────────────
  // Polls context usage every 15s. When usage hits the continue-here
  // threshold (70%), sends a one-shot wrap-up signal so the agent finishes
  // gracefully and the next unit gets a fresh session. This is softer than
  // context_pause_threshold which hard-pauses auto-mode entirely.
  if (s.continueHereHandle) {
    clearInterval(s.continueHereHandle);
    s.continueHereHandle = null;
  }
  const executorContextWindow = resolveExecutorContextWindow(
    ctx.modelRegistry as Parameters<typeof resolveExecutorContextWindow>[0],
    prefs as Parameters<typeof resolveExecutorContextWindow>[1],
    ctx.model?.contextWindow,
  );
  const continueHereThreshold = computeBudgets(executorContextWindow).continueThresholdPercent;
  s.continueHereHandle = setInterval(() => {
    if (!s.active || !s.currentUnit || !s.cmdCtx) return;
    // One-shot guard: skip if already fired for this unit
    const runtime = readUnitRuntimeRecord(s.basePath, unitType, unitId);
    if (runtime?.continueHereFired) return;

    const contextUsage = s.cmdCtx.getContextUsage();
    if (!contextUsage || contextUsage.percent == null || contextUsage.percent < continueHereThreshold) return;

    // Fire once — mark runtime record and send wrap-up message
    writeUnitRuntimeRecord(s.basePath, unitType, unitId, s.currentUnit!.startedAt, {
      continueHereFired: true,
    });

    if (s.verbose) {
      ctx.ui.notify(
        `Context at ${contextUsage.percent}% (threshold: ${continueHereThreshold}%) — sending wrap-up signal.`,
        "info",
      );
    }

    pi.sendMessage(
      {
        customType: "gsd-auto-wrapup",
        display: s.verbose,
        content: [
          "**CONTEXT BUDGET WARNING — wrap up this unit now.**",
          `Context window is at ${contextUsage.percent}% (threshold: ${continueHereThreshold}%).`,
          "The next unit needs a fresh context to work effectively. Wrap up now:",
          "1. Finish any in-progress file writes",
          "2. Write or update the required durable artifacts (summary, checkboxes)",
          "3. Mark task state on disk correctly",
          "4. Leave precise resume notes if anything remains unfinished",
          "Do NOT start new sub-tasks or investigations.",
        ].join("\n"),
      },
      { triggerTurn: true },
    );

    // Clear the interval after firing — no need to keep polling
    if (s.continueHereHandle) {
      clearInterval(s.continueHereHandle);
      s.continueHereHandle = null;
    }
  }, 15_000);

  // Inject prompt — verify auto-mode still s.active (guards against race with timeout/pause)
  if (!s.active) return;
  pi.sendMessage(
    { customType: "gsd-auto", content: finalPrompt, display: s.verbose },
    { triggerTurn: true },
  );

  // For non-artifact-driven UAT types, pause auto-mode after sending the prompt.
  // The agent will write the UAT result file surfacing it for human review,
  // then on resume the result file exists and run-uat is skipped automatically.
  if (pauseAfterUatDispatch) {
    ctx.ui.notify(
      "UAT requires human execution. Auto-mode will pause after this unit writes the result file.",
      "info",
    );
    await pauseAuto(ctx, pi);
  }
  } finally {
    s.dispatching = false;
  }
}

// ─── Preconditions ────────────────────────────────────────────────────────────

/**
 * Ensure directories, branches, and other prerequisites exist before
 * dispatching a unit. The LLM should never need to mkdir or git checkout.
 */
function ensurePreconditions(
  unitType: string, unitId: string, base: string, state: GSDState,
): void {
  const parts = unitId.split("/");
  const mid = parts[0]!;

  // Always ensure milestone dir exists
  const mDir = resolveMilestonePath(base, mid);
  if (!mDir) {
    const newDir = join(milestonesDir(base), mid);
    mkdirSync(join(newDir, "slices"), { recursive: true });
  }

  // For slice-level units, ensure slice dir exists
  if (parts.length >= 2) {
    const sid = parts[1]!;

    // Re-resolve milestone path after potential creation
    const mDirResolved = resolveMilestonePath(base, mid);
    if (mDirResolved) {
      const slicesDir = join(mDirResolved, "slices");
      const sDir = resolveDir(slicesDir, sid);
      if (!sDir) {
        // Create slice dir with bare ID (tasks/ included)
        mkdirSync(join(slicesDir, sid, "tasks"), { recursive: true });
      }
      // Always ensure tasks/ subdir exists — even when slice dir was already
      // present. Handles the case where a slice was created manually or by a
      // previous run that didn't create tasks/. (#900)
      const resolvedSliceDir = resolveDir(slicesDir, sid) ?? sid;
      const tasksDir = join(slicesDir, resolvedSliceDir, "tasks");
      if (!existsSync(tasksDir)) {
        mkdirSync(tasksDir, { recursive: true });
      }
    }
  }

}

// ─── Diagnostics ──────────────────────────────────────────────────────────────

// collectObservabilityWarnings + buildObservabilityRepairBlock → auto-observability.ts

// recoverTimedOutUnit → auto-timeout-recovery.ts

/** Build recovery context from module state for recoverTimedOutUnit */
function buildRecoveryContext(): import("./auto-timeout-recovery.js").RecoveryContext {
  return { basePath: s.basePath, verbose: s.verbose,
    currentUnitStartedAt: s.currentUnit?.startedAt ?? Date.now(), unitRecoveryCount: s.unitRecoveryCount,
    dispatchNextUnit,
  };
}

// Re-export recovery functions for external consumers
export {
  resolveExpectedArtifactPath,
  verifyExpectedArtifact,
  writeBlockerPlaceholder,
  skipExecuteTask,
  buildLoopRemediationSteps,
} from "./auto-recovery.js";

/**
 * Test-only: expose skip-loop state for unit tests.
 * Not part of the public API.
 */
export function _getUnitConsecutiveSkips(): Map<string, number> { return s.unitConsecutiveSkips; }
export function _resetUnitConsecutiveSkips(): void { s.unitConsecutiveSkips.clear(); }
// MAX_CONSECUTIVE_SKIPS re-exported from auto/session.ts at top of file

/**
 * Dispatch a hook unit directly, bypassing normal pre-dispatch hooks.
 * Used for manual hook triggers via /gsd run-hook.
 */
export async function dispatchHookUnit(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  hookName: string,
  triggerUnitType: string,
  triggerUnitId: string,
  hookPrompt: string,
  hookModel: string | undefined,
  targetBasePath: string,
): Promise<boolean> {
  // Ensure auto-mode is s.active
  if (!s.active) {
    // Initialize auto-mode state minimally
    s.active = true;
    s.stepMode = true;
    s.cmdCtx = ctx as ExtensionCommandContext;
    s.basePath = targetBasePath;
    s.autoStartTime = Date.now();
    s.currentUnit = null;
    s.completedUnits = [];
    s.pendingQuickTasks = [];
  }

  const hookUnitType = `hook/${hookName}`;
  const hookStartedAt = Date.now();
  
  // Set up the trigger unit as the "current" unit so post-unit hooks can reference it
  s.currentUnit = { type: triggerUnitType, id: triggerUnitId, startedAt: hookStartedAt };
  
  // Create a new session for the hook
  const result = await s.cmdCtx!.newSession();
  if (result.cancelled) {
    await stopAuto(ctx, pi);
    return false;
  }

  // Update current unit to the hook unit
  s.currentUnit = { type: hookUnitType, id: triggerUnitId, startedAt: hookStartedAt };
  
  // Write runtime record
  writeUnitRuntimeRecord(s.basePath, hookUnitType, triggerUnitId, hookStartedAt, {
    phase: "dispatched",
    wrapupWarningSent: false,
    timeoutAt: null,
    lastProgressAt: hookStartedAt,
    progressCount: 0,
    lastProgressKind: "dispatch",
  });

  // Switch model if specified
  if (hookModel) {
    const availableModels = ctx.modelRegistry.getAvailable();
    const match = availableModels.find(m =>
      m.id === hookModel || `${m.provider}/${m.id}` === hookModel,
    );
    if (match) {
      try {
        await pi.setModel(match);
      } catch { /* non-fatal — use current model */ }
    }
  }

  // Write lock
  const sessionFile = ctx.sessionManager.getSessionFile();
  writeLock(lockBase(), hookUnitType, triggerUnitId, s.completedUnits.length, sessionFile);

  // Set up timeout
  clearUnitTimeout();
  const supervisor = resolveAutoSupervisorConfig();
  const hookHardTimeoutMs = (supervisor.hard_timeout_minutes ?? 30) * 60 * 1000;
  s.unitTimeoutHandle = setTimeout(async () => {
    s.unitTimeoutHandle = null;
    if (!s.active) return;
    if (s.currentUnit) {
      writeUnitRuntimeRecord(s.basePath, hookUnitType, triggerUnitId, hookStartedAt, {
        phase: "timeout",
        timeoutAt: Date.now(),
      });
    }
    ctx.ui.notify(
      `Hook ${hookName} exceeded ${supervisor.hard_timeout_minutes ?? 30}min timeout. Pausing auto-mode.`,
      "warning",
    );
    resetHookState();
    await pauseAuto(ctx, pi);
  }, hookHardTimeoutMs);

  // Update status
  ctx.ui.setStatus("gsd-auto", s.stepMode ? "next" : "auto");
  ctx.ui.notify(`Running post-unit hook: ${hookName}`, "info");

  // Send the hook prompt
  console.log(`[dispatchHookUnit] Sending prompt of length ${hookPrompt.length}`);
  console.log(`[dispatchHookUnit] Prompt preview: ${hookPrompt.substring(0, 200)}...`);
  pi.sendMessage(
    { customType: "gsd-auto", content: hookPrompt, display: true },
    { triggerTurn: true },
  );
  
  return true;
}


// Direct phase dispatch → auto-direct-dispatch.ts
export { dispatchDirectPhase } from "./auto-direct-dispatch.js";
