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
import { parseUnitId } from "./unit-id.js";
import type { GSDState } from "./types.js";
import {
  assessInterruptedSession,
  readPausedSessionMetadata,
  type InterruptedSessionAssessment,
} from "./interrupted-session.js";
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
  readActiveMilestoneId,
} from "./session-forensics.js";
import {
  writeLock,
  clearLock,
  readCrashLock,
  isLockProcessAlive,
  formatCrashInfo,
  emitCrashRecoveredUnitEnd,
} from "./crash-recovery.js";
import {
  acquireSessionLock,
  getSessionLockStatus,
  releaseSessionLock,
  updateSessionLock,
} from "./session-lock.js";
import type { SessionLockStatus } from "./session-lock.js";
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
  hasInteractiveToolInFlight,
  clearInFlightTools,
  isToolInvocationError,
  isQueuedUserMessageSkip,
} from "./auto-tool-tracking.js";
import { closeoutUnit } from "./auto-unit-closeout.js";
import { recoverTimedOutUnit } from "./auto-timeout-recovery.js";
import { selectAndApplyModel, resolveModelId } from "./auto-model-selection.js";
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
  setLevelChangeCallback,
  formatHealthSummary,
  getConsecutiveErrorUnits,
} from "./doctor-proactive.js";
import { clearSkillSnapshot } from "./skill-discovery.js";
import {
  captureAvailableSkills,
  resetSkillTelemetry,
} from "./skill-telemetry.js";
import { getRtkSessionSavings } from "../shared/rtk-session-stats.js";
import { deactivateGSD } from "../shared/gsd-phase-state.js";
import {
  initMetrics,
  resetMetrics,
  getLedger,
  getProjectTotals,
  formatCost,
  formatTokenCount,
} from "./metrics.js";
import { setLogBasePath, logWarning, logError } from "./workflow-logger.js";
import { preflightCleanRoot, postflightPopStash } from "./clean-root-preflight.js";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
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
  enterBranchModeForMilestone,
  teardownAutoWorktree,
  isInAutoWorktree,
  getAutoWorktreePath,
  getAutoWorktreeOriginalBase,
  mergeMilestoneToMain,
  autoWorktreeBranch,
  syncWorktreeStateBack,
  syncProjectRootToWorktree,
  syncStateToProjectRoot,
  readResourceVersion,
  checkResourcesStale,
  escapeStaleWorktree,
} from "./auto-worktree.js";
import { pruneQueueOrder } from "./queue-order.js";
import { startCommandPolling as _startCommandPolling, isRemoteConfigured } from "../remote-questions/manager.js";

import { debugLog, isDebugEnabled, writeDebugSummary } from "./debug-logger.js";
import {
  buildLoopRemediationSteps,
  reconcileMergeState,
} from "./auto-recovery.js";
import { resolveDispatch, DISPATCH_RULES } from "./auto-dispatch.js";
import { getErrorMessage } from "./error-utils.js";
import { recoverFailedMigration } from "./migrate-external.js";
import { initRegistry, convertDispatchRules } from "./rule-registry.js";
import { emitJournalEvent as _emitJournalEvent, type JournalEntry } from "./journal.js";
import {
  type AutoDashboardData,
  updateProgressWidget as _updateProgressWidget,
  updateSliceProgressCache,
  clearSliceProgressCache,
  describeNextUnit as _describeNextUnit,
  unitVerb,
  formatAutoElapsed as _formatAutoElapsed,
  formatWidgetTokens,
  type WidgetStateAccessors,
} from "./auto-dashboard.js";
import {
  registerSigtermHandler as _registerSigtermHandler,
  deregisterSigtermHandler as _deregisterSigtermHandler,
  detectWorkingTreeActivity,
} from "./auto-supervisor.js";
import { isDbAvailable, getMilestone } from "./gsd-db.js";
import { countPendingCaptures } from "./captures.js";
import { clearCmuxSidebar, logCmuxEvent, syncCmuxSidebar } from "../cmux/index.js";

// ── Extracted modules ──────────────────────────────────────────────────────
import { startUnitSupervision } from "./auto-timers.js";
import { runPostUnitVerification } from "./auto-verification.js";
import {
  autoCommitUnit,
  postUnitPreVerification,
  postUnitPostVerification,
} from "./auto-post-unit.js";
import { bootstrapAutoSession, openProjectDbIfPresent, type BootstrapDeps } from "./auto-start.js";
import { initHealthWidget } from "./health-widget.js";
import { runLegacyAutoLoop, runUokKernelLoop, resolveAgentEnd, resolveAgentEndCancelled, _resetPendingResolve, isSessionSwitchInFlight, type LoopDeps, type ErrorContext } from "./auto-loop.js";
import { runAutoLoopWithUok } from "./uok/kernel.js";
import { resolveUokFlags } from "./uok/flags.js";
// Slice-level parallelism (#2340)
import { getEligibleSlices } from "./slice-parallel-eligibility.js";
import { startSliceParallel } from "./slice-parallel-orchestrator.js";
import {
  WorktreeResolver,
  type WorktreeResolverDeps,
} from "./worktree-resolver.js";
import { reorderForCaching } from "./prompt-ordering.js";

// ─── Session State ─────────────────────────────────────────────────────────

import {
  AutoSession,
  MAX_UNIT_DISPATCHES,
  STUB_RECOVERY_THRESHOLD,
  MAX_LIFETIME_DISPATCHES,
  NEW_SESSION_TIMEOUT_MS,
} from "./auto/session.js";
import type {
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

function captureProjectRootEnv(projectRoot: string): void {
  if (!s.projectRootEnvCaptured) {
    s.hadProjectRootEnv = Object.prototype.hasOwnProperty.call(process.env, "GSD_PROJECT_ROOT");
    s.previousProjectRootEnv = process.env.GSD_PROJECT_ROOT ?? null;
    s.projectRootEnvCaptured = true;
  }
  process.env.GSD_PROJECT_ROOT = projectRoot;
}

function restoreProjectRootEnv(): void {
  if (!s.projectRootEnvCaptured) return;

  if (s.hadProjectRootEnv && s.previousProjectRootEnv !== null) {
    process.env.GSD_PROJECT_ROOT = s.previousProjectRootEnv;
  } else {
    delete process.env.GSD_PROJECT_ROOT;
  }

  s.previousProjectRootEnv = null;
  s.hadProjectRootEnv = false;
  s.projectRootEnvCaptured = false;
}

function captureMilestoneLockEnv(milestoneId: string | null): void {
  if (!s.milestoneLockEnvCaptured) {
    s.hadMilestoneLockEnv = Object.prototype.hasOwnProperty.call(process.env, "GSD_MILESTONE_LOCK");
    s.previousMilestoneLockEnv = process.env.GSD_MILESTONE_LOCK ?? null;
    s.milestoneLockEnvCaptured = true;
  }

  if (milestoneId) {
    process.env.GSD_MILESTONE_LOCK = milestoneId;
  } else {
    delete process.env.GSD_MILESTONE_LOCK;
  }
}

function restoreMilestoneLockEnv(): void {
  if (!s.milestoneLockEnvCaptured) return;

  if (s.hadMilestoneLockEnv && s.previousMilestoneLockEnv !== null) {
    process.env.GSD_MILESTONE_LOCK = s.previousMilestoneLockEnv;
  } else {
    delete process.env.GSD_MILESTONE_LOCK;
  }

  s.previousMilestoneLockEnv = null;
  s.hadMilestoneLockEnv = false;
  s.milestoneLockEnvCaptured = false;
}

function normalizeSessionFilePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine) return null;

  // Guard against accidental message concatenation by trimming to .jsonl.
  const jsonlIndex = firstLine.toLowerCase().indexOf(".jsonl");
  const candidate = jsonlIndex >= 0 ? firstLine.slice(0, jsonlIndex + ".jsonl".length) : firstLine;
  if (!isAbsolute(candidate)) return null;
  if (!candidate.toLowerCase().endsWith(".jsonl")) return null;
  return candidate;
}

export function startAutoDetached(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  base: string,
  verboseMode: boolean,
  options?: {
    step?: boolean;
    interrupted?: InterruptedSessionAssessment;
    milestoneLock?: string | null;
  },
): void {
  void startAuto(ctx, pi, base, verboseMode, options).catch((err) => {
    const message = getErrorMessage(err);
    ctx.ui.notify(`Auto-start failed: ${message}`, "error");
    logWarning("engine", `auto start error: ${message}`, { file: "auto.ts" });
    debugLog("auto-start-failed", { error: message });
  });
}

/** Returns true if the project is configured for `isolation:worktree` mode. */
export function shouldUseWorktreeIsolation(basePath?: string): boolean {
  const prefs = loadEffectiveGSDPreferences(basePath)?.preferences?.git;
  if (prefs?.isolation === "worktree") return true;
  // Default is false — worktree isolation requires explicit opt-in
  return false;
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

/**
 * Wrapper: start background command polling for the configured remote channel
 * (currently Telegram only). Stores the cleanup function on the session so
 * every exit path can stop the interval via stopCommandPolling().
 * No-op when no remote channel is configured.
 */
function startAutoCommandPolling(basePath: string): void {
  if (!isRemoteConfigured()) return;
  // Clear any existing interval before starting a new one (e.g. resume path).
  stopAutoCommandPolling();
  s.commandPollingCleanup = _startCommandPolling(basePath);
}

/** Wrapper: stop background command polling and clear the stored cleanup. */
function stopAutoCommandPolling(): void {
  if (s.commandPollingCleanup) {
    s.commandPollingCleanup();
    s.commandPollingCleanup = null;
  }
}

export { type AutoDashboardData } from "./auto-dashboard.js";

export function getAutoDashboardData(): AutoDashboardData {
  const ledger = getLedger();
  const totals = ledger ? getProjectTotals(ledger.units) : null;
  const sessionId = s.cmdCtx?.sessionManager?.getSessionId?.() ?? null;
  const rtkSavings = sessionId && s.basePath
    ? getRtkSessionSavings(s.basePath, sessionId)
    : null;
  const rtkEnabled = loadEffectiveGSDPreferences(s.basePath || undefined)?.preferences.experimental?.rtk === true;
  // Pending capture count — lazy check, non-fatal
  let pendingCaptureCount = 0;
  try {
    if (s.basePath) {
      pendingCaptureCount = countPendingCaptures(s.basePath);
    }
  } catch (err) {
    // Non-fatal — captures module may not be loaded
    logWarning("engine", `capture count failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
  }
  return {
    active: s.active,
    paused: s.paused,
    stepMode: s.stepMode,
    startTime: s.autoStartTime,
    elapsed: s.active || s.paused
      ? (s.autoStartTime > 0 ? Date.now() - s.autoStartTime : 0)
      : 0,
    currentUnit: s.currentUnit ? { ...s.currentUnit } : null,
    basePath: s.basePath,
    totalCost: totals?.cost ?? 0,
    totalTokens: totals?.tokens.total ?? 0,
    pendingCaptureCount,
    rtkSavings,
    rtkEnabled,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function isAutoActive(): boolean {
  return s.active;
}

export function isAutoPaused(): boolean {
  return s.paused;
}

export function setActiveEngineId(id: string | null): void {
  s.activeEngineId = id;
}

export function getActiveEngineId(): string | null {
  return s.activeEngineId;
}

export function setActiveRunDir(runDir: string | null): void {
  s.activeRunDir = runDir;
}

export function getActiveRunDir(): string | null {
  return s.activeRunDir;
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

/**
 * Update the dashboard-facing dispatched model label.
 * Used when runtime recovery switches models mid-unit (e.g. provider fallback)
 * so the AUTO box reflects the active model immediately.
 */
export function setCurrentDispatchedModelId(model: { provider: string; id: string } | null): void {
  s.currentDispatchedModelId = model ? `${model.provider}/${model.id}` : null;
}

// Tool tracking — delegates to auto-tool-tracking.ts
export function markToolStart(toolCallId: string, toolName?: string): void {
  _markToolStart(toolCallId, s.active, toolName);
}

export function markToolEnd(toolCallId: string): void {
  _markToolEnd(toolCallId);
}

/**
 * Record a tool invocation error on the current session (#2883).
 * Called from tool_execution_end when a GSD tool fails with isError.
 * Only stores the error if it matches the tool-invocation-error pattern
 * (malformed/truncated JSON), not normal business-logic errors.
 */
export function recordToolInvocationError(toolName: string, errorMsg: string): void {
  if (!s.active) return;
  if (isToolInvocationError(errorMsg) || isQueuedUserMessageSkip(errorMsg)) {
    s.lastToolInvocationError = `${toolName}: ${errorMsg}`;
  }
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

  // Never SIGTERM ourselves — a stale lock with our own PID is not a remote
  // session, it is leftover from a prior loop exit in this process. (#2730)
  if (lock.pid === process.pid) {
    clearLock(projectRoot);
    return { found: false };
  }

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
} {
  const lock = readCrashLock(projectRoot);
  if (!lock) return { running: false };

  // Our own PID is not a "remote" session — it is a stale lock left by this
  // process (e.g. after step-mode exit without full cleanup). (#2730)
  if (lock.pid === process.pid) return { running: false };

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

/** Build snapshot metric opts. */
function buildSnapshotOpts(
  _unitType: string,
  _unitId: string,
): {
  autoSessionKey?: string;
  continueHereFired?: boolean;
  promptCharCount?: number;
  baselineCharCount?: number;
  traceId?: string;
  turnId?: string;
  gitAction?: "commit" | "snapshot" | "status-only";
  gitPush?: boolean;
  gitStatus?: "ok" | "failed";
  gitError?: string;
} & Record<string, unknown> {
  const prefs = loadEffectiveGSDPreferences(s.basePath || undefined)?.preferences;
  const uokFlags = resolveUokFlags(prefs);
  return {
    ...(s.autoStartTime > 0 ? { autoSessionKey: String(s.autoStartTime) } : {}),
    promptCharCount: s.lastPromptCharCount,
    baselineCharCount: s.lastBaselineCharCount,
    traceId: s.currentTraceId ?? undefined,
    turnId: s.currentTurnId ?? undefined,
    ...(uokFlags.gitops
      ? {
          gitAction: uokFlags.gitopsTurnAction,
          gitPush: uokFlags.gitopsTurnPush,
          gitStatus: s.lastGitActionStatus ?? undefined,
          gitError: s.lastGitActionFailure ?? undefined,
        }
      : {}),
    ...(s.currentUnitRouting ?? {}),
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
  deactivateGSD();
  clearUnitTimeout();
  stopAutoCommandPolling();
  restoreProjectRootEnv();
  restoreMilestoneLockEnv();
  deregisterSigtermHandler();
  clearCmuxSidebar(loadEffectiveGSDPreferences(s.basePath || undefined)?.preferences);
  const base = lockBase();
  const lockFilePath = base ? join(gsdRoot(base), "auto.lock") : "unknown";
  const recoverySuggestion = "\nTo recover, run: gsd doctor --fix";
  const message =
    lockStatus?.failureReason === "pid-mismatch"
      ? lockStatus.existingPid
        ? `Session lock (${lockFilePath}) moved to PID ${lockStatus.existingPid} — another GSD process appears to have taken over. Stopping gracefully.${recoverySuggestion}`
        : `Session lock (${lockFilePath}) moved to a different process — another GSD process appears to have taken over. Stopping gracefully.${recoverySuggestion}`
      : lockStatus?.failureReason === "missing-metadata"
        ? `Session lock metadata (${lockFilePath}) disappeared, so ownership could not be confirmed. Stopping gracefully.${recoverySuggestion}`
        : lockStatus?.failureReason === "compromised"
          ? `Session lock (${lockFilePath}) was compromised during heartbeat checks (PID ${process.pid}). This can happen after long event loop stalls during subagent execution.${recoverySuggestion}`
          : `Session lock lost (${lockFilePath}). Stopping gracefully.${recoverySuggestion}`;
  ctx?.ui.notify(
    message,
    "error",
  );
  ctx?.ui.setStatus("gsd-auto", undefined);
  ctx?.ui.setWidget("gsd-progress", undefined);
  if (ctx) initHealthWidget(ctx);
}

/**
 * Lightweight cleanup after autoLoop exits via step-wizard break.
 *
 * Unlike stopAuto (which tears down the entire session), this only clears
 * the stale unit state, progress widget, status badge, and restores CWD so
 * the dashboard does not show an orphaned timer and the shell is usable.
 */
function cleanupAfterLoopExit(ctx: ExtensionContext): void {
  s.currentUnit = null;
  s.active = false;
  deactivateGSD();
  clearUnitTimeout();
  stopAutoCommandPolling();
  restoreProjectRootEnv();
  restoreMilestoneLockEnv();

  // Clear crash lock and release session lock so the next `/gsd next` does
  // not see a stale lock with the current PID and treat it as a "remote"
  // session (which would cause it to SIGTERM itself). (#2730)
  try {
    if (lockBase()) clearLock(lockBase());
    if (lockBase()) releaseSessionLock(lockBase());
  } catch (err) {
    /* best-effort — mirror stopAuto cleanup */
    logWarning("session", `lock cleanup failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
  }

  // A transient provider-error pause intentionally leaves the paused badge
  // visible so the user still has a resumable auto-mode signal on screen.
  if (!s.paused) {
    ctx.ui.setStatus("gsd-auto", undefined);
    ctx.ui.setWidget("gsd-progress", undefined);
    initHealthWidget(ctx);
  }

  // Restore CWD out of worktree back to original project root
  if (s.originalBasePath) {
    s.basePath = s.originalBasePath;
    try {
      process.chdir(s.basePath);
    } catch (err) {
      /* best-effort */
      logWarning("engine", `chdir failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
    }
  }
}

export async function stopAuto(
  ctx?: ExtensionContext,
  pi?: ExtensionAPI,
  reason?: string,
): Promise<void> {
  if (!s.active && !s.paused) return;
  const loadedPreferences = loadEffectiveGSDPreferences(s.basePath || undefined)?.preferences;
  const reasonSuffix = reason ? ` — ${reason}` : "";

  try {
    // ── Step 1: Timers and locks ──
    try {
      clearUnitTimeout();
      stopAutoCommandPolling();
      if (lockBase()) clearLock(lockBase());
      if (lockBase()) releaseSessionLock(lockBase());
    } catch (e) {
      debugLog("stop-cleanup-locks", { error: e instanceof Error ? e.message : String(e) });
    }

    // ── Step 1b: Flush queued follow-up messages (#3512) ──
    // Late async notifications (async_job_result, gsd-auto-wrapup) can trigger
    // extra LLM turns after stop. Flush them the same way run-unit.ts does.
    try {
      const cmdCtxAny = s.cmdCtx as Record<string, unknown> | null;
      if (typeof cmdCtxAny?.clearQueue === "function") {
        (cmdCtxAny.clearQueue as () => unknown)();
      }
    } catch (e) {
      debugLog("stop-cleanup-queue", { error: e instanceof Error ? e.message : String(e) });
    }

    // ── Step 2: Skill state ──
    try {
      clearSkillSnapshot();
      resetSkillTelemetry();
    } catch (e) {
      debugLog("stop-cleanup-skills", { error: e instanceof Error ? e.message : String(e) });
    }

    // ── Step 3: SIGTERM handler ──
    try {
      deregisterSigtermHandler();
    } catch (e) {
      debugLog("stop-cleanup-sigterm", { error: e instanceof Error ? e.message : String(e) });
    }

    // ── Step 4: Auto-worktree exit ──
    // When the milestone is complete (has a SUMMARY), merge the worktree branch
    // back to main so code isn't stranded on the worktree branch (#2317).
    // For incomplete milestones, preserve the branch for later resumption.
    //
    // Skip if phases.ts already merged this milestone — avoids the double
    // mergeAndExit that fails because the branch was already deleted (#2645).
    try {
      if (s.currentMilestoneId && !s.milestoneMergedInPhases) {
        const notifyCtx = ctx
          ? { notify: ctx.ui.notify.bind(ctx.ui) }
          : { notify: () => {} };
        const resolver = buildResolver();

        // Check if the milestone is complete. DB status is the authoritative
        // signal — only a successful gsd_complete_milestone call flips it to
        // "complete" (tools/complete-milestone.ts). SUMMARY file presence is
        // NOT sufficient: a blocker placeholder stub or a partial write can
        // leave a file behind without the milestone actually being done,
        // which previously caused stopAuto to merge a failed milestone and
        // emit a misleading metadata-only merge warning (#4175).
        // DB-unavailable projects fall back to SUMMARY-file presence.
        let milestoneComplete = false;
        try {
          if (isDbAvailable()) {
            const dbRow = getMilestone(s.currentMilestoneId);
            milestoneComplete = dbRow?.status === "complete";
          } else {
            const summaryPath = resolveMilestoneFile(
              s.originalBasePath || s.basePath,
              s.currentMilestoneId,
              "SUMMARY",
            );
            if (!summaryPath) {
              // Also check in the worktree path (SUMMARY may not be synced yet)
              const wtSummaryPath = resolveMilestoneFile(
                s.basePath,
                s.currentMilestoneId,
                "SUMMARY",
              );
              milestoneComplete = wtSummaryPath !== null;
            } else {
              milestoneComplete = true;
            }
          }
        } catch (err) {
          // Non-fatal — fall through to preserveBranch path
          logWarning("engine", `milestone summary check failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
        }

        if (milestoneComplete) {
          // Milestone is complete — merge worktree branch back to main
          resolver.mergeAndExit(s.currentMilestoneId, notifyCtx);
        } else {
          // Milestone still in progress — preserve branch for later resumption
          resolver.exitMilestone(s.currentMilestoneId, notifyCtx, {
            preserveBranch: true,
          });
        }
      }
    } catch (e) {
      debugLog("stop-cleanup-worktree", { error: e instanceof Error ? e.message : String(e) });
    }

    // ── Step 5: Rebuild state while DB is still open (#3599) ──
    // rebuildState() calls deriveState() which needs the DB for authoritative
    // state. Previously this ran after closeDatabase(), forcing a filesystem
    // fallback that could disagree with the DB-backed dispatch decisions —
    // a split-brain where dispatch says "blocked" but STATE.md shows work.
    if (s.basePath) {
      try {
        await rebuildState(s.basePath);
      } catch (e) {
        debugLog("stop-rebuild-state-failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // ── Step 6: DB cleanup ──
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

    // ── Step 7: Restore basePath and chdir ──
    try {
      if (s.originalBasePath) {
        s.basePath = s.originalBasePath;
        try {
          process.chdir(s.basePath);
        } catch (err) {
          /* best-effort */
          logWarning("engine", `chdir failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
        }
      }
    } catch (e) {
      debugLog("stop-cleanup-basepath", { error: e instanceof Error ? e.message : String(e) });
    }

    // ── Step 8: Ledger notification ──
    try {
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
    } catch (e) {
      debugLog("stop-cleanup-ledger", { error: e instanceof Error ? e.message : String(e) });
    }

    // ── Step 9: Cmux sidebar / event log ──
    try {
      clearCmuxSidebar(loadedPreferences);
      logCmuxEvent(
        loadedPreferences,
        `Auto-mode stopped${reasonSuffix || ""}.`,
        reason?.startsWith("Blocked:") ? "warning" : "info",
      );
    } catch (e) {
      debugLog("stop-cleanup-cmux", { error: e instanceof Error ? e.message : String(e) });
    }

    // ── Step 10: Debug summary ──
    try {
      if (isDebugEnabled()) {
        const logPath = writeDebugSummary();
        if (logPath) {
          ctx?.ui.notify(`Debug log written → ${logPath}`, "info");
        }
      }
    } catch (e) {
      debugLog("stop-cleanup-debug", { error: e instanceof Error ? e.message : String(e) });
    }

    // ── Step 11: Reset metrics, routing, hooks ──
    try {
      resetMetrics();
      resetRoutingHistory();
      resetHookState();
      if (s.basePath) clearPersistedHookState(s.basePath);
    } catch (e) {
      debugLog("stop-cleanup-metrics", { error: e instanceof Error ? e.message : String(e) });
    }

    // ── Step 12: Remove paused-session metadata (#1383) ──
    try {
      const pausedPath = join(gsdRoot(s.originalBasePath || s.basePath), "runtime", "paused-session.json");
      if (existsSync(pausedPath)) unlinkSync(pausedPath);
    } catch (err) { /* non-fatal */
      logWarning("engine", `file unlink failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
    }

    // ── Step 13: Restore original model + thinking (before reset clears IDs) ──
    try {
      if (pi && ctx && s.originalModelId && s.originalModelProvider) {
        const original = ctx.modelRegistry.find(
          s.originalModelProvider,
          s.originalModelId,
        );
        if (original) await pi.setModel(original);
      }
      if (pi && s.originalThinkingLevel) {
        pi.setThinkingLevel(s.originalThinkingLevel);
      }
    } catch (e) {
      debugLog("stop-cleanup-model", { error: e instanceof Error ? e.message : String(e) });
    }

    // ── Step 14: Unblock pending unitPromise (#1799) ──
    // resolveAgentEnd unblocks autoLoop's `await unitPromise` so it can see
    // s.active === false and exit cleanly. Without this, autoLoop hangs
    // forever and the interactive loop is blocked.
    try {
      resolveAgentEnd({ messages: [] });
      _resetPendingResolve();
    } catch (e) {
      debugLog("stop-cleanup-pending-resolve", { error: e instanceof Error ? e.message : String(e) });
    }
  } finally {
    // ── Critical invariants: these MUST execute regardless of errors ──
    // Browser teardown — prevent orphaned Chrome processes across retries (#1733)
    try {
      const { getBrowser } = await import("../browser-tools/state.js");
      if (getBrowser()) {
        const { closeBrowser } = await import("../browser-tools/lifecycle.js");
        await closeBrowser();
      }
    } catch (err) { /* non-fatal: browser-tools may not be loaded */
      logWarning("engine", `browser teardown failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
    }

    // External cleanup (not covered by session reset)
    clearInFlightTools();
    clearSliceProgressCache();
    clearActivityLogState();
    setLevelChangeCallback(null);
    resetProactiveHealing();

    // UI cleanup
    ctx?.ui.setStatus("gsd-auto", undefined);
    ctx?.ui.setWidget("gsd-progress", undefined);
    if (ctx) initHealthWidget(ctx);
    restoreProjectRootEnv();
    restoreMilestoneLockEnv();

    // Reset all session state in one call
    s.reset();
  }
}

/**
 * Pause auto-mode without destroying state. Context is preserved.
 * The user can interact with the agent, then `/gsd auto` resumes
 * from disk state. Called when the user presses Escape during auto-mode.
 */
export async function pauseAuto(
  ctx?: ExtensionContext,
  _pi?: ExtensionAPI,
  _errorContext?: ErrorContext,
): Promise<void> {
  if (!s.active) return;
  clearUnitTimeout();
  stopAutoCommandPolling();

  // Flush queued follow-up messages (#3512).
  // Late async notifications (async_job_result, gsd-auto-wrapup) can trigger
  // extra LLM turns after pause. Flush them the same way run-unit.ts does.
  try {
    const cmdCtxAny = s.cmdCtx as Record<string, unknown> | null;
    if (typeof cmdCtxAny?.clearQueue === "function") {
      (cmdCtxAny.clearQueue as () => unknown)();
    }
  } catch (e) {
    debugLog("pause-cleanup-queue", { error: e instanceof Error ? e.message : String(e) });
  }

  // Unblock any pending unit promise so the auto-loop is not orphaned.
  // Pass errorContext so runUnitPhase can distinguish user-initiated pause
  // from provider-error pause and avoid hard-stopping (#2762).
  resolveAgentEndCancelled(_errorContext);

  s.pausedSessionFile = normalizeSessionFilePath(ctx?.sessionManager?.getSessionFile() ?? null);

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
      unitType: s.currentUnit?.type ?? undefined,
      unitId: s.currentUnit?.id ?? undefined,
      activeEngineId: s.activeEngineId,
      activeRunDir: s.activeRunDir,
      autoStartTime: s.autoStartTime,
      milestoneLock: s.sessionMilestoneLock ?? undefined,
    };
    const runtimeDir = join(gsdRoot(s.originalBasePath || s.basePath), "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, "paused-session.json"),
      JSON.stringify(pausedMeta, null, 2),
      "utf-8",
    );
  } catch (err) {
    // Non-fatal — resume will still work via full bootstrap, just without worktree context
    logWarning("engine", `paused-session file write failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
  }

  // Close out the current unit so its runtime record doesn't stay at "dispatched"
  if (s.currentUnit && ctx) {
    try {
      await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt);
    } catch (err) {
      // Non-fatal — best-effort closeout on pause
      logWarning("engine", `unit closeout on pause failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
    }
    s.currentUnit = null;
  }

  if (lockBase()) {
    releaseSessionLock(lockBase());
    clearLock(lockBase());
  }

  deregisterSigtermHandler();

  // Unblock pending unitPromise so autoLoop exits cleanly (#1799)
  resolveAgentEnd({ messages: [] });
  _resetPendingResolve();

  s.active = false;
  s.paused = true;
  deactivateGSD();
  restoreProjectRootEnv();
  restoreMilestoneLockEnv();
  s.pendingVerificationRetry = null;
  s.verificationRetryCount.clear();
  ctx?.ui.setStatus("gsd-auto", "paused");
  ctx?.ui.setWidget("gsd-progress", undefined);
  if (ctx) initHealthWidget(ctx);
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
    enterBranchModeForMilestone,
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
  // Initialize the unified rule registry with converted dispatch rules.
  // Must happen before LoopDeps is assembled so facade functions
  // (resolveDispatch, runPreDispatchHooks, etc.) delegate to the registry.
  initRegistry(convertDispatchRules(DISPATCH_RULES));

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
    rebuildState,
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
    // Unit closeout + runtime records
    closeoutUnit,
    autoCommitUnit,
    recordOutcome,
    writeLock,
    captureAvailableSkills,
    ensurePreconditions,
    updateSliceProgressCache,

    // Model selection + supervision
    selectAndApplyModel,
    resolveModelId,
    startUnitSupervision,

    // Prompt helpers
    getDeepDiagnostic: (basePath: string) => {
      const mid = readActiveMilestoneId(basePath);
      const wtPath = mid ? getAutoWorktreePath(basePath, mid) : undefined;
      return getDeepDiagnostic(basePath, wtPath ?? undefined);
    },
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

    // Journal
    emitJournalEvent: (entry: JournalEntry) => _emitJournalEvent(s.basePath, entry),

    // Clean-root preflight gate (#2909)
    preflightCleanRoot,
    postflightPopStash,
  } as unknown as LoopDeps;
}

/**
 * Start auto-mode. Handles both fresh-start and resume paths, sets up session
 * state, enters the milestone worktree or branch, and dispatches the first unit.
 * No-ops if auto-mode is already active.
 */
export async function startAuto(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  base: string,
  verboseMode: boolean,
  options?: {
    step?: boolean;
    interrupted?: InterruptedSessionAssessment;
    milestoneLock?: string | null;
  },
): Promise<void> {
  if (s.active) {
    debugLog("startAuto", { phase: "already-active", skipping: true });
    return;
  }

  const requestedStepMode = options?.step ?? false;
  const interruptedAssessment = options?.interrupted ?? null;
  if (options?.milestoneLock !== undefined) {
    s.sessionMilestoneLock = options.milestoneLock ?? null;
  }
  if (s.sessionMilestoneLock) {
    captureMilestoneLockEnv(s.sessionMilestoneLock);
  }

  // Escape stale worktree cwd from a previous milestone (#608).
  base = escapeStaleWorktree(base);

  // Heal .gsd.migrating before any branching — covers both fresh-start and
  // resume paths (#4416). The matching call in auto-start.ts covers the
  // bootstrap-only path; this call ensures the resume path is also protected.
  if (recoverFailedMigration(base)) {
    ctx.ui.notify("Recovered unfinished migration (.gsd.migrating → .gsd).", "info");
  }

  const freshStartAssessment = interruptedAssessment
    ?? await assessInterruptedSession(base);

  if (freshStartAssessment.classification === "running") {
    const pid = freshStartAssessment.lock?.pid;
    ctx.ui.notify(
      pid
        ? `Another auto-mode session (PID ${pid}) appears to be running.\nStop it with \`kill ${pid}\` before starting a new session.`
        : "Another auto-mode session appears to be running.",
      "error",
    );
    return;
  }

  // If resuming from paused state, just re-activate and dispatch next unit.
  // Check persisted paused-session first (#1383) — survives /exit.
  if (!s.paused) {
    try {
      const meta = freshStartAssessment.pausedSession ?? readPausedSessionMetadata(base);
      const pausedPath = join(gsdRoot(base), "runtime", "paused-session.json");
      if (meta?.activeEngineId && meta.activeEngineId !== "dev") {
        // Custom workflow resume — restore engine state
        s.activeEngineId = meta.activeEngineId;
        s.activeRunDir = meta.activeRunDir ?? null;
        s.originalBasePath = meta.originalBasePath || base;
        s.stepMode = meta.stepMode ?? requestedStepMode;
        s.autoStartTime = meta.autoStartTime || Date.now();
        s.sessionMilestoneLock = meta.milestoneLock ?? null;
        s.paused = true;
        try { unlinkSync(pausedPath); } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
            logWarning("session", `pause file cleanup failed: ${e instanceof Error ? e.message : String(e)}`, { file: "auto.ts" });
          }
        }
        ctx.ui.notify(
          `Resuming paused custom workflow${meta.activeRunDir ? ` (${meta.activeRunDir})` : ""}.`,
          "info",
        );
      } else if (meta?.milestoneId) {
        const shouldResumePausedSession =
          freshStartAssessment.classification === "recoverable"
          && (
            freshStartAssessment.hasResumableDiskState
            || !!freshStartAssessment.recoveryPrompt
            || !!freshStartAssessment.lock
          );
        if (shouldResumePausedSession) {
          // Validate the milestone still exists and isn't already complete (#1664).
          const mDir = resolveMilestonePath(base, meta.milestoneId);
          const summaryFile = resolveMilestoneFile(base, meta.milestoneId, "SUMMARY");
          if (!mDir || summaryFile) {
            try { unlinkSync(pausedPath); } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                logWarning("session", `pause file cleanup failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
              }
            }
            ctx.ui.notify(
              `Paused milestone ${meta.milestoneId} is ${!mDir ? "missing" : "already complete"}. Starting fresh.`,
              "info",
            );
          } else {
            s.currentMilestoneId = meta.milestoneId;
            s.originalBasePath = meta.originalBasePath || base;
            s.stepMode = meta.stepMode ?? requestedStepMode;
            s.pausedSessionFile = normalizeSessionFilePath(meta.sessionFile ?? null);
            s.pausedUnitType = meta.unitType ?? null;
            s.pausedUnitId = meta.unitId ?? null;
            s.autoStartTime = meta.autoStartTime || Date.now();
            s.sessionMilestoneLock = meta.milestoneLock ?? null;
            s.paused = true;
            try { unlinkSync(pausedPath); } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
                logWarning("session", `pause file cleanup failed: ${e instanceof Error ? e.message : String(e)}`, { file: "auto.ts" });
              }
            }
            ctx.ui.notify(
              `Resuming paused session for ${meta.milestoneId}${meta.worktreePath && existsSync(meta.worktreePath) ? ` (worktree)` : ""}.`,
              "info",
            );
          }
        } else if (existsSync(pausedPath)) {
          try { unlinkSync(pausedPath); } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
              logWarning("session", `stale pause file cleanup failed: ${e instanceof Error ? e.message : String(e)}`, { file: "auto.ts" });
            }
          }
        }
      }
    } catch (err) {
      // Malformed or missing — proceed with fresh bootstrap
      logWarning("session", `paused-session restore failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
    }
    // Guard against zero/missing autoStartTime after resume (#3585)
    if (!s.autoStartTime || s.autoStartTime <= 0) s.autoStartTime = Date.now();
  }

  if (s.sessionMilestoneLock) {
    captureMilestoneLockEnv(s.sessionMilestoneLock);
  }

  if (!s.paused) {
    s.stepMode = requestedStepMode;
  }

  if (freshStartAssessment.lock) {
    // Emit a synthetic unit-end for any unit-start that has no closing event.
    // This closes the journal gap reported in #3348 where the worker wrote side
    // effects (SUMMARY.md, DB updates) but died before emitting unit-end.
    emitCrashRecoveredUnitEnd(base, freshStartAssessment.lock);
    clearLock(base);
  }

  if (!s.paused) {
    s.pendingCrashRecovery =
      freshStartAssessment.classification === "recoverable"
        ? freshStartAssessment.recoveryPrompt
        : null;

    if (freshStartAssessment.classification === "recoverable" && freshStartAssessment.lock) {
      const info = formatCrashInfo(freshStartAssessment.lock);
      if (freshStartAssessment.recoveryToolCallCount > 0) {
        ctx.ui.notify(
          `${info}\nRecovered ${freshStartAssessment.recoveryToolCallCount} tool calls from crashed session. Resuming with full context.`,
          "warning",
        );
      } else if (freshStartAssessment.hasResumableDiskState) {
        ctx.ui.notify(`${info}\nResuming from disk state.`, "warning");
      }
    }
  }

  if (s.paused) {
    const resumeLock = acquireSessionLock(base);
    if (!resumeLock.acquired) {
      // Reset paused state so isAutoPaused() doesn't stick true after lock failure.
      // Pause file is preserved on disk for retry — not deleted.
      s.paused = false;
      ctx.ui.notify(`Cannot resume: ${resumeLock.reason}`, "error");
      return;
    }

    // Lock acquired — now safe to delete the pause file
    if (s.pausedSessionFile) {
      try { unlinkSync(s.pausedSessionFile); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          logWarning("session", `pause file cleanup failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
        }
      }
      s.pausedSessionFile = null;
    }

    s.paused = false;
    s.active = true;
    s.verbose = verboseMode;
    s.stepMode = requestedStepMode;
    s.cmdCtx = ctx;
    s.basePath = base;
    // Ensure the workflow-logger audit log is pinned to the project root
    // even when auto-mode is entered via a path that bypasses the
    // bootstrap/dynamic-tools ensureDbOpen() → setLogBasePath() chain
    // (e.g. /clear resume, hot-reload).
    setLogBasePath(base);
    s.unitDispatchCount.clear();
    s.unitLifetimeDispatches.clear();
    if (!getLedger()) initMetrics(base);
    if (s.currentMilestoneId) setActiveMilestoneId(base, s.currentMilestoneId);

    // Re-register health level notification callback lost across process restart
    setLevelChangeCallback((_from, to, summary) => {
      const level = to === "red" ? "error" : to === "yellow" ? "warning" : "info";
      ctx.ui.notify(summary, level as "info" | "warning" | "error");
    });

    // ── Auto-worktree / branch-mode: re-enter on resume ──
    if (
      s.currentMilestoneId &&
      getIsolationMode(s.originalBasePath || s.basePath) !== "none" &&
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
    ctx.ui.setWidget("gsd-health", undefined);
    ctx.ui.notify(
      s.stepMode ? "Step-mode resumed." : "Auto-mode resumed.",
      "info",
    );
    restoreHookState(s.basePath);
    // Re-sync managed resources on resume so long-lived auto sessions pick up
    // bundled extension updates before resume-time verification/state logic runs.
    // GSD_PKG_ROOT is set by loader.ts and points to the gsd-pi package root.
    // The relative import ("../../../resource-loader.js") only works from the source
    // tree; deployed extensions live at ~/.gsd/agent/extensions/gsd/ where the
    // relative path resolves to ~/.gsd/agent/resource-loader.js which doesn't exist.
    // Using GSD_PKG_ROOT constructs a correct absolute path in both contexts (#3949).
    const agentDir = process.env.GSD_CODING_AGENT_DIR || join(process.env.GSD_HOME || homedir(), ".gsd", "agent");
    const pkgRoot = process.env.GSD_PKG_ROOT;
    const resourceLoaderPath = pkgRoot
      ? pathToFileURL(join(pkgRoot, "dist", "resource-loader.js")).href
      : new URL("../../../resource-loader.js", import.meta.url).href;
    const { initResources } = await import(resourceLoaderPath);
    initResources(agentDir);
    // Open the project DB before rebuild/derive so resume uses DB-backed
    // state instead of falling back to stale markdown parsing (#2940).
    await openProjectDbIfPresent(s.basePath);
    try {
      await rebuildState(s.basePath);
      syncCmuxSidebar(loadEffectiveGSDPreferences(s.basePath || undefined)?.preferences, await deriveState(s.basePath));
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
        s.currentUnit?.type ?? s.pausedUnitType ?? "unknown",
        s.currentUnit?.id ?? s.pausedUnitId ?? "unknown",
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
    );
    writeLock(
      lockBase(),
      "resuming",
      s.currentMilestoneId ?? "unknown",
    );
    logCmuxEvent(loadEffectiveGSDPreferences(s.basePath || undefined)?.preferences, s.stepMode ? "Step-mode resumed." : "Auto-mode resumed.", "progress");

    captureProjectRootEnv(s.originalBasePath || s.basePath);
    startAutoCommandPolling(s.basePath);
    await runAutoLoopWithUok({
      ctx,
      pi,
      s,
      deps: buildLoopDeps(),
      runKernelLoop: runUokKernelLoop,
      runLegacyLoop: runLegacyAutoLoop,
    });
    cleanupAfterLoopExit(ctx);
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
    freshStartAssessment,
  );
  if (!ready) return;

  captureProjectRootEnv(s.originalBasePath || s.basePath);
  try {
    syncCmuxSidebar(loadEffectiveGSDPreferences(s.basePath || undefined)?.preferences, await deriveState(s.basePath));
  } catch (err) {
    // Best-effort only — sidebar sync must never block auto-mode startup
    logWarning("engine", `cmux sync failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
  }
  logCmuxEvent(loadEffectiveGSDPreferences(s.basePath || undefined)?.preferences, requestedStepMode ? "Step-mode started." : "Auto-mode started.", "progress");

  startAutoCommandPolling(s.basePath);

  // Dispatch the first unit
  await runAutoLoopWithUok({
    ctx,
    pi,
    s,
    deps: buildLoopDeps(),
    runKernelLoop: runUokKernelLoop,
    runLegacyLoop: runLegacyAutoLoop,
  });
  cleanupAfterLoopExit(ctx);
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
  isSessionSwitching: isSessionSwitchInFlight,
  getCurrentDispatchedModelId: () => s.currentDispatchedModelId,
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
  const { milestone: mid, slice: sid } = parseUnitId(unitId);

  const mDir = resolveMilestonePath(base, mid);
  if (!mDir) {
    const newDir = join(milestonesDir(base), mid);
    mkdirSync(join(newDir, "slices"), { recursive: true });
  }

  if (sid !== undefined) {

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

  if (hookModel) {
    const availableModels = ctx.modelRegistry.getAvailable();
    const match = resolveModelId(hookModel, availableModels, ctx.model?.provider);
    if (match) {
      try {
        await pi.setModel(match);
      } catch (err) {
        /* non-fatal */
        logWarning("dispatch", `hook model set failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
      }
    } else {
      ctx.ui.notify(
        `Hook model "${hookModel}" not found in available models. Falling back to current session model. ` +
        `Ensure the model is defined in models.json and has auth configured.`,
        "warning",
      );
    }
  }

  const sessionFile = normalizeSessionFilePath(ctx.sessionManager.getSessionFile());
  writeLock(
    lockBase(),
    hookUnitType,
    triggerUnitId,
    sessionFile ?? undefined,
  );

  clearUnitTimeout();
  const supervisor = resolveAutoSupervisorConfig();
  const hookHardTimeoutMs = (supervisor.hard_timeout_minutes ?? 30) * 60 * 1000;
  s.unitTimeoutHandle = setTimeout(async () => {
    s.unitTimeoutHandle = null;
    if (!s.active) return;
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
  try { if (process.cwd() !== s.basePath) process.chdir(s.basePath); } catch (err) {
    logWarning("engine", `chdir failed before hook dispatch: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
  }

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

// Re-export recovery functions for external consumers
export {
  buildLoopRemediationSteps,
} from "./auto-recovery.js";
export { resolveExpectedArtifactPath } from "./auto-artifact-paths.js";
