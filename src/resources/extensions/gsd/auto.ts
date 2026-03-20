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
import { getManifestStatus } from "./files.js";
export { inlinePriorMilestoneSummary } from "./files.js";
import { collectSecretsFromManifest } from "../get-secrets-from-user.js";
import {
  gsdRoot,
  resolveMilestoneFile,
  resolveSliceFile,
  resolveSlicePath,
  resolveMilestonePath,
  resolveDir,
  resolveTasksDir,
  resolveTaskFile,
  milestonesDir,
  buildTaskFileName,
} from "./paths.js";
import { invalidateAllCaches } from "./cache.js";
import { clearActivityLogState } from "./activity-log.js";
import {
  synthesizeCrashRecovery,
  getDeepDiagnostic,
} from "./session-forensics.js";
import {
  writeLock,
  clearLock,
  readCrashLock,
  isLockProcessAlive,
} from "./crash-recovery.js";
import {
  acquireSessionLock,
  getSessionLockStatus,
  releaseSessionLock,
  updateSessionLock,
} from "./session-lock.js";
import type { SessionLockStatus } from "./session-lock.js";
import {
  clearUnitRuntimeRecord,
  inspectExecuteTaskDurability,
  readUnitRuntimeRecord,
  writeUnitRuntimeRecord,
} from "./unit-runtime.js";
import {
  resolveAutoSupervisorConfig,
  loadEffectiveGSDPreferences,
  getIsolationMode,
} from "./preferences.js";
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
import { resetRoutingHistory, recordOutcome } from "./routing-history.js";
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
import { runGSDDoctor, rebuildState } from "./doctor.js";
import {
  preDispatchHealthGate,
  recordHealthSnapshot,
  checkHealEscalation,
  resetProactiveHealing,
  formatHealthSummary,
  getConsecutiveErrorUnits,
} from "./doctor-proactive.js";
import { clearSkillSnapshot } from "./skill-discovery.js";
import {
  captureAvailableSkills,
  resetSkillTelemetry,
} from "./skill-telemetry.js";
import {
  initMetrics,
  resetMetrics,
  getLedger,
  getProjectTotals,
  formatCost,
  formatTokenCount,
} from "./metrics.js";
import { join } from "node:path";
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { atomicWriteSync } from "./atomic-write.js";
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
import { GitServiceImpl } from "./git-service.js";
import { getPriorSliceCompletionBlocker } from "./dispatch-guard.js";
import {
  createAutoWorktree,
  enterAutoWorktree,
  teardownAutoWorktree,
  isInAutoWorktree,
  getAutoWorktreePath,
  getAutoWorktreeOriginalBase,
  mergeMilestoneToMain,
  autoWorktreeBranch,
  syncWorktreeStateBack,
} from "./auto-worktree.js";
import { pruneQueueOrder } from "./queue-order.js";

import { debugLog, isDebugEnabled, writeDebugSummary } from "./debug-logger.js";
import {
  resolveExpectedArtifactPath,
  verifyExpectedArtifact,
  writeBlockerPlaceholder,
  diagnoseExpectedArtifact,
  skipExecuteTask,
  buildLoopRemediationSteps,
  reconcileMergeState,
} from "./auto-recovery.js";
import { resolveDispatch } from "./auto-dispatch.js";
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
import { countPendingCaptures } from "./captures.js";
import { clearCmuxSidebar, logCmuxEvent, syncCmuxSidebar } from "../cmux/index.js";

// ── Extracted modules ──────────────────────────────────────────────────────
import { startUnitSupervision } from "./auto-timers.js";
import { runPostUnitVerification } from "./auto-verification.js";
import {
  postUnitPreVerification,
  postUnitPostVerification,
} from "./auto-post-unit.js";
import { bootstrapAutoSession, type BootstrapDeps } from "./auto-start.js";
import { autoLoop, resolveAgentEnd, type LoopDeps } from "./auto-loop.js";
import {
  WorktreeResolver,
  type WorktreeResolverDeps,
} from "./worktree-resolver.js";
import { reorderForCaching } from "./prompt-ordering.js";

// Worktree sync, resource staleness, stale worktree escape → auto-worktree-sync.ts

// ─── Session State ─────────────────────────────────────────────────────────

import {
  AutoSession,
  MAX_UNIT_DISPATCHES,
  STUB_RECOVERY_THRESHOLD,
  MAX_LIFETIME_DISPATCHES,
  NEW_SESSION_TIMEOUT_MS,
} from "./auto/session.js";
import type {
  CompletedUnit,
  CurrentUnit,
  UnitRouting,
  StartModel,
} from "./auto/session.js";
export {
  MAX_UNIT_DISPATCHES,
  STUB_RECOVERY_THRESHOLD,
  MAX_LIFETIME_DISPATCHES,
  NEW_SESSION_TIMEOUT_MS,
} from "./auto/session.js";
export type {
  CompletedUnit,
  CurrentUnit,
  UnitRouting,
  StartModel,
} from "./auto/session.js";

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

/** Crash recovery prompt — set by startAuto, consumed by the main loop */

/** Pending verification retry — set when gate fails with retries remaining, consumed by autoLoop */

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

/** Prompt character measurement for token savings analysis (R051). */

/** SIGTERM handler registered while auto-mode is active — cleared on stop/pause. */

/**
 * Tool calls currently being executed — prevents false idle detection during long-running tools.
 * Maps toolCallId → start timestamp (ms) so the idle watchdog can detect tools that have been
 * running suspiciously long (e.g., a Bash command hung because `&` kept stdout open).
 */
// Re-export budget utilities for external consumers
export {
  getBudgetAlertLevel,
  getNewBudgetAlertLevel,
  getBudgetEnforcementAction,
} from "./auto-budget.js";

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
  return {
    active: s.active,
    paused: s.paused,
    stepMode: s.stepMode,
    startTime: s.autoStartTime,
    elapsed: s.active || s.paused ? Date.now() - s.autoStartTime : 0,
    currentUnit: s.currentUnit ? { ...s.currentUnit } : null,
    completedUnits: [...s.completedUnits],
    basePath: s.basePath,
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
export function getAutoModeStartModel(): {
  provider: string;
  id: string;
} | null {
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
 *
 * Delegates to AutoSession.lockBasePath — the single source of truth.
 */
function lockBase(): string {
  return s.lockBasePath;
}

/**
 * Attempt to stop a running auto-mode session from a different process.
 * Reads the lock file at the project root, checks if the PID is alive,
 * and sends SIGTERM to gracefully stop it.
 *
 * Returns true if a remote session was found and signaled, false otherwise.
 */
export function stopAutoRemote(projectRoot: string): {
  found: boolean;
  pid?: number;
  error?: string;
} {
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

/**
 * Check if a remote auto-mode session is running (from a different process).
 * Reads the crash lock, checks PID liveness, and returns session details.
 * Used by the guard in commands.ts to prevent bare /gsd, /gsd next, and
 * /gsd auto from stealing the session lock.
 */
export function checkRemoteAutoSession(projectRoot: string): {
  running: boolean;
  pid?: number;
  unitType?: string;
  unitId?: string;
  startedAt?: string;
  completedUnits?: number;
} {
  const lock = readCrashLock(projectRoot);
  if (!lock) return { running: false };

  if (!isLockProcessAlive(lock)) {
    // Stale lock from a dead process — not a live remote session
    return { running: false };
  }

  return {
    running: true,
    pid: lock.pid,
    unitType: lock.unitType,
    unitId: lock.unitId,
    startedAt: lock.startedAt,
    completedUnits: lock.completedUnits,
  };
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
}

/** Build snapshot metric opts, enriching with continueHereFired from the runtime record. */
function buildSnapshotOpts(
  unitType: string,
  unitId: string,
): {
  continueHereFired?: boolean;
  promptCharCount?: number;
  baselineCharCount?: number;
} & Record<string, unknown> {
  const runtime = s.currentUnit
    ? readUnitRuntimeRecord(s.basePath, unitType, unitId)
    : null;
  return {
    promptCharCount: s.lastPromptCharCount,
    baselineCharCount: s.lastBaselineCharCount,
    ...(s.currentUnitRouting ?? {}),
    ...(runtime?.continueHereFired ? { continueHereFired: true } : {}),
  };
}

function handleLostSessionLock(
  ctx?: ExtensionContext,
  lockStatus?: SessionLockStatus,
): void {
  debugLog("session-lock-lost", {
    lockBase: lockBase(),
    reason: lockStatus?.failureReason,
    existingPid: lockStatus?.existingPid,
    expectedPid: lockStatus?.expectedPid,
  });
  s.active = false;
  s.paused = false;
  clearUnitTimeout();
  deregisterSigtermHandler();
  clearCmuxSidebar(loadEffectiveGSDPreferences()?.preferences);
  const message =
    lockStatus?.failureReason === "pid-mismatch"
      ? lockStatus.existingPid
        ? `Session lock moved to PID ${lockStatus.existingPid} — another GSD process appears to have taken over. Stopping gracefully.`
        : "Session lock moved to a different process — another GSD process appears to have taken over. Stopping gracefully."
      : lockStatus?.failureReason === "missing-metadata"
        ? "Session lock metadata disappeared, so ownership could not be confirmed. Stopping gracefully."
        : lockStatus?.failureReason === "compromised"
          ? "Session lock was compromised or invalidated during heartbeat checks; takeover was not confirmed. Stopping gracefully."
          : "Session lock lost. Stopping gracefully.";
  ctx?.ui.notify(
    message,
    "error",
  );
  ctx?.ui.setStatus("gsd-auto", undefined);
  ctx?.ui.setWidget("gsd-progress", undefined);
  ctx?.ui.setFooter(undefined);
}

export async function stopAuto(
  ctx?: ExtensionContext,
  pi?: ExtensionAPI,
  reason?: string,
): Promise<void> {
  if (!s.active && !s.paused) return;
  const loadedPreferences = loadEffectiveGSDPreferences()?.preferences;
  const reasonSuffix = reason ? ` — ${reason}` : "";
  clearUnitTimeout();
  if (lockBase()) clearLock(lockBase());
  if (lockBase()) releaseSessionLock(lockBase());
  clearSkillSnapshot();
  resetSkillTelemetry();

  // Remove SIGTERM handler registered at auto-mode start
  deregisterSigtermHandler();

  // ── Auto-worktree: exit worktree and reset s.basePath on stop ──
  if (s.currentMilestoneId) {
    const notifyCtx = ctx
      ? { notify: ctx.ui.notify.bind(ctx.ui) }
      : { notify: () => {} };
    buildResolver().exitMilestone(s.currentMilestoneId, notifyCtx, {
      preserveBranch: true,
    });
  }

  // ── DB cleanup: close the SQLite connection ──
  if (isDbAvailable()) {
    try {
      const { closeDatabase } = await import("./gsd-db.js");
      closeDatabase();
    } catch (e) {
      debugLog("db-close-failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (s.originalBasePath) {
    s.basePath = s.originalBasePath;
    try {
      process.chdir(s.basePath);
    } catch {
      /* best-effort */
    }
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
    try {
      await rebuildState(s.basePath);
    } catch (e) {
      debugLog("stop-rebuild-state-failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  clearCmuxSidebar(loadedPreferences);
  logCmuxEvent(
    loadedPreferences,
    `Auto-mode stopped${reasonSuffix || ""}.`,
    reason?.startsWith("Blocked:") ? "warning" : "info",
  );

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

  // Remove paused-session metadata if present (#1383)
  try {
    const pausedPath = join(gsdRoot(s.originalBasePath || s.basePath), "runtime", "paused-session.json");
    if (existsSync(pausedPath)) unlinkSync(pausedPath);
  } catch { /* non-fatal */ }

  // Restore original model before reset() clears the IDs
  if (pi && ctx && s.originalModelId && s.originalModelProvider) {
    const original = ctx.modelRegistry.find(
      s.originalModelProvider,
      s.originalModelId,
    );
    if (original) await pi.setModel(original);
  }

  // External cleanup (not covered by session reset)
  clearInFlightTools();
  clearSliceProgressCache();
  clearActivityLogState();
  resetProactiveHealing();

  // UI cleanup
  ctx?.ui.setStatus("gsd-auto", undefined);
  ctx?.ui.setWidget("gsd-progress", undefined);
  ctx?.ui.setFooter(undefined);

  // Reset all session state in one call
  s.reset();
}

/**
 * Pause auto-mode without destroying state. Context is preserved.
 * The user can interact with the agent, then `/gsd auto` resumes
 * from disk state. Called when the user presses Escape during auto-mode.
 */
export async function pauseAuto(
  ctx?: ExtensionContext,
  _pi?: ExtensionAPI,
): Promise<void> {
  if (!s.active) return;
  clearUnitTimeout();

  s.pausedSessionFile = ctx?.sessionManager?.getSessionFile() ?? null;

  // Persist paused-session metadata so resume survives /exit (#1383).
  // The fresh-start bootstrap checks for this file and restores worktree context.
  try {
    const pausedMeta = {
      milestoneId: s.currentMilestoneId,
      worktreePath: isInAutoWorktree(s.basePath) ? s.basePath : null,
      originalBasePath: s.originalBasePath,
      stepMode: s.stepMode,
      pausedAt: new Date().toISOString(),
      sessionFile: s.pausedSessionFile,
    };
    const runtimeDir = join(gsdRoot(s.originalBasePath || s.basePath), "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, "paused-session.json"),
      JSON.stringify(pausedMeta, null, 2),
      "utf-8",
    );
  } catch {
    // Non-fatal — resume will still work via full bootstrap, just without worktree context
  }

  if (lockBase()) {
    releaseSessionLock(lockBase());
    clearLock(lockBase());
  }

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

/**
 * Build a WorktreeResolverDeps from auto.ts private scope.
 * Shared by buildResolver() and buildLoopDeps().
 */
function buildResolverDeps(): WorktreeResolverDeps {
  return {
    isInAutoWorktree,
    shouldUseWorktreeIsolation,
    getIsolationMode,
    mergeMilestoneToMain,
    syncWorktreeStateBack,
    teardownAutoWorktree,
    createAutoWorktree,
    enterAutoWorktree,
    getAutoWorktreePath,
    autoCommitCurrentBranch,
    getCurrentBranch,
    autoWorktreeBranch,
    resolveMilestoneFile,
    readFileSync: (path: string, encoding: string) =>
      readFileSync(path, encoding as BufferEncoding),
    GitServiceImpl:
      GitServiceImpl as unknown as WorktreeResolverDeps["GitServiceImpl"],
    loadEffectiveGSDPreferences:
      loadEffectiveGSDPreferences as unknown as WorktreeResolverDeps["loadEffectiveGSDPreferences"],
    invalidateAllCaches,
    captureIntegrationBranch,
  };
}

/**
 * Build a WorktreeResolver wrapping the current session.
 * Cheap to construct — it's just a thin wrapper over `s` + deps.
 * Used by stopAuto(), resume path, and buildLoopDeps().
 */
function buildResolver(): WorktreeResolver {
  return new WorktreeResolver(s, buildResolverDeps());
}

/**
 * Build the LoopDeps object from auto.ts private scope.
 * This bundles all private functions that autoLoop needs without exporting them.
 */
function buildLoopDeps(): LoopDeps {
  return {
    lockBase,
    buildSnapshotOpts,
    stopAuto,
    pauseAuto,
    clearUnitTimeout,
    updateProgressWidget,
    syncCmuxSidebar,
    logCmuxEvent,

    // State and cache
    invalidateAllCaches,
    deriveState,
    loadEffectiveGSDPreferences,

    // Pre-dispatch health gate
    preDispatchHealthGate,

    // Worktree sync
    syncProjectRootToWorktree,

    // Resource version guard
    checkResourcesStale,

    // Session lock
    validateSessionLock: getSessionLockStatus,
    updateSessionLock,
    handleLostSessionLock,

    // Milestone transition
    sendDesktopNotification,
    setActiveMilestoneId,
    pruneQueueOrder,
    isInAutoWorktree,
    shouldUseWorktreeIsolation,
    mergeMilestoneToMain,
    teardownAutoWorktree,
    createAutoWorktree,
    captureIntegrationBranch,
    getIsolationMode,
    getCurrentBranch,
    autoWorktreeBranch,
    resolveMilestoneFile,
    reconcileMergeState,

    // Budget/context/secrets
    getLedger,
    getProjectTotals,
    formatCost,
    getBudgetAlertLevel,
    getNewBudgetAlertLevel,
    getBudgetEnforcementAction,
    getManifestStatus,
    collectSecretsFromManifest,

    // Dispatch
    resolveDispatch,
    runPreDispatchHooks,
    getPriorSliceCompletionBlocker,
    getMainBranch,
    collectObservabilityWarnings: _collectObservabilityWarnings,
    buildObservabilityRepairBlock,

    // Unit closeout + runtime records
    closeoutUnit,
    verifyExpectedArtifact,
    clearUnitRuntimeRecord,
    writeUnitRuntimeRecord,
    recordOutcome,
    writeLock,
    captureAvailableSkills,
    ensurePreconditions,
    updateSliceProgressCache,

    // Model selection + supervision
    selectAndApplyModel,
    startUnitSupervision,

    // Prompt helpers
    getDeepDiagnostic,
    isDbAvailable,
    reorderForCaching,

    // Filesystem
    existsSync,
    readFileSync: (path: string, encoding: string) =>
      readFileSync(path, encoding as BufferEncoding),
    atomicWriteSync,

    // Git
    GitServiceImpl: GitServiceImpl as unknown as LoopDeps["GitServiceImpl"],

    // WorktreeResolver
    resolver: buildResolver(),

    // Post-unit processing
    postUnitPreVerification,
    runPostUnitVerification,
    postUnitPostVerification,

    // Session manager
    getSessionFile: (ctx: ExtensionContext) => {
      try {
        return ctx.sessionManager?.getSessionFile() ?? "";
      } catch {
        return "";
      }
    },
  } as unknown as LoopDeps;
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
  // Check persisted paused-session first (#1383) — survives /exit.
  if (!s.paused) {
    try {
      const pausedPath = join(gsdRoot(base), "runtime", "paused-session.json");
      if (existsSync(pausedPath)) {
        const meta = JSON.parse(readFileSync(pausedPath, "utf-8"));
        if (meta.milestoneId) {
          s.currentMilestoneId = meta.milestoneId;
          s.originalBasePath = meta.originalBasePath || base;
          s.stepMode = meta.stepMode ?? requestedStepMode;
          s.paused = true;
          // Clean up the persisted file — we're consuming it
          try { unlinkSync(pausedPath); } catch { /* non-fatal */ }
          ctx.ui.notify(
            `Resuming paused session for ${meta.milestoneId}${meta.worktreePath ? ` (worktree)` : ""}.`,
            "info",
          );
        }
      }
    } catch {
      // Malformed or missing — proceed with fresh bootstrap
    }
  }

  if (s.paused) {
    const resumeLock = acquireSessionLock(base);
    if (!resumeLock.acquired) {
      ctx.ui.notify(`Cannot resume: ${resumeLock.reason}`, "error");
      return;
    }

    s.paused = false;
    s.active = true;
    s.verbose = verboseMode;
    s.stepMode = requestedStepMode;
    s.cmdCtx = ctx;
    s.basePath = base;
    s.unitDispatchCount.clear();
    s.unitLifetimeDispatches.clear();
    if (!getLedger()) initMetrics(base);
    if (s.currentMilestoneId) setActiveMilestoneId(base, s.currentMilestoneId);

    // ── Auto-worktree: re-enter worktree on resume ──
    if (
      s.currentMilestoneId &&
      shouldUseWorktreeIsolation() &&
      s.originalBasePath &&
      !isInAutoWorktree(s.basePath) &&
      !detectWorktreeName(s.basePath) &&
      !detectWorktreeName(s.originalBasePath)
    ) {
      buildResolver().enterMilestone(s.currentMilestoneId, {
        notify: ctx.ui.notify.bind(ctx.ui),
      });
    }

    registerSigtermHandler(lockBase());

    ctx.ui.setStatus("gsd-auto", s.stepMode ? "next" : "auto");
    ctx.ui.setFooter(hideFooter);
    ctx.ui.notify(
      s.stepMode ? "Step-mode resumed." : "Auto-mode resumed.",
      "info",
    );
    restoreHookState(s.basePath);
    try {
      await rebuildState(s.basePath);
      syncCmuxSidebar(loadEffectiveGSDPreferences()?.preferences, await deriveState(s.basePath));
    } catch (e) {
      debugLog("resume-rebuild-state-failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    try {
      const report = await runGSDDoctor(s.basePath, { fix: true });
      if (report.fixesApplied.length > 0) {
        ctx.ui.notify(
          `Resume: applied ${report.fixesApplied.length} fix(es) to state.`,
          "info",
        );
      }
    } catch (e) {
      debugLog("resume-doctor-failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    invalidateAllCaches();

    if (s.pausedSessionFile) {
      const activityDir = join(gsdRoot(s.basePath), "activity");
      const recovery = synthesizeCrashRecovery(
        s.basePath,
        s.currentUnit?.type ?? "unknown",
        s.currentUnit?.id ?? "unknown",
        s.pausedSessionFile ?? undefined,
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

    updateSessionLock(
      lockBase(),
      "resuming",
      s.currentMilestoneId ?? "unknown",
      s.completedUnits.length,
    );
    writeLock(
      lockBase(),
      "resuming",
      s.currentMilestoneId ?? "unknown",
      s.completedUnits.length,
    );
    logCmuxEvent(loadEffectiveGSDPreferences()?.preferences, s.stepMode ? "Step-mode resumed." : "Auto-mode resumed.", "progress");

    await autoLoop(ctx, pi, s, buildLoopDeps());
    return;
  }

  // ── Fresh start path — delegated to auto-start.ts ──
  const bootstrapDeps: BootstrapDeps = {
    shouldUseWorktreeIsolation,
    registerSigtermHandler,
    lockBase,
    buildResolver,
  };

  const ready = await bootstrapAutoSession(
    s,
    ctx,
    pi,
    base,
    verboseMode,
    requestedStepMode,
    bootstrapDeps,
  );
  if (!ready) return;

  try {
    syncCmuxSidebar(loadEffectiveGSDPreferences()?.preferences, await deriveState(s.basePath));
  } catch {
    // Best-effort only — sidebar sync must never block auto-mode startup
  }
  logCmuxEvent(loadEffectiveGSDPreferences()?.preferences, requestedStepMode ? "Step-mode started." : "Auto-mode started.", "progress");

  // Dispatch the first unit
  await autoLoop(ctx, pi, s, buildLoopDeps());
}

// ─── Agent End Handler ────────────────────────────────────────────────────────

/**
 * Deprecated thin wrapper — kept as export for backward compatibility.
 * The actual agent_end processing now happens via resolveAgentEnd() in auto-loop.ts,
 * which is called directly from index.ts. The autoLoop() while loop handles all
 * post-unit processing (verification, hooks, dispatch) that this function used to do.
 *
 * If called by straggler code, it simply resolves the pending promise so the loop
 * can continue.
 */
export async function handleAgentEnd(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> {
  if (!s.active || !s.cmdCtx) return;
  clearUnitTimeout();
  resolveAgentEnd({ messages: [] });
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
    ? ({ light: "L", standard: "S", heavy: "H" }[s.currentUnitRouting.tier] ??
      undefined)
    : undefined;
  _updateProgressWidget(
    ctx,
    unitType,
    unitId,
    state,
    widgetStateAccessors,
    badge,
  );
}

/** State accessors for the widget — closures over module globals. */
const widgetStateAccessors: WidgetStateAccessors = {
  getAutoStartTime: () => s.autoStartTime,
  isStepMode: () => s.stepMode,
  getCmdCtx: () => s.cmdCtx,
  getBasePath: () => s.basePath,
  isVerbose: () => s.verbose,
};

// ─── Preconditions ────────────────────────────────────────────────────────────

/**
 * Ensure directories, branches, and other prerequisites exist before
 * dispatching a unit. The LLM should never need to mkdir or git checkout.
 */
function ensurePreconditions(
  unitType: string,
  unitId: string,
  base: string,
  state: GSDState,
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
  return {
    basePath: s.basePath,
    verbose: s.verbose,
    currentUnitStartedAt: s.currentUnit?.startedAt ?? Date.now(),
    unitRecoveryCount: s.unitRecoveryCount,
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

  s.currentUnit = {
    type: triggerUnitType,
    id: triggerUnitId,
    startedAt: hookStartedAt,
  };

  const result = await s.cmdCtx!.newSession();
  if (result.cancelled) {
    await stopAuto(ctx, pi);
    return false;
  }

  s.currentUnit = {
    type: hookUnitType,
    id: triggerUnitId,
    startedAt: hookStartedAt,
  };

  writeUnitRuntimeRecord(
    s.basePath,
    hookUnitType,
    triggerUnitId,
    hookStartedAt,
    {
      phase: "dispatched",
      wrapupWarningSent: false,
      timeoutAt: null,
      lastProgressAt: hookStartedAt,
      progressCount: 0,
      lastProgressKind: "dispatch",
    },
  );

  if (hookModel) {
    const availableModels = ctx.modelRegistry.getAvailable();
    const match = availableModels.find(
      (m) => m.id === hookModel || `${m.provider}/${m.id}` === hookModel,
    );
    if (match) {
      try {
        await pi.setModel(match);
      } catch {
        /* non-fatal */
      }
    }
  }

  const sessionFile = ctx.sessionManager.getSessionFile();
  writeLock(
    lockBase(),
    hookUnitType,
    triggerUnitId,
    s.completedUnits.length,
    sessionFile,
  );

  clearUnitTimeout();
  const supervisor = resolveAutoSupervisorConfig();
  const hookHardTimeoutMs = (supervisor.hard_timeout_minutes ?? 30) * 60 * 1000;
  s.unitTimeoutHandle = setTimeout(async () => {
    s.unitTimeoutHandle = null;
    if (!s.active) return;
    if (s.currentUnit) {
      writeUnitRuntimeRecord(
        s.basePath,
        hookUnitType,
        triggerUnitId,
        hookStartedAt,
        {
          phase: "timeout",
          timeoutAt: Date.now(),
        },
      );
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

  // Ensure cwd matches basePath before hook dispatch (#1389)
  try { if (process.cwd() !== s.basePath) process.chdir(s.basePath); } catch {}

  debugLog("dispatchHookUnit", {
    phase: "send-message",
    promptLength: hookPrompt.length,
  });
  pi.sendMessage(
    { customType: "gsd-auto", content: hookPrompt, display: true },
    { triggerTurn: true },
  );

  return true;
}

// Direct phase dispatch → auto-direct-dispatch.ts
export { dispatchDirectPhase } from "./auto-direct-dispatch.js";
