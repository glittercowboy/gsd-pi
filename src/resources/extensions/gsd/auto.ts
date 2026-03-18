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

// ── Extracted modules ──────────────────────────────────────────────────────
import { startUnitSupervision, type SupervisionContext } from "./auto-timers.js";
import { checkIdempotency, type IdempotencyContext } from "./auto-idempotency.js";
import { checkStuckAndRecover, type StuckContext } from "./auto-stuck-detection.js";
import { runPostUnitVerification, type VerificationContext } from "./auto-verification.js";
import { postUnitPreVerification, postUnitPostVerification, type PostUnitContext } from "./auto-post-unit.js";
import { bootstrapAutoSession, type BootstrapDeps } from "./auto-start.js";

// Worktree sync, resource staleness, stale worktree escape → auto-worktree-sync.ts

// ─── Session State ─────────────────────────────────────────────────────────

import {
  AutoSession,
  MAX_UNIT_DISPATCHES, STUB_RECOVERY_THRESHOLD, MAX_LIFETIME_DISPATCHES,
  MAX_CONSECUTIVE_SKIPS, DISPATCH_GAP_TIMEOUT_MS, MAX_SKIP_DEPTH,
  NEW_SESSION_TIMEOUT_MS, DISPATCH_HANG_TIMEOUT_MS,
} from "./auto/session.js";
import type { CompletedUnit, CurrentUnit, UnitRouting, StartModel, PendingVerificationRetry } from "./auto/session.js";
export {
  MAX_UNIT_DISPATCHES, STUB_RECOVERY_THRESHOLD, MAX_LIFETIME_DISPATCHES,
  MAX_CONSECUTIVE_SKIPS, DISPATCH_GAP_TIMEOUT_MS, MAX_SKIP_DEPTH,
  NEW_SESSION_TIMEOUT_MS, DISPATCH_HANG_TIMEOUT_MS,
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

/**
 * Return the model captured at auto-mode start for this session.
 * Used by error-recovery to fall back to the session's own model
 * instead of reading (potentially stale) preferences from disk (#1065).
 */
export function getAutoModeStartModel(): { provider: string; id: string } | null {
  return s.autoModeStartModel;
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
  if (s.currentMilestoneId && isInAutoWorktree(s.basePath)) {
    try {
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

  if (s.basePath) {
    try { await rebuildState(s.basePath); } catch (e) { debugLog("stop-rebuild-state-failed", { error: e instanceof Error ? e.message : String(e) }); }
  }

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

  s.pausedSessionFile = ctx?.sessionManager?.getSessionFile() ?? null;

  if (lockBase()) clearLock(lockBase());

  deregisterSigtermHandler();

  s.active = false;
  s.paused = true;
  s.pendingVerificationRetry = null;
  s.verificationRetryCount.clear();
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
  base = escapeStaleWorktree(base);

  // If resuming from paused state, just re-activate and dispatch next unit.
  if (s.paused) {
    s.paused = false;
    s.active = true;
    s.verbose = verboseMode;
    s.stepMode = requestedStepMode;
    s.cmdCtx = ctx;
    s.basePath = base;
    s.unitDispatchCount.clear();
    s.unitLifetimeDispatches.clear();
    s.unitConsecutiveSkips.clear();
    if (!getLedger()) initMetrics(base);
    if (s.currentMilestoneId) setActiveMilestoneId(base, s.currentMilestoneId);

    // ── Auto-worktree: re-enter worktree on resume ──
    if (s.currentMilestoneId && shouldUseWorktreeIsolation() && s.originalBasePath && !isInAutoWorktree(s.basePath) && !detectWorktreeName(s.basePath) && !detectWorktreeName(s.originalBasePath)) {
      try {
        const existingWtPath = getAutoWorktreePath(s.originalBasePath, s.currentMilestoneId);
        if (existingWtPath) {
          const wtPath = enterAutoWorktree(s.originalBasePath, s.currentMilestoneId);
          s.basePath = wtPath;
          s.gitService = new GitServiceImpl(s.basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});
          ctx.ui.notify(`Re-entered auto-worktree at ${wtPath}`, "info");
        } else {
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

    registerSigtermHandler(lockBase());

    ctx.ui.setStatus("gsd-auto", s.stepMode ? "next" : "auto");
    ctx.ui.setFooter(hideFooter);
    ctx.ui.notify(s.stepMode ? "Step-mode resumed." : "Auto-mode resumed.", "info");
    restoreHookState(s.basePath);
    try { await rebuildState(s.basePath); } catch (e) { debugLog("resume-rebuild-state-failed", { error: e instanceof Error ? e.message : String(e) }); }
    try {
      const report = await runGSDDoctor(s.basePath, { fix: true });
      if (report.fixesApplied.length > 0) {
        ctx.ui.notify(`Resume: applied ${report.fixesApplied.length} fix(es) to state.`, "info");
      }
    } catch (e) { debugLog("resume-doctor-failed", { error: e instanceof Error ? e.message : String(e) }); }
    await selfHealRuntimeRecords(s.basePath, ctx, s.completedKeySet);
    invalidateAllCaches();

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

    writeLock(lockBase(), "resuming", s.currentMilestoneId ?? "unknown", s.completedUnits.length);

    await dispatchNextUnit(ctx, pi);
    return;
  }

  // ── Fresh start path — delegated to auto-start.ts ──
  const bootstrapDeps: BootstrapDeps = {
    shouldUseWorktreeIsolation,
    registerSigtermHandler,
    lockBase,
  };

  const ready = await bootstrapAutoSession(s, ctx, pi, base, verboseMode, requestedStepMode, bootstrapDeps);
  if (!ready) return;

  // Dispatch the first unit
  await dispatchNextUnit(ctx, pi);
}

// ─── Agent End Handler ────────────────────────────────────────────────────────

/** Guard against concurrent handleAgentEnd execution. */

export async function handleAgentEnd(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> {
  if (!s.active || !s.cmdCtx) return;
  if (s.handlingAgentEnd) {
    // Another agent_end arrived while we're still processing the previous one.
    // This happens when a unit dispatched inside handleAgentEnd (e.g. via hooks,
    // triage, or quick-task early-dispatch paths) completes before the outer
    // handleAgentEnd returns. Queue a retry so the completed unit's agent_end
    // is not silently dropped (#1072).
    s.pendingAgentEndRetry = true;
    return;
  }
  s.handlingAgentEnd = true;

  try {

  // Unit completed — clear its timeout
  clearUnitTimeout();

  // ── Pre-verification processing (commit, doctor, state rebuild, etc.) ──
  const postUnitCtx: PostUnitContext = {
    s,
    ctx,
    pi,
    buildSnapshotOpts,
    lockBase,
    stopAuto,
    pauseAuto,
    updateProgressWidget,
  };

  const preResult = await postUnitPreVerification(postUnitCtx);
  if (preResult === "dispatched") return;

  // ── Verification gate: run typecheck/lint/test after execute-task ──
  const verificationResult = await runPostUnitVerification(
    { s, ctx, pi },
    dispatchNextUnit,
    startDispatchGapWatchdog,
    pauseAuto,
  );
  if (verificationResult === "retry" || verificationResult === "pause") return;

  // ── Post-verification processing (DB dual-write, hooks, triage, quick-tasks) ──
  const postResult = await postUnitPostVerification(postUnitCtx);
  if (postResult === "dispatched" || postResult === "stopped") return;
  if (postResult === "step-wizard") {
    await showStepWizard(ctx, pi);
    return;
  }

  // ── Dispatch with hang detection (#1073) ────────────────────────────────
  // Start a safety watchdog BEFORE calling dispatchNextUnit. If dispatch
  // hangs at any await (newSession, model selection, etc.), the gap watchdog
  // inside handleAgentEnd never fires because we never reach the check.
  // This pre-dispatch watchdog ensures recovery even when dispatchNextUnit
  // itself is permanently blocked.
  const dispatchHangGuard = setTimeout(() => {
    if (!s.active) return;
    // dispatchNextUnit has been running for too long — it's likely hung.
    // Start the gap watchdog which will retry dispatch from scratch.
    if (!s.unitTimeoutHandle && !s.wrapupWarningHandle) {
      ctx.ui.notify(
        `Dispatch hang detected (${DISPATCH_HANG_TIMEOUT_MS / 1000}s without completion). Starting recovery watchdog.`,
        "warning",
      );
      startDispatchGapWatchdog(ctx, pi);
    }
  }, DISPATCH_HANG_TIMEOUT_MS);

  try {
    await dispatchNextUnit(ctx, pi);
  } catch (dispatchErr) {
    const message = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
    ctx.ui.notify(
      `Dispatch error after unit completion: ${message}. Retrying in ${DISPATCH_GAP_TIMEOUT_MS / 1000}s.`,
      "error",
    );
    startDispatchGapWatchdog(ctx, pi);
    return;
  } finally {
    clearTimeout(dispatchHangGuard);
  }

  if (s.active && !s.unitTimeoutHandle && !s.wrapupWarningHandle) {
    startDispatchGapWatchdog(ctx, pi);
  }

  } finally {
    s.handlingAgentEnd = false;

    // If an agent_end event was dropped by the reentrancy guard while we were
    // processing, re-enter handleAgentEnd on the next microtask. This prevents
    // the summarizing phase stall (#1072) where a unit dispatched inside
    // handleAgentEnd (hooks, triage, quick-task) completes before we return,
    // and its agent_end is silently dropped — leaving auto-mode active but
    // permanently stalled with no unit running and no watchdog set.
    if (s.pendingAgentEndRetry) {
      s.pendingAgentEndRetry = false;
      setImmediate(() => {
        handleAgentEnd(ctx, pi).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`Deferred agent_end retry failed: ${msg}`, "error");
          pauseAuto(ctx, pi).catch(() => {});
        });
      });
    }
  }
}

// ─── Step Mode Wizard ─────────────────────────────────────────────────────

/**
 * Show the step-mode wizard after a unit completes.
 */
async function showStepWizard(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> {
  if (!s.cmdCtx) return;

  const state = await deriveState(s.basePath);
  const mid = state.activeMilestone?.id;

  const justFinished = s.currentUnit
    ? `${unitVerb(s.currentUnit.type)} ${s.currentUnit.id}`
    : "previous unit";

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
    const { fireStatusViaCommand } = await import("./commands.js");
    await fireStatusViaCommand(ctx as ExtensionCommandContext);
    await showStepWizard(ctx, pi);
  } else {
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

  // Reentrancy guard
  if (s.dispatching && s.skipDepth === 0) {
    debugLog("dispatchNextUnit reentrancy guard — another dispatch in progress, bailing");
    return;
  }
  s.dispatching = true;
  try {
  // Recursion depth guard
  if (s.skipDepth > MAX_SKIP_DEPTH) {
    s.skipDepth = 0;
    ctx.ui.notify(`Skipped ${MAX_SKIP_DEPTH}+ completed units. Yielding to UI before continuing.`, "info");
    await new Promise(r => setTimeout(r, 200));
  }

  // Resource version guard
  const staleMsg = checkResourcesStale(s.resourceVersionOnStart);
  if (staleMsg) {
    await stopAuto(ctx, pi, staleMsg);
    return;
  }

  invalidateAllCaches();
  s.lastPromptCharCount = undefined;
  s.lastBaselineCharCount = undefined;

  // ── Pre-dispatch health gate ──
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
    // Non-fatal
  }

  // ── Sync project root artifacts into worktree ──
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
    const vizPrefs = loadEffectiveGSDPreferences()?.preferences;
    if (vizPrefs?.auto_visualize) {
      ctx.ui.notify("Run /gsd visualize to see progress overview.", "info");
    }
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
    try {
      const file = completedKeysPath(s.basePath);
      if (existsSync(file)) {
        atomicWriteSync(file, JSON.stringify([]));
      }
      s.completedKeySet.clear();
    } catch (e) { debugLog("completed-keys-reset-failed", { error: e instanceof Error ? e.message : String(e) }); }

    // ── Worktree lifecycle on milestone transition (#616) ──
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
          teardownAutoWorktree(s.originalBasePath, s.currentMilestoneId);
          ctx.ui.notify(`Exited worktree for ${ s.currentMilestoneId } (no roadmap for merge).`, "info");
        }
      } catch (err) {
        ctx.ui.notify(
          `Milestone merge failed during transition: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
        if (s.originalBasePath) {
          try { process.chdir(s.originalBasePath); } catch { /* best-effort */ }
        }
      }

      s.basePath = s.originalBasePath;
      s.gitService = new GitServiceImpl(s.basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});
      invalidateAllCaches();

      state = await deriveState(s.basePath);
      mid = state.activeMilestone?.id;
      midTitle = state.activeMilestone?.title;

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
      if (getIsolationMode() !== "none") {
        captureIntegrationBranch(s.originalBasePath || s.basePath, mid, { commitDocs: loadEffectiveGSDPreferences()?.preferences?.git?.commit_docs });
      }
    }

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
      const blockerMsg = `Blocked: ${state.blockers.join(", ")}`;
      await stopAuto(ctx, pi, blockerMsg);
      ctx.ui.notify(`${blockerMsg}. Fix and run /gsd auto.`, "warning");
      sendDesktopNotification("GSD", blockerMsg, "error", "attention");
    } else {
      const ids = incomplete.map(m => m.id).join(", ");
      const diag = `basePath=${s.basePath}, milestones=[${state.registry.map(m => `${m.id}:${m.status}`).join(", ")}], phase=${state.phase}`;
      ctx.ui.notify(`Unexpected: ${incomplete.length} incomplete milestone(s) (${ids}) but no active milestone.\n   Diagnostic: ${diag}`, "error");
      await stopAuto(ctx, pi, `No active milestone — ${incomplete.length} incomplete (${ids}), see diagnostic above`);
    }
    return;
  }

  if (!midTitle) {
    midTitle = mid;
    ctx.ui.notify(`Milestone ${mid} has no title in roadmap — using ID as fallback.`, "warning");
  }

  // ── Mid-merge safety check ──
  if (reconcileMergeState(s.basePath, ctx)) {
    invalidateAllCaches();
    state = await deriveState(s.basePath);
    mid = state.activeMilestone?.id;
    midTitle = state.activeMilestone?.title;
  }

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
    try {
      const file = completedKeysPath(s.basePath);
      if (existsSync(file)) {
        atomicWriteSync(file, JSON.stringify([]));
      }
      s.completedKeySet.clear();
    } catch (e) { debugLog("completed-keys-reset-failed", { error: e instanceof Error ? e.message : String(e) }); }
    // ── Milestone merge ──
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
        if (s.originalBasePath) {
          s.basePath = s.originalBasePath;
          try { process.chdir(s.basePath); } catch { /* best-effort */ }
        }
      }
    } else if (s.currentMilestoneId && !isInAutoWorktree(s.basePath) && getIsolationMode() !== "none") {
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

  // Budget ceiling guard, context window guard, secrets gate, dispatch table
  const prefs = loadEffectiveGSDPreferences()?.preferences;

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

  const contextThreshold = prefs?.context_pause_threshold ?? 0;
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

  // Secrets re-check gate
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

  // ── Dispatch table ──
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
    await new Promise(r => setImmediate(r));
    await dispatchNextUnit(ctx, pi);
    return;
  }

  unitType = dispatchResult.unitType;
  unitId = dispatchResult.unitId;
  prompt = dispatchResult.prompt;
  let pauseAfterUatDispatch = dispatchResult.pauseAfterDispatch ?? false;

  // ── Pre-dispatch hooks ──
  const preDispatchResult = runPreDispatchHooks(unitType, unitId, prompt, s.basePath);
  if (preDispatchResult.firedHooks.length > 0) {
    ctx.ui.notify(
      `Pre-dispatch hook${preDispatchResult.firedHooks.length > 1 ? "s" : ""}: ${preDispatchResult.firedHooks.join(", ")}`,
      "info",
    );
  }
  if (preDispatchResult.action === "skip") {
    ctx.ui.notify(`Skipping ${unitType} ${unitId} (pre-dispatch hook).`, "info");
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

  // ── Idempotency check (delegated to auto-idempotency.ts) ──
  const idempotencyResult = checkIdempotency({
    s,
    unitType,
    unitId,
    basePath: s.basePath,
    notify: (msg, level) => ctx.ui.notify(msg, level),
  });

  if (idempotencyResult.action === "skip") {
    if (idempotencyResult.reason === "completed" || idempotencyResult.reason === "fallback-persisted" || idempotencyResult.reason === "phantom-loop-cleared" || idempotencyResult.reason === "evicted") {
      if (!s.active) return;
      s.skipDepth++;
      await new Promise(r => setTimeout(r, idempotencyResult.reason === "phantom-loop-cleared" ? 50 : 150));
      await dispatchNextUnit(ctx, pi);
      s.skipDepth = Math.max(0, s.skipDepth - 1);
      return;
    }
  } else if (idempotencyResult.action === "stop") {
    await stopAuto(ctx, pi, idempotencyResult.reason);
    ctx.ui.notify(
      `Hard loop detected: ${unitType} ${unitId} hit lifetime cap during skip cycle.`,
      "error",
    );
    return;
  }
  // "rerun" and "proceed" fall through to stuck detection

  // ── Stuck detection (delegated to auto-stuck-detection.ts) ──
  const stuckResult = await checkStuckAndRecover({
    s,
    ctx,
    unitType,
    unitId,
    basePath: s.basePath,
    buildSnapshotOpts: () => buildSnapshotOpts(unitType, unitId),
  });

  if (stuckResult.action === "stop") {
    await stopAuto(ctx, pi, stuckResult.reason);
    if (stuckResult.notifyMessage) {
      ctx.ui.notify(stuckResult.notifyMessage, "error");
    }
    return;
  }
  if (stuckResult.action === "recovered" && stuckResult.dispatchAgain) {
    await new Promise(r => setImmediate(r));
    await dispatchNextUnit(ctx, pi);
    return;
  }

  // Snapshot metrics + activity log for the PREVIOUS unit before we reassign.
  if (s.currentUnit) {
    await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id));

    if (s.currentUnitRouting) {
      const isRetry = s.currentUnit.type === unitType && s.currentUnit.id === unitId;
      recordOutcome(
        s.currentUnit.type,
        s.currentUnitRouting.tier as "light" | "standard" | "heavy",
        !isRetry,
      );
    }

    const closeoutKey = `${s.currentUnit.type}/${s.currentUnit.id}`;
    const incomingKey = `${unitType}/${unitId}`;
    const isHookUnit = s.currentUnit.type.startsWith("hook/");
    const artifactVerified = isHookUnit || verifyExpectedArtifact(s.currentUnit.type, s.currentUnit.id, s.basePath);
    if (closeoutKey !== incomingKey && artifactVerified) {
      if (!isHookUnit) {
        persistCompletedKey(s.basePath, closeoutKey);
        s.completedKeySet.add(closeoutKey);
      }

      s.completedUnits.push({
        type: s.currentUnit.type,
        id: s.currentUnit.id,
        startedAt: s.currentUnit.startedAt,
        finishedAt: Date.now(),
      });
      if (s.completedUnits.length > 200) {
        s.completedUnits = s.completedUnits.slice(-200);
      }
      clearUnitRuntimeRecord(s.basePath, s.currentUnit.type, s.currentUnit.id);
      s.unitDispatchCount.delete(`${s.currentUnit.type}/${s.currentUnit.id}`);
      s.unitRecoveryCount.delete(`${s.currentUnit.type}/${s.currentUnit.id}`);
    }
  }
  s.currentUnit = { type: unitType, id: unitId, startedAt: Date.now() };
  captureAvailableSkills();
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

  ensurePreconditions(unitType, unitId, s.basePath, state);

  // Fresh session — with timeout to prevent permanent hangs (#1073).
  // If newSession() hangs (e.g., session manager deadlock, network issue),
  // without this timeout the entire dispatch chain stalls permanently: no
  // timeouts are set, no gap watchdog fires, and auto-mode is left active
  // but idle until the user Ctrl+C's.
  let result: { cancelled: boolean };
  try {
    const sessionPromise = s.cmdCtx!.newSession();
    const timeoutPromise = new Promise<{ cancelled: true }>((resolve) =>
      setTimeout(() => resolve({ cancelled: true }), NEW_SESSION_TIMEOUT_MS),
    );
    result = await Promise.race([sessionPromise, timeoutPromise]);
  } catch (sessionErr) {
    const msg = sessionErr instanceof Error ? sessionErr.message : String(sessionErr);
    ctx.ui.notify(`Session creation failed: ${msg}. Retrying via watchdog.`, "error");
    throw new Error(`newSession() failed: ${msg}`);
  }
  if (result.cancelled) {
    ctx.ui.notify(
      `Session creation timed out or was cancelled for ${unitType} ${unitId}. Will retry.`,
      "warning",
    );
    await stopAuto(ctx, pi, "Session creation failed");
    return;
  }

  const sessionFile = ctx.sessionManager.getSessionFile();
  writeLock(lockBase(), unitType, unitId, s.completedUnits.length, sessionFile);

  // Prompt injection
  const MAX_RECOVERY_CHARS = 50_000;
  let finalPrompt = prompt;

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

  const repairBlock = buildObservabilityRepairBlock(observabilityIssues);
  if (repairBlock) {
    finalPrompt = `${finalPrompt}${repairBlock}`;
  }

  // ── Prompt char measurement ──
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
      // Non-fatal
    }
  }

  // Select and apply model
  const modelResult = await selectAndApplyModel(ctx, pi, unitType, unitId, s.basePath, prefs, s.verbose, s.autoModeStartModel);
  s.currentUnitRouting = modelResult.routing;

  // ── Start unit supervision (delegated to auto-timers.ts) ──
  clearUnitTimeout();
  startUnitSupervision({
    s,
    ctx,
    pi,
    unitType,
    unitId,
    prefs,
    buildSnapshotOpts: () => buildSnapshotOpts(unitType, unitId),
    buildRecoveryContext: () => buildRecoveryContext(),
    pauseAuto,
  });

  // Inject prompt
  if (!s.active) return;
  pi.sendMessage(
    { customType: "gsd-auto", content: finalPrompt, display: s.verbose },
    { triggerTurn: true },
  );

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

  const mDir = resolveMilestonePath(base, mid);
  if (!mDir) {
    const newDir = join(milestonesDir(base), mid);
    mkdirSync(join(newDir, "slices"), { recursive: true });
  }

  if (parts.length >= 2) {
    const sid = parts[1]!;

    const mDirResolved = resolveMilestonePath(base, mid);
    if (mDirResolved) {
      const slicesDir = join(mDirResolved, "slices");
      const sDir = resolveDir(slicesDir, sid);
      if (!sDir) {
        mkdirSync(join(slicesDir, sid, "tasks"), { recursive: true });
      }
      const resolvedSliceDir = resolveDir(slicesDir, sid) ?? sid;
      const tasksDir = join(slicesDir, resolvedSliceDir, "tasks");
      if (!existsSync(tasksDir)) {
        mkdirSync(tasksDir, { recursive: true });
      }
    }
  }

}

// ─── Diagnostics ──────────────────────────────────────────────────────────────

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
  if (!s.active) {
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

  s.currentUnit = { type: triggerUnitType, id: triggerUnitId, startedAt: hookStartedAt };

  const result = await s.cmdCtx!.newSession();
  if (result.cancelled) {
    await stopAuto(ctx, pi);
    return false;
  }

  s.currentUnit = { type: hookUnitType, id: triggerUnitId, startedAt: hookStartedAt };

  writeUnitRuntimeRecord(s.basePath, hookUnitType, triggerUnitId, hookStartedAt, {
    phase: "dispatched",
    wrapupWarningSent: false,
    timeoutAt: null,
    lastProgressAt: hookStartedAt,
    progressCount: 0,
    lastProgressKind: "dispatch",
  });

  if (hookModel) {
    const availableModels = ctx.modelRegistry.getAvailable();
    const match = availableModels.find(m =>
      m.id === hookModel || `${m.provider}/${m.id}` === hookModel,
    );
    if (match) {
      try {
        await pi.setModel(match);
      } catch { /* non-fatal */ }
    }
  }

  const sessionFile = ctx.sessionManager.getSessionFile();
  writeLock(lockBase(), hookUnitType, triggerUnitId, s.completedUnits.length, sessionFile);

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

  ctx.ui.setStatus("gsd-auto", s.stepMode ? "next" : "auto");
  ctx.ui.notify(`Running post-unit hook: ${hookName}`, "info");

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
