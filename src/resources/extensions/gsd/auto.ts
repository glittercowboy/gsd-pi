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

import { deriveState, invalidateStateCache } from "./state.js";
import type { BudgetEnforcementMode, GSDState } from "./types.js";
import { loadFile, parseRoadmap, getManifestStatus, resolveAllOverrides } from "./files.js";
import { loadPrompt } from "./prompt-loader.js";
export { inlinePriorMilestoneSummary } from "./files.js";
import { collectSecretsFromManifest } from "../get-secrets-from-user.js";
import {
  gsdRoot, resolveMilestoneFile, resolveSliceFile, resolveSlicePath,
  resolveMilestonePath, resolveDir, resolveTasksDir, resolveTaskFile,
  relMilestoneFile, relSliceFile, relSlicePath, relMilestonePath,
  milestonesDir,
  buildMilestoneFileName, buildSliceFileName, buildTaskFileName,
} from "./paths.js";
import { invalidateAllCaches } from "./cache.js";
import { saveActivityLog, clearActivityLogState } from "./activity-log.js";
import { synthesizeCrashRecovery, getDeepDiagnostic } from "./session-forensics.js";
import { writeLock, clearLock, readCrashLock, formatCrashInfo, isLockProcessAlive } from "./crash-recovery.js";
import {
  clearUnitRuntimeRecord,
  formatExecuteTaskRecoveryStatus,
  inspectExecuteTaskDurability,
  readUnitRuntimeRecord,
  writeUnitRuntimeRecord,
} from "./unit-runtime.js";
import { resolveAutoSupervisorConfig, resolveModelWithFallbacksForUnit, loadEffectiveGSDPreferences, resolveSkillDiscoveryMode, resolveDynamicRoutingConfig } from "./preferences.js";
import { sendDesktopNotification } from "./notifications.js";
import type { GSDPreferences } from "./preferences.js";
import { classifyUnitComplexity, tierLabel } from "./complexity-classifier.js";
import { resolveModelForComplexity } from "./model-router.js";
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
import {
  validatePlanBoundary,
  validateExecuteBoundary,
  validateCompleteBoundary,
  formatValidationIssues,
} from "./observability-validator.js";
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
  initMetrics, resetMetrics, snapshotUnitMetrics, getLedger,
  getProjectTotals, formatCost, formatTokenCount,
} from "./metrics.js";
import { join } from "node:path";
import { sep as pathSep } from "node:path";
import { homedir } from "node:os";
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { nativeIsRepo, nativeInit, nativeAddPaths, nativeCommit } from "./native-git-bridge.js";
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
import { showNextAction } from "../shared/next-action-ui.js";
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
  unitPhaseLabel,
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

// ─── State ────────────────────────────────────────────────────────────────────

let active = false;
let paused = false;
let stepMode = false;
let verbose = false;
let cmdCtx: ExtensionCommandContext | null = null;
let basePath = "";
let originalBasePath = "";
let gitService: GitServiceImpl | null = null;

/** Track total dispatches per unit to detect stuck loops (catches A→B→A→B patterns) */
const unitDispatchCount = new Map<string, number>();
const MAX_UNIT_DISPATCHES = 3;
/** Retry index at which a stub summary placeholder is written when the summary is still absent. */
const STUB_RECOVERY_THRESHOLD = 2;
/** Hard cap on total dispatches per unit across ALL reconciliation cycles.
 *  unitDispatchCount can be reset by loop-recovery/self-repair paths, but this
 *  counter is never reset — it catches infinite reconciliation loops where
 *  artifacts exist but deriveState keeps returning the same unit. */
const unitLifetimeDispatches = new Map<string, number>();
const MAX_LIFETIME_DISPATCHES = 6;

/** Tracks recovery attempt count per unit for backoff and diagnostics. */
const unitRecoveryCount = new Map<string, number>();

/** Persisted completed-unit keys — survives restarts. Loaded from .gsd/completed-units.json. */
const completedKeySet = new Set<string>();

/** Resource sync timestamp captured at auto-mode start. If the managed-resources
 *  manifest changes mid-session (e.g. /gsd:update or dev edit + copy-resources),
 *  templates on disk may expect variables the in-memory code doesn't provide.
 *  Detect this and stop gracefully instead of crashing. */
let resourceSyncedAtOnStart: number | null = null;

function readResourceSyncedAt(): number | null {
  const agentDir = process.env.GSD_CODING_AGENT_DIR || join(homedir(), ".gsd", "agent");
  const manifestPath = join(agentDir, "managed-resources.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    return typeof manifest?.syncedAt === "number" ? manifest.syncedAt : null;
  } catch {
    return null;
  }
}

function checkResourcesStale(): string | null {
  if (resourceSyncedAtOnStart === null) return null;
  const current = readResourceSyncedAt();
  if (current === null) return null;
  if (current !== resourceSyncedAtOnStart) {
    return "GSD resources were updated since this session started. Restart gsd to load the new code.";
  }
  return null;
}

/**
 * Resolve whether auto-mode should use worktree isolation.
 * Returns true for worktree mode (default), false for branch mode.
 * Branch mode works directly in the project root — useful for repos
 * with git submodules where worktrees don't work well (#531).
 */
function shouldUseWorktreeIsolation(): boolean {
  const prefs = loadEffectiveGSDPreferences()?.preferences?.git;
  if (prefs?.isolation === "branch") return false;
  return true; // default: worktree
}

/**
 * Detect and escape a stale worktree cwd (#608).
 *
 * After milestone completion + merge, the worktree directory is removed but
 * the process cwd may still point inside `.gsd/worktrees/<MID>/`.
 * When a new session starts, `process.cwd()` is passed as `base` to startAuto
 * and all subsequent writes land in the wrong directory. This function detects
 * that scenario and chdir back to the project root.
 *
 * Returns the corrected base path.
 */
function escapeStaleWorktree(base: string): string {
  const marker = `${pathSep}.gsd${pathSep}worktrees${pathSep}`;
  const idx = base.indexOf(marker);
  if (idx === -1) return base;

  // base is inside .gsd/worktrees/<something> — extract the project root
  const projectRoot = base.slice(0, idx);
  try {
    process.chdir(projectRoot);
  } catch {
    // If chdir fails, return the original — caller will handle errors downstream
    return base;
  }
  return projectRoot;
}

/** Crash recovery prompt — set by startAuto, consumed by first dispatchNextUnit */
let pendingCrashRecovery: string | null = null;

/** Dashboard tracking */
let autoStartTime: number = 0;
let completedUnits: { type: string; id: string; startedAt: number; finishedAt: number }[] = [];
let currentUnit: { type: string; id: string; startedAt: number } | null = null;

/** Track dynamic routing decision for the current unit (for metrics) */
let currentUnitRouting: { tier: string; modelDowngraded: boolean } | null = null;

/**
 * Model captured at auto-mode start. Used to prevent model bleed between
 * concurrent GSD instances sharing the same global settings.json (#650).
 * When preferences don't specify a model for a unit type, this ensures
 * the session's original model is re-applied instead of reading from
 * the shared global settings (which another instance may have overwritten).
 */
let autoModeStartModel: { provider: string; id: string } | null = null;

/** Track current milestone to detect transitions */
let currentMilestoneId: string | null = null;
let lastBudgetAlertLevel: BudgetAlertLevel = 0;

/** Model the user had selected before auto-mode started */
let originalModelId: string | null = null;
let originalModelProvider: string | null = null;

/** Progress-aware timeout supervision */
let unitTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
let wrapupWarningHandle: ReturnType<typeof setTimeout> | null = null;
let idleWatchdogHandle: ReturnType<typeof setInterval> | null = null;

/** Dispatch gap watchdog — detects when the state machine stalls between units.
 *  After handleAgentEnd completes, if auto-mode is still active but no new unit
 *  has been dispatched (sendMessage not called), this timer fires to force a
 *  re-evaluation. Covers the case where dispatchNextUnit silently fails or
 *  an unhandled error kills the dispatch chain. */
let dispatchGapHandle: ReturnType<typeof setTimeout> | null = null;
const DISPATCH_GAP_TIMEOUT_MS = 5_000; // 5 seconds

/** Prompt character measurement for token savings analysis (R051). */
let lastPromptCharCount: number | undefined;
let lastBaselineCharCount: number | undefined;

/** SIGTERM handler registered while auto-mode is active — cleared on stop/pause. */
let _sigtermHandler: (() => void) | null = null;

/** Tool calls currently being executed — prevents false idle detection during long-running tools. */
const inFlightTools = new Set<string>();

type BudgetAlertLevel = 0 | 75 | 90 | 100;

export function getBudgetAlertLevel(budgetPct: number): BudgetAlertLevel {
  if (budgetPct >= 1.0) return 100;
  if (budgetPct >= 0.90) return 90;
  if (budgetPct >= 0.75) return 75;
  return 0;
}

export function getNewBudgetAlertLevel(previousLevel: BudgetAlertLevel, budgetPct: number): BudgetAlertLevel | null {
  const currentLevel = getBudgetAlertLevel(budgetPct);
  if (currentLevel === 0 || currentLevel <= previousLevel) return null;
  return currentLevel;
}

export function getBudgetEnforcementAction(
  enforcement: BudgetEnforcementMode,
  budgetPct: number,
): "none" | "warn" | "pause" | "halt" {
  if (budgetPct < 1.0) return "none";
  if (enforcement === "halt") return "halt";
  if (enforcement === "pause") return "pause";
  return "warn";
}

/** Wrapper: register SIGTERM handler and store reference. */
function registerSigtermHandler(currentBasePath: string): void {
  _sigtermHandler = _registerSigtermHandler(currentBasePath, _sigtermHandler);
}

/** Wrapper: deregister SIGTERM handler and clear reference. */
function deregisterSigtermHandler(): void {
  _deregisterSigtermHandler(_sigtermHandler);
  _sigtermHandler = null;
}

export { type AutoDashboardData } from "./auto-dashboard.js";

export function getAutoDashboardData(): AutoDashboardData {
  const ledger = getLedger();
  const totals = ledger ? getProjectTotals(ledger.units) : null;
  // Pending capture count — lazy check, non-fatal
  let pendingCaptureCount = 0;
  try {
    if (basePath) {
      pendingCaptureCount = countPendingCaptures(basePath);
    }
  } catch {
    // Non-fatal — captures module may not be loaded
  }
  return {
    active,
    paused,
    stepMode,
    startTime: autoStartTime,
    elapsed: (active || paused) ? Date.now() - autoStartTime : 0,
    currentUnit: currentUnit ? { ...currentUnit } : null,
    completedUnits: [...completedUnits],
    basePath,
    totalCost: totals?.cost ?? 0,
    totalTokens: totals?.tokens.total ?? 0,
    pendingCaptureCount,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function isAutoActive(): boolean {
  return active;
}

export function isAutoPaused(): boolean {
  return paused;
}

/**
 * Mark a tool execution as in-flight. Called from index.ts on tool_execution_start.
 * Prevents the idle watchdog from declaring the agent idle while tools are executing.
 */
export function markToolStart(toolCallId: string): void {
  if (!active) return;
  inFlightTools.add(toolCallId);
}

/**
 * Mark a tool execution as completed. Called from index.ts on tool_execution_end.
 */
export function markToolEnd(toolCallId: string): void {
  inFlightTools.delete(toolCallId);
}

/**
 * Return the base path to use for the auto.lock file.
 * Always uses the original project root (not the worktree) so that
 * a second terminal can discover and stop a running auto-mode session.
 */
function lockBase(): string {
  return originalBasePath || basePath;
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
  return stepMode;
}

function clearUnitTimeout(): void {
  if (unitTimeoutHandle) {
    clearTimeout(unitTimeoutHandle);
    unitTimeoutHandle = null;
  }
  if (wrapupWarningHandle) {
    clearTimeout(wrapupWarningHandle);
    wrapupWarningHandle = null;
  }
  if (idleWatchdogHandle) {
    clearInterval(idleWatchdogHandle);
    idleWatchdogHandle = null;
  }
  inFlightTools.clear();
  clearDispatchGapWatchdog();
}

function clearDispatchGapWatchdog(): void {
  if (dispatchGapHandle) {
    clearTimeout(dispatchGapHandle);
    dispatchGapHandle = null;
  }
}

/**
 * Start a watchdog that fires if no new unit is dispatched within DISPATCH_GAP_TIMEOUT_MS
 * after handleAgentEnd completes. This catches the case where the dispatch chain silently
 * breaks (e.g., unhandled exception in dispatchNextUnit) and auto-mode is left active but idle.
 *
 * The watchdog is cleared on the next successful unit dispatch (clearUnitTimeout is called
 * at the start of handleAgentEnd, which calls clearDispatchGapWatchdog).
 */
function startDispatchGapWatchdog(ctx: ExtensionContext, pi: ExtensionAPI): void {
  clearDispatchGapWatchdog();
  dispatchGapHandle = setTimeout(async () => {
    dispatchGapHandle = null;
    if (!active || !cmdCtx) return;

    // Auto-mode is active but no unit was dispatched — the state machine stalled.
    // Re-derive state and attempt a fresh dispatch.
    if (verbose) {
      ctx.ui.notify(
        "Dispatch gap detected — re-evaluating state.",
        "info",
      );
    }

    try {
      await dispatchNextUnit(ctx, pi);
    } catch (retryErr) {
      const message = retryErr instanceof Error ? retryErr.message : String(retryErr);
      ctx.ui.notify(
        `Dispatch gap recovery failed: ${message}. Stopping auto-mode.`,
        "error",
      );
      await stopAuto(ctx, pi);
      return;
    }

    // If dispatchNextUnit returned normally but still didn't dispatch a unit
    // (no sendMessage called → no timeout set), auto-mode is permanently
    // stalled. Stop cleanly instead of leaving it active but idle (#537).
    if (active && !unitTimeoutHandle && !wrapupWarningHandle) {
      ctx.ui.notify(
        "Auto-mode stalled — no dispatchable unit found after retry. Stopping. Run /gsd auto to restart.",
        "warning",
      );
      await stopAuto(ctx, pi);
    }
  }, DISPATCH_GAP_TIMEOUT_MS);
}

export async function stopAuto(ctx?: ExtensionContext, pi?: ExtensionAPI): Promise<void> {
  if (!active && !paused) return;
  clearUnitTimeout();
  if (lockBase()) clearLock(lockBase());
  clearSkillSnapshot();
  resetSkillTelemetry();
  _dispatching = false;
  _skipDepth = 0;

  // Remove SIGTERM handler registered at auto-mode start
  deregisterSigtermHandler();

  // ── Auto-worktree: exit worktree and reset basePath on stop ──
  // Preserve the milestone branch so the next /gsd auto can re-enter
  // where it left off. The branch is only deleted during milestone
  // completion (mergeMilestoneToMain) after the work has been squash-merged.
  if (currentMilestoneId && isInAutoWorktree(basePath)) {
    try {
      // Auto-commit any dirty state before leaving so work isn't lost
      try { autoCommitCurrentBranch(basePath, "stop", currentMilestoneId); } catch { /* non-fatal */ }
      teardownAutoWorktree(originalBasePath, currentMilestoneId, { preserveBranch: true });
      basePath = originalBasePath;
      gitService = new GitServiceImpl(basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});
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
    } catch { /* non-fatal */ }
  }

  // Always restore cwd to project root on stop (#608).
  // Even if isInAutoWorktree returned false (e.g., module state was already
  // cleared by mergeMilestoneToMain), the process cwd may still be inside
  // the worktree directory. Force it back to originalBasePath.
  if (originalBasePath) {
    basePath = originalBasePath;
    try { process.chdir(basePath); } catch { /* best-effort */ }
  }

  const ledger = getLedger();
  if (ledger && ledger.units.length > 0) {
    const totals = getProjectTotals(ledger.units);
    ctx?.ui.notify(
      `Auto-mode stopped. Session: ${formatCost(totals.cost)} · ${formatTokenCount(totals.tokens.total)} tokens · ${ledger.units.length} units`,
      "info",
    );
  } else {
    ctx?.ui.notify("Auto-mode stopped.", "info");
  }

  // Sync disk state so next resume starts from accurate state
  if (basePath) {
    try { await rebuildState(basePath); } catch { /* non-fatal */ }
  }

  resetMetrics();
  resetRoutingHistory();
  resetHookState();
  if (basePath) clearPersistedHookState(basePath);
  active = false;
  paused = false;
  stepMode = false;
  unitDispatchCount.clear();
  unitRecoveryCount.clear();
  inFlightTools.clear();
  lastBudgetAlertLevel = 0;
  unitLifetimeDispatches.clear();
  currentUnit = null;
  autoModeStartModel = null;
  currentMilestoneId = null;
  originalBasePath = "";
  completedUnits = [];
  clearSliceProgressCache();
  clearActivityLogState();
  resetProactiveHealing();
  pendingCrashRecovery = null;
  _handlingAgentEnd = false;
  ctx?.ui.setStatus("gsd-auto", undefined);
  ctx?.ui.setWidget("gsd-progress", undefined);
  ctx?.ui.setFooter(undefined);

  // Restore the user's original model
  if (pi && ctx && originalModelId && originalModelProvider) {
    const original = ctx.modelRegistry.find(originalModelProvider, originalModelId);
    if (original) await pi.setModel(original);
    originalModelId = null;
    originalModelProvider = null;
  }

  cmdCtx = null;
}

/**
 * Pause auto-mode without destroying state. Context is preserved.
 * The user can interact with the agent, then `/gsd auto` resumes
 * from disk state. Called when the user presses Escape during auto-mode.
 */
export async function pauseAuto(ctx?: ExtensionContext, _pi?: ExtensionAPI): Promise<void> {
  if (!active) return;
  clearUnitTimeout();
  if (lockBase()) clearLock(lockBase());

  // Remove SIGTERM handler registered at auto-mode start
  deregisterSigtermHandler();

  active = false;
  paused = true;
  // Preserve: unitDispatchCount, currentUnit, basePath, verbose, cmdCtx,
  // completedUnits, autoStartTime, currentMilestoneId, originalModelId
  // — all needed for resume and dashboard display
  ctx?.ui.setStatus("gsd-auto", "paused");
  ctx?.ui.setWidget("gsd-progress", undefined);
  ctx?.ui.setFooter(undefined);
  const resumeCmd = stepMode ? "/gsd next" : "/gsd auto";
  ctx?.ui.notify(
    `${stepMode ? "Step" : "Auto"}-mode paused (Escape). Type to interact, or ${resumeCmd} to resume.`,
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
  if (paused) {
    paused = false;
    active = true;
    verbose = verboseMode;
    // Allow switching between step/auto on resume
    stepMode = requestedStepMode;
    cmdCtx = ctx;
    basePath = base;
    unitDispatchCount.clear();
    unitLifetimeDispatches.clear();
    // Re-initialize metrics in case ledger was lost during pause
    if (!getLedger()) initMetrics(base);
    // Ensure milestone ID is set on git service for integration branch resolution
    if (currentMilestoneId) setActiveMilestoneId(base, currentMilestoneId);

    // ── Auto-worktree: re-enter worktree on resume if not already inside ──
    // Skip if already inside a worktree (manual /worktree) to prevent nesting.
    // Skip entirely in branch isolation mode (#531).
    if (currentMilestoneId && shouldUseWorktreeIsolation() && originalBasePath && !isInAutoWorktree(basePath) && !detectWorktreeName(basePath) && !detectWorktreeName(originalBasePath)) {
      try {
        const existingWtPath = getAutoWorktreePath(originalBasePath, currentMilestoneId);
        if (existingWtPath) {
          const wtPath = enterAutoWorktree(originalBasePath, currentMilestoneId);
          basePath = wtPath;
          gitService = new GitServiceImpl(basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});
          ctx.ui.notify(`Re-entered auto-worktree at ${wtPath}`, "info");
        } else {
          // Worktree was deleted while paused — recreate it.
          const wtPath = createAutoWorktree(originalBasePath, currentMilestoneId);
          basePath = wtPath;
          gitService = new GitServiceImpl(basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});
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

    ctx.ui.setStatus("gsd-auto", stepMode ? "next" : "auto");
    ctx.ui.setFooter(hideFooter);
    ctx.ui.notify(stepMode ? "Step-mode resumed." : "Auto-mode resumed.", "info");
    // Restore hook state from disk in case session was interrupted
    restoreHookState(basePath);
    // Rebuild disk state before resuming — user interaction during pause may have changed files
    try { await rebuildState(basePath); } catch { /* non-fatal */ }
    try {
      const report = await runGSDDoctor(basePath, { fix: true });
      if (report.fixesApplied.length > 0) {
        ctx.ui.notify(`Resume: applied ${report.fixesApplied.length} fix(es) to state.`, "info");
      }
    } catch { /* non-fatal */ }
    // Self-heal: clear stale runtime records where artifacts already exist
    await selfHealRuntimeRecords(basePath, ctx, completedKeySet);
    invalidateAllCaches();
    await dispatchNextUnit(ctx, pi);
    return;
  }

  // Ensure git repo exists — GSD needs it for worktree isolation
  if (!nativeIsRepo(base)) {
    const mainBranch = loadEffectiveGSDPreferences()?.preferences?.git?.main_branch || "main";
    nativeInit(base, mainBranch);
  }

  // Ensure .gitignore has baseline patterns
  const commitDocs = loadEffectiveGSDPreferences()?.preferences?.git?.commit_docs;
  ensureGitignore(base, { commitDocs });
  untrackRuntimeFiles(base);

  // Bootstrap .gsd/ if it doesn't exist
  const gsdDir = join(base, ".gsd");
  if (!existsSync(gsdDir)) {
    mkdirSync(join(gsdDir, "milestones"), { recursive: true });
    // Only commit .gsd/ init when commit_docs is not explicitly false
    if (commitDocs !== false) {
      try {
        nativeAddPaths(base, [".gsd", ".gitignore"]);
        nativeCommit(base, "chore: init gsd");
      } catch { /* nothing to commit */ }
    }
  }

  // Initialize GitServiceImpl — basePath is set and git repo confirmed
  gitService = new GitServiceImpl(basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});

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
    // Stale lock from a dead process — synthesize crash recovery context.
    const activityDir = join(gsdRoot(base), "activity");
    const recovery = synthesizeCrashRecovery(
      base, crashLock.unitType, crashLock.unitId,
      crashLock.sessionFile, activityDir,
    );
    if (recovery && recovery.trace.toolCallCount > 0) {
      pendingCrashRecovery = recovery.prompt;
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
    clearLock(base);
  }

  let state = await deriveState(base);

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

  active = true;
  stepMode = requestedStepMode;
  verbose = verboseMode;
  cmdCtx = ctx;
  basePath = base;
  unitDispatchCount.clear();
  unitRecoveryCount.clear();
  lastBudgetAlertLevel = 0;
  unitLifetimeDispatches.clear();
  completedKeySet.clear();
  loadPersistedKeys(base, completedKeySet);
  resetHookState();
  restoreHookState(base);
  resetProactiveHealing();
  autoStartTime = Date.now();
  resourceSyncedAtOnStart = readResourceSyncedAt();
  completedUnits = [];
  currentUnit = null;
  currentMilestoneId = state.activeMilestone?.id ?? null;
  originalModelId = ctx.model?.id ?? null;
  originalModelProvider = ctx.model?.provider ?? null;

  // Register a SIGTERM handler so `kill <pid>` cleans up the lock and exits.
  registerSigtermHandler(base);

  // Capture the integration branch — records the branch the user was on when
  // auto-mode started. Slice branches will merge back to this branch instead
  // of the repo's default (main/master). Idempotent when the branch is the
  // same; updates the record when started from a different branch (#300).
  if (currentMilestoneId) {
    captureIntegrationBranch(base, currentMilestoneId, { commitDocs });
    setActiveMilestoneId(base, currentMilestoneId);
  }

  // ── Auto-worktree: create or enter worktree for the active milestone ──
  // Store the original project root before any chdir so we can restore on stop.
  // Skip if already inside a worktree (manual /worktree or another auto-worktree)
  // to prevent nested worktree creation.
  originalBasePath = base;

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

  if (currentMilestoneId && shouldUseWorktreeIsolation() && !detectWorktreeName(base) && !isUnderGsdWorktrees(base)) {
    try {
      const existingWtPath = getAutoWorktreePath(base, currentMilestoneId);
      if (existingWtPath) {
        // Worktree already exists (e.g., previous session created it) — enter it.
        const wtPath = enterAutoWorktree(base, currentMilestoneId);
        basePath = wtPath;
        gitService = new GitServiceImpl(basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});
        ctx.ui.notify(`Entered auto-worktree at ${wtPath}`, "info");
      } else {
        // Fresh start — create worktree and enter it.
        const wtPath = createAutoWorktree(base, currentMilestoneId);
        basePath = wtPath;
        gitService = new GitServiceImpl(basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});
        ctx.ui.notify(`Created auto-worktree at ${wtPath}`, "info");
      }
      // Re-register SIGTERM handler with the original basePath (lock lives there)
      registerSigtermHandler(originalBasePath);
    } catch (err) {
      // Worktree creation is non-fatal — continue in the project root.
      ctx.ui.notify(
        `Auto-worktree setup failed: ${err instanceof Error ? err.message : String(err)}. Continuing in project root.`,
        "warning",
      );
    }
  }

  // ── DB lifecycle: auto-migrate or open existing database ──
  const gsdDbPath = join(basePath, ".gsd", "gsd.db");
  const gsdDirPath = join(basePath, ".gsd");
  if (existsSync(gsdDirPath) && !existsSync(gsdDbPath)) {
    const hasDecisions = existsSync(join(gsdDirPath, "DECISIONS.md"));
    const hasRequirements = existsSync(join(gsdDirPath, "REQUIREMENTS.md"));
    const hasMilestones = existsSync(join(gsdDirPath, "milestones"));
    if (hasDecisions || hasRequirements || hasMilestones) {
      try {
        const { openDatabase: openDb } = await import("./gsd-db.js");
        const { migrateFromMarkdown } = await import("./md-importer.js");
        openDb(gsdDbPath);
        migrateFromMarkdown(basePath);
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

  // Initialize metrics — loads existing ledger from disk
  initMetrics(base);

  // Initialize routing history for adaptive learning
  initRoutingHistory(base);

  // Capture the session's current model at auto-mode start (#650).
  // This prevents model bleed when multiple GSD instances share the
  // same global settings.json — each instance remembers its own model.
  const currentModel = ctx.model;
  if (currentModel) {
    autoModeStartModel = { provider: currentModel.provider, id: currentModel.id };
  }

  // Snapshot installed skills so we can detect new ones after research
  if (resolveSkillDiscoveryMode() !== "off") {
    snapshotSkills();
  }

  ctx.ui.setStatus("gsd-auto", stepMode ? "next" : "auto");
  ctx.ui.setFooter(hideFooter);
  const modeLabel = stepMode ? "Step-mode" : "Auto-mode";
  const pendingCount = state.registry.filter(m => m.status !== 'complete').length;
  const scopeMsg = pendingCount > 1
    ? `Will loop through ${pendingCount} milestones.`
    : "Will loop until milestone complete.";
  ctx.ui.notify(`${modeLabel} started. ${scopeMsg}`, "info");

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

  // Self-heal: clear stale runtime records where artifacts already exist
  await selfHealRuntimeRecords(base, ctx, completedKeySet);

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
  } catch { /* non-fatal */ }

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
let _handlingAgentEnd = false;

export async function handleAgentEnd(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> {
  if (!active || !cmdCtx) return;
  if (_handlingAgentEnd) return;
  _handlingAgentEnd = true;

  try {

  // Unit completed — clear its timeout
  clearUnitTimeout();

  // Invalidate all caches — the unit just completed and may have
  // written planning files (task summaries, roadmap checkboxes, etc.)
  invalidateAllCaches();

  // Small delay to let files settle (git commits, file writes)
  await new Promise(r => setTimeout(r, 500));

  // Auto-commit any dirty files the LLM left behind on the current branch.
  if (currentUnit) {
    try {
      const commitMsg = autoCommitCurrentBranch(basePath, currentUnit.type, currentUnit.id);
      if (commitMsg) {
        ctx.ui.notify(`Auto-committed uncommitted changes.`, "info");
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
    try {
      const scopeParts = currentUnit.id.split("/").slice(0, 2);
      const doctorScope = scopeParts.join("/");
      const report = await runGSDDoctor(basePath, { fix: true, scope: doctorScope, fixLevel: "task" });
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
    try {
      await rebuildState(basePath);
      autoCommitCurrentBranch(basePath, currentUnit.type, currentUnit.id);
    } catch {
      // Non-fatal
    }

    // ── Rewrite-docs completion: resolve overrides and reset circuit breaker ──
    if (currentUnit.type === "rewrite-docs") {
      try {
        await resolveAllOverrides(basePath);
        resetRewriteCircuitBreaker();
        ctx.ui.notify("Override(s) resolved — rewrite-docs completed.", "info");
      } catch {
        // Non-fatal — verifyExpectedArtifact will catch unresolved overrides
      }
    }

    // ── Path A fix: verify artifact and persist completion before re-entering dispatch ──
    // After doctor + rebuildState, check whether the just-completed unit actually
    // produced its expected artifact. If so, persist the completion key now so the
    // idempotency check at the top of dispatchNextUnit() skips it — even if
    // deriveState() still returns this unit as active (e.g. branch mismatch).
    //
    // IMPORTANT: For non-hook units, defer persistence until after the hook check.
    // If a post-unit hook requests a retry, we need to remove the completion key
    // so dispatchNextUnit re-dispatches the trigger unit.
    let triggerArtifactVerified = false;
    if (!currentUnit.type.startsWith("hook/")) {
      try {
        triggerArtifactVerified = verifyExpectedArtifact(currentUnit.type, currentUnit.id, basePath);
        if (triggerArtifactVerified) {
          const completionKey = `${currentUnit.type}/${currentUnit.id}`;
          if (!completedKeySet.has(completionKey)) {
            persistCompletedKey(basePath, completionKey);
            completedKeySet.add(completionKey);
          }
          invalidateStateCache();
        }
      } catch {
        // Non-fatal — worst case we fall through to normal dispatch which has its own checks
      }
    } else {
      // Hook unit completed — finalize its runtime record and clear it
      try {
        writeUnitRuntimeRecord(basePath, currentUnit.type, currentUnit.id, currentUnit.startedAt, {
          phase: "finalized",
          progressCount: 1,
          lastProgressKind: "hook-completed",
        });
        clearUnitRuntimeRecord(basePath, currentUnit.type, currentUnit.id);
      } catch {
        // Non-fatal
      }
    }
  }

  // ── DB dual-write: re-import changed markdown files so next unit's prompts use fresh data ──
  if (isDbAvailable()) {
    try {
      const { migrateFromMarkdown } = await import("./md-importer.js");
      migrateFromMarkdown(basePath);
    } catch (err) {
      process.stderr.write(`gsd-db: re-import failed: ${(err as Error).message}\n`);
    }
  }

  // ── Post-unit hooks: check if a configured hook should run before normal dispatch ──
  if (currentUnit && !stepMode) {
    const hookUnit = checkPostUnitHooks(currentUnit.type, currentUnit.id, basePath);
    if (hookUnit) {
      // Dispatch the hook unit instead of normal flow
      const hookStartedAt = Date.now();
      if (currentUnit) {
        const modelId = ctx.model?.id ?? "unknown";
        snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId, { promptCharCount: lastPromptCharCount, baselineCharCount: lastBaselineCharCount, ...(currentUnitRouting ?? {}) });
        saveActivityLog(ctx, basePath, currentUnit.type, currentUnit.id);
      }
      currentUnit = { type: hookUnit.unitType, id: hookUnit.unitId, startedAt: hookStartedAt };
      writeUnitRuntimeRecord(basePath, hookUnit.unitType, hookUnit.unitId, hookStartedAt, {
        phase: "dispatched",
        wrapupWarningSent: false,
        timeoutAt: null,
        lastProgressAt: hookStartedAt,
        progressCount: 0,
        lastProgressKind: "dispatch",
      });

      const state = await deriveState(basePath);
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

      const result = await cmdCtx!.newSession();
      if (result.cancelled) {
        resetHookState();
        await stopAuto(ctx, pi);
        return;
      }
      const sessionFile = ctx.sessionManager.getSessionFile();
      writeLock(lockBase(), hookUnit.unitType, hookUnit.unitId, completedUnits.length, sessionFile);
      // Persist hook state so cycle counts survive crashes
      persistHookState(basePath);

      // Start supervision timers for hook units — hooks can get stuck just
      // like normal units, and without a watchdog auto-mode would hang forever.
      clearUnitTimeout();
      const supervisor = resolveAutoSupervisorConfig();
      const hookHardTimeoutMs = (supervisor.hard_timeout_minutes ?? 30) * 60 * 1000;
      unitTimeoutHandle = setTimeout(async () => {
        unitTimeoutHandle = null;
        if (!active) return;
        if (currentUnit) {
          writeUnitRuntimeRecord(basePath, hookUnit.unitType, hookUnit.unitId, currentUnit.startedAt, {
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
      if (!active) return;
      pi.sendMessage(
        { customType: "gsd-auto", content: hookUnit.prompt, display: verbose },
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
        completedKeySet.delete(triggerKey);
        removePersistedKey(basePath, triggerKey);
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
    !stepMode &&
    currentUnit &&
    !currentUnit.type.startsWith("hook/") &&
    currentUnit.type !== "triage-captures" &&
    currentUnit.type !== "quick-task"
  ) {
    try {
      if (hasPendingCaptures(basePath)) {
        const pending = loadPendingCaptures(basePath);
        if (pending.length > 0) {
          const state = await deriveState(basePath);
          const mid = state.activeMilestone?.id;
          const sid = state.activeSlice?.id;

          if (mid && sid) {
            // Build triage prompt with current context
            let currentPlan = "";
            let roadmapContext = "";
            const planFile = resolveSliceFile(basePath, mid, sid, "PLAN");
            if (planFile) currentPlan = (await loadFile(planFile)) ?? "";
            const roadmapFile = resolveMilestoneFile(basePath, mid, "ROADMAP");
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
            if (currentUnit) {
              const modelId = ctx.model?.id ?? "unknown";
              snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId);
              saveActivityLog(ctx, basePath, currentUnit.type, currentUnit.id);
            }

            // Dispatch triage as a new unit (early-dispatch-and-return)
            const triageUnitType = "triage-captures";
            const triageUnitId = `${mid}/${sid}/triage`;
            const triageStartedAt = Date.now();
            currentUnit = { type: triageUnitType, id: triageUnitId, startedAt: triageStartedAt };
            writeUnitRuntimeRecord(basePath, triageUnitType, triageUnitId, triageStartedAt, {
              phase: "dispatched",
              wrapupWarningSent: false,
              timeoutAt: null,
              lastProgressAt: triageStartedAt,
              progressCount: 0,
              lastProgressKind: "dispatch",
            });
            updateProgressWidget(ctx, triageUnitType, triageUnitId, state);

            const result = await cmdCtx!.newSession();
            if (result.cancelled) {
              await stopAuto(ctx, pi);
              return;
            }
            const sessionFile = ctx.sessionManager.getSessionFile();
            writeLock(basePath, triageUnitType, triageUnitId, completedUnits.length, sessionFile);

            // Start unit timeout for triage (use same supervisor config as hooks)
            clearUnitTimeout();
            const supervisor = resolveAutoSupervisorConfig();
            const triageTimeoutMs = (supervisor.hard_timeout_minutes ?? 30) * 60 * 1000;
            unitTimeoutHandle = setTimeout(async () => {
              unitTimeoutHandle = null;
              if (!active) return;
              ctx.ui.notify(
                `Triage unit exceeded timeout. Pausing auto-mode.`,
                "warning",
              );
              await pauseAuto(ctx, pi);
            }, triageTimeoutMs);

            if (!active) return;
            pi.sendMessage(
              { customType: "gsd-auto", content: prompt, display: verbose },
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

  // In step mode, pause and show a wizard instead of immediately dispatching
  if (stepMode) {
    await showStepWizard(ctx, pi);
    return;
  }

  try {
    await dispatchNextUnit(ctx, pi);
  } catch (dispatchErr) {
    // dispatchNextUnit threw — without this catch the error would propagate
    // to the pi event emitter which may silently swallow async rejections,
    // leaving auto-mode active but permanently stalled (see #381).
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

  // If dispatchNextUnit returned normally but auto-mode is still active and
  // no new unit timeout was set (meaning sendMessage was never called), start
  // the dispatch gap watchdog as a safety net.
  if (active && !unitTimeoutHandle && !wrapupWarningHandle) {
    startDispatchGapWatchdog(ctx, pi);
  }

  } finally {
    _handlingAgentEnd = false;
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
  if (!cmdCtx) return;

  const state = await deriveState(basePath);
  const mid = state.activeMilestone?.id;

  // Build summary of what just completed
  const justFinished = currentUnit
    ? `${unitVerb(currentUnit.type)} ${currentUnit.id}`
    : "previous unit";

  // If no active milestone or everything is complete, stop
  if (!mid || state.phase === "complete") {
    await stopAuto(ctx, pi);
    return;
  }

  // Peek at what's next by examining state
  const nextDesc = _describeNextUnit(state);

  const choice = await showNextAction(cmdCtx, {
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
    stepMode = false;
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
  const badge = currentUnitRouting?.tier
    ? ({ light: "L", standard: "S", heavy: "H" }[currentUnitRouting.tier] ?? undefined)
    : undefined;
  _updateProgressWidget(ctx, unitType, unitId, state, widgetStateAccessors, badge);
}

/** State accessors for the widget — closures over module globals. */
const widgetStateAccessors: WidgetStateAccessors = {
  getAutoStartTime: () => autoStartTime,
  isStepMode: () => stepMode,
  getCmdCtx: () => cmdCtx,
  getBasePath: () => basePath,
  isVerbose: () => verbose,
};

// ─── Core Loop ────────────────────────────────────────────────────────────────

/** Tracks recursive skip depth to prevent TUI freeze on cascading completed-unit skips */
let _skipDepth = 0;
const MAX_SKIP_DEPTH = 20;

/** Reentrancy guard for dispatchNextUnit itself (not just handleAgentEnd).
 *  Prevents concurrent dispatch from watchdog timers, step wizard, and direct calls
 *  that bypass the _handlingAgentEnd guard. Recursive calls (from skip paths) are
 *  allowed via _skipDepth > 0. */
let _dispatching = false;

async function dispatchNextUnit(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> {
  if (!active || !cmdCtx) {
    if (active && !cmdCtx) {
      ctx.ui.notify("Auto-mode session expired. Run /gsd auto to restart.", "info");
    }
    return;
  }

  // Reentrancy guard: allow recursive calls from skip paths (_skipDepth > 0)
  // but block concurrent external calls (watchdog, step wizard, etc.)
  if (_dispatching && _skipDepth === 0) {
    return; // Another dispatch is in progress — bail silently
  }
  _dispatching = true;
  try {
  // Recursion depth guard: when many units are skipped in sequence (e.g., after
  // crash recovery with 10+ completed units), recursive dispatchNextUnit calls
  // can freeze the TUI or overflow the stack. Yield generously after MAX_SKIP_DEPTH.
  if (_skipDepth > MAX_SKIP_DEPTH) {
    _skipDepth = 0;
    ctx.ui.notify(`Skipped ${MAX_SKIP_DEPTH}+ completed units. Yielding to UI before continuing.`, "info");
    await new Promise(r => setTimeout(r, 200));
  }

  // Resource version guard: detect mid-session resource updates.
  // Templates are read from disk on each dispatch but extension code is loaded
  // once at startup. If resources were re-synced (e.g. /gsd:update, npm update,
  // or dev copy-resources), templates may expect variables the in-memory code
  // doesn't provide. Stop gracefully instead of crashing.
  const staleMsg = checkResourcesStale();
  if (staleMsg) {
    await stopAuto(ctx, pi);
    ctx.ui.notify(staleMsg, "error");
    return;
  }

  // Clear all caches so deriveState sees fresh disk state (#431).
  // Parse cache is also cleared — doctor may have re-populated it with
  // stale data between handleAgentEnd and this dispatch call (Path B fix).
  invalidateAllCaches();
  lastPromptCharCount = undefined;
  lastBaselineCharCount = undefined;

  // ── Pre-dispatch health gate ──────────────────────────────────────────
  // Lightweight check for critical issues that would cause the next unit
  // to fail or corrupt state. Auto-heals what it can, blocks on the rest.
  try {
    const healthGate = preDispatchHealthGate(basePath);
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

  let state = await deriveState(basePath);
  let mid = state.activeMilestone?.id;
  let midTitle = state.activeMilestone?.title;

  // Detect milestone transition
  if (mid && currentMilestoneId && mid !== currentMilestoneId) {
    ctx.ui.notify(
      `Milestone ${currentMilestoneId} complete. Advancing to ${mid}: ${midTitle}.`,
      "info",
    );
    sendDesktopNotification("GSD", `Milestone ${currentMilestoneId} complete!`, "success", "milestone");
    // Hint: visualizer available after milestone transition
    const vizPrefs = loadEffectiveGSDPreferences()?.preferences;
    if (vizPrefs?.auto_visualize) {
      ctx.ui.notify("Run /gsd visualize to see progress overview.", "info");
    }
    // Reset stuck detection for new milestone
    unitDispatchCount.clear();
    unitRecoveryCount.clear();
    unitLifetimeDispatches.clear();
    // Clear completed-units.json for the finished milestone
    try {
      const file = completedKeysPath(basePath);
      if (existsSync(file)) writeFileSync(file, JSON.stringify([]), "utf-8");
      completedKeySet.clear();
    } catch { /* non-fatal */ }

    // ── Worktree lifecycle on milestone transition (#616) ──────────────
    // When transitioning from M_old to M_new inside a worktree, we must:
    // 1. Merge the completed milestone's worktree back to main
    // 2. Re-derive state from the project root
    // 3. Create a new worktree for the incoming milestone
    // Without this, M_new runs inside M_old's worktree on the wrong branch,
    // and artifact paths resolve against the wrong .gsd/ directory.
    if (isInAutoWorktree(basePath) && originalBasePath && shouldUseWorktreeIsolation()) {
      try {
        const roadmapPath = resolveMilestoneFile(originalBasePath, currentMilestoneId, "ROADMAP");
        if (roadmapPath) {
          const roadmapContent = readFileSync(roadmapPath, "utf-8");
          const mergeResult = mergeMilestoneToMain(originalBasePath, currentMilestoneId, roadmapContent);
          ctx.ui.notify(
            `Milestone ${currentMilestoneId} merged to main.${mergeResult.pushed ? " Pushed to remote." : ""}`,
            "info",
          );
        } else {
          // No roadmap found — teardown worktree without merge
          teardownAutoWorktree(originalBasePath, currentMilestoneId);
          ctx.ui.notify(`Exited worktree for ${currentMilestoneId} (no roadmap for merge).`, "info");
        }
      } catch (err) {
        ctx.ui.notify(
          `Milestone merge failed during transition: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
        // Force cwd back to project root even if merge failed
        if (originalBasePath) {
          try { process.chdir(originalBasePath); } catch { /* best-effort */ }
        }
      }

      // Update basePath to project root (mergeMilestoneToMain already chdir'd)
      basePath = originalBasePath;
      gitService = new GitServiceImpl(basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});
      invalidateAllCaches();

      // Re-derive state from project root before creating new worktree
      state = await deriveState(basePath);
      mid = state.activeMilestone?.id;
      midTitle = state.activeMilestone?.title;

      // Create new worktree for the incoming milestone
      if (mid) {
        captureIntegrationBranch(basePath, mid, { commitDocs: loadEffectiveGSDPreferences()?.preferences?.git?.commit_docs });
        try {
          const wtPath = createAutoWorktree(basePath, mid);
          basePath = wtPath;
          gitService = new GitServiceImpl(basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});
          ctx.ui.notify(`Created auto-worktree for ${mid} at ${wtPath}`, "info");
        } catch (err) {
          ctx.ui.notify(
            `Auto-worktree creation for ${mid} failed: ${err instanceof Error ? err.message : String(err)}. Continuing in project root.`,
            "warning",
          );
        }
      }
    } else {
      // Not in worktree — just capture integration branch for the new milestone
      captureIntegrationBranch(originalBasePath || basePath, mid, { commitDocs: loadEffectiveGSDPreferences()?.preferences?.git?.commit_docs });
    }

    // Prune completed milestone from queue order file
    const pendingIds = state.registry
      .filter(m => m.status !== "complete")
      .map(m => m.id);
    pruneQueueOrder(basePath, pendingIds);
  }
  if (mid) {
    currentMilestoneId = mid;
    setActiveMilestoneId(basePath, mid);
  }

  if (!mid) {
    // Save final session before stopping
    if (currentUnit) {
      const modelId = ctx.model?.id ?? "unknown";
      snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId, { promptCharCount: lastPromptCharCount, baselineCharCount: lastBaselineCharCount, ...(currentUnitRouting ?? {}) });
      saveActivityLog(ctx, basePath, currentUnit.type, currentUnit.id);
    }
    sendDesktopNotification("GSD", "All milestones complete!", "success", "milestone");
    await stopAuto(ctx, pi);
    return;
  }

  // Guard: mid/midTitle must be defined strings from this point onward.
  // The !mid check above returns early if mid is falsy; midTitle comes from
  // the same object so it should always be present when mid is.
  if (!midTitle) {
    await stopAuto(ctx, pi);
    return;
  }

  // ── Mid-merge safety check: detect leftover merge state from a prior session ──
  if (reconcileMergeState(basePath, ctx)) {
    invalidateAllCaches();
    state = await deriveState(basePath);
    mid = state.activeMilestone?.id;
    midTitle = state.activeMilestone?.title;
  }

  // After merge guard removal (branchless architecture), mid/midTitle could be undefined
  if (!mid || !midTitle) {
    if (currentUnit) {
      const modelId = ctx.model?.id ?? "unknown";
      snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId, { promptCharCount: lastPromptCharCount, baselineCharCount: lastBaselineCharCount, ...(currentUnitRouting ?? {}) });
      saveActivityLog(ctx, basePath, currentUnit.type, currentUnit.id);
    }
    await stopAuto(ctx, pi);
    return;
  }

  // Determine next unit
  let unitType: string;
  let unitId: string;
  let prompt: string;

  if (state.phase === "complete") {
    if (currentUnit) {
      const modelId = ctx.model?.id ?? "unknown";
      snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId, { promptCharCount: lastPromptCharCount, baselineCharCount: lastBaselineCharCount, ...(currentUnitRouting ?? {}) });
      saveActivityLog(ctx, basePath, currentUnit.type, currentUnit.id);
    }
    // Clear completed-units.json for the finished milestone so it doesn't grow unbounded.
    try {
      const file = completedKeysPath(basePath);
      if (existsSync(file)) writeFileSync(file, JSON.stringify([]), "utf-8");
      completedKeySet.clear();
    } catch { /* non-fatal */ }
    // ── Milestone merge: squash-merge milestone branch to main before stopping ──
    if (currentMilestoneId && isInAutoWorktree(basePath) && originalBasePath) {
      try {
        const roadmapPath = resolveMilestoneFile(originalBasePath, currentMilestoneId, "ROADMAP");
        if (!roadmapPath) throw new Error(`Cannot resolve ROADMAP file for milestone ${currentMilestoneId}`);
        const roadmapContent = readFileSync(roadmapPath, "utf-8");
        const mergeResult = mergeMilestoneToMain(originalBasePath, currentMilestoneId, roadmapContent);
        basePath = originalBasePath;
        gitService = new GitServiceImpl(basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});
        ctx.ui.notify(
          `Milestone ${currentMilestoneId} merged to main.${mergeResult.pushed ? " Pushed to remote." : ""}`,
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
        if (originalBasePath) {
          basePath = originalBasePath;
          try { process.chdir(basePath); } catch { /* best-effort */ }
        }
      }
    } else if (currentMilestoneId && !isInAutoWorktree(basePath)) {
      // Branch isolation mode (#603): no worktree, but we may be on a milestone/* branch.
      // Squash-merge back to the integration branch (or main) before stopping.
      try {
        const currentBranch = getCurrentBranch(basePath);
        const milestoneBranch = autoWorktreeBranch(currentMilestoneId);
        if (currentBranch === milestoneBranch) {
          const roadmapPath = resolveMilestoneFile(basePath, currentMilestoneId, "ROADMAP");
          if (roadmapPath) {
            const roadmapContent = readFileSync(roadmapPath, "utf-8");
            // mergeMilestoneToMain handles: auto-commit, checkout integration branch,
            // squash merge, commit, optional push, branch deletion.
            const mergeResult = mergeMilestoneToMain(basePath, currentMilestoneId, roadmapContent);
            gitService = new GitServiceImpl(basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});
            ctx.ui.notify(
              `Milestone ${currentMilestoneId} merged (branch mode).${mergeResult.pushed ? " Pushed to remote." : ""}`,
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
    await stopAuto(ctx, pi);
    return;
  }

  if (state.phase === "blocked") {
    if (currentUnit) {
      const modelId = ctx.model?.id ?? "unknown";
      snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId, { promptCharCount: lastPromptCharCount, baselineCharCount: lastBaselineCharCount, ...(currentUnitRouting ?? {}) });
      saveActivityLog(ctx, basePath, currentUnit.type, currentUnit.id);
    }
    await stopAuto(ctx, pi);
    const blockerMsg = `Blocked: ${state.blockers.join(", ")}`;
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
    const newBudgetAlertLevel = getNewBudgetAlertLevel(lastBudgetAlertLevel, budgetPct);
    const enforcement = prefs?.budget_enforcement ?? "pause";

    const budgetEnforcementAction = getBudgetEnforcementAction(enforcement, budgetPct);

    if (newBudgetAlertLevel === 100 && budgetEnforcementAction !== "none") {
      const msg = `Budget ceiling ${formatCost(budgetCeiling)} reached (spent ${formatCost(totalCost)}).`;
      lastBudgetAlertLevel = newBudgetAlertLevel;
      if (budgetEnforcementAction === "halt") {
        ctx.ui.notify(`${msg} Stopping auto-mode.`, "error");
        sendDesktopNotification("GSD", msg, "error", "budget");
        await stopAuto(ctx, pi);
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
      lastBudgetAlertLevel = newBudgetAlertLevel;
      ctx.ui.notify(`Budget 90%: ${formatCost(totalCost)} / ${formatCost(budgetCeiling)}`, "warning");
      sendDesktopNotification("GSD", `Budget 90%: ${formatCost(totalCost)} / ${formatCost(budgetCeiling)}`, "warning", "budget");
    } else if (newBudgetAlertLevel === 75) {
      lastBudgetAlertLevel = newBudgetAlertLevel;
      ctx.ui.notify(`Budget 75%: ${formatCost(totalCost)} / ${formatCost(budgetCeiling)}`, "info");
      sendDesktopNotification("GSD", `Budget 75%: ${formatCost(totalCost)} / ${formatCost(budgetCeiling)}`, "info", "budget");
    } else if (budgetAlertLevel === 0) {
      lastBudgetAlertLevel = 0;
    }
  } else {
    lastBudgetAlertLevel = 0;
  }

  // Context window guard — pause if approaching context limits
  const contextThreshold = prefs?.context_pause_threshold ?? 0; // 0 = disabled by default
  if (contextThreshold > 0 && cmdCtx) {
    const contextUsage = cmdCtx.getContextUsage();
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
      const manifestStatus = await getManifestStatus(basePath, mid);
      if (manifestStatus && manifestStatus.pending.length > 0) {
        const result = await collectSecretsFromManifest(basePath, mid, ctx);
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
  const dispatchResult = await resolveDispatch({
    basePath, mid, midTitle: midTitle!, state, prefs,
  });

  if (dispatchResult.action === "stop") {
    if (currentUnit) {
      const modelId = ctx.model?.id ?? "unknown";
      snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId, { promptCharCount: lastPromptCharCount, baselineCharCount: lastBaselineCharCount, ...(currentUnitRouting ?? {}) });
      saveActivityLog(ctx, basePath, currentUnit.type, currentUnit.id);
    }
    await stopAuto(ctx, pi);
    ctx.ui.notify(dispatchResult.reason, dispatchResult.level);
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
  const preDispatchResult = runPreDispatchHooks(unitType, unitId, prompt, basePath);
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

  const priorSliceBlocker = getPriorSliceCompletionBlocker(basePath, getMainBranch(basePath), unitType, unitId);
  if (priorSliceBlocker) {
    await stopAuto(ctx, pi);
    ctx.ui.notify(priorSliceBlocker, "error");
    return;
  }

  const observabilityIssues = await collectObservabilityWarnings(ctx, unitType, unitId);

  // Idempotency: skip units already completed in a prior session.
  const idempotencyKey = `${unitType}/${unitId}`;
  if (completedKeySet.has(idempotencyKey)) {
    // Cross-validate: does the expected artifact actually exist?
    const artifactExists = verifyExpectedArtifact(unitType, unitId, basePath);
    if (artifactExists) {
      ctx.ui.notify(
        `Skipping ${unitType} ${unitId} — already completed in a prior session. Advancing.`,
        "info",
      );
      _skipDepth++;
      await new Promise(r => setTimeout(r, 50));
      await dispatchNextUnit(ctx, pi);
      _skipDepth = Math.max(0, _skipDepth - 1);
      return;
    } else {
      // Stale completion record — artifact missing. Remove and re-run.
      completedKeySet.delete(idempotencyKey);
      removePersistedKey(basePath, idempotencyKey);
      ctx.ui.notify(
        `Re-running ${unitType} ${unitId} — marked complete but expected artifact missing.`,
        "warning",
      );
    }
  }

  // Fallback: if the idempotency key is missing but the expected artifact already
  // exists on disk, the task completed in a prior session without persisting the key.
  // Persist it now and skip re-dispatch. This prevents infinite loops where a task
  // completes successfully but the completion key was never written (e.g., completed
  // on the first attempt before hitting the retry-threshold persistence logic).
  if (verifyExpectedArtifact(unitType, unitId, basePath)) {
    persistCompletedKey(basePath, idempotencyKey);
    completedKeySet.add(idempotencyKey);
    invalidateStateCache();
    ctx.ui.notify(
      `Skipping ${unitType} ${unitId} — artifact exists but completion key was missing. Repaired and advancing.`,
      "info",
    );
    _skipDepth++;
    await new Promise(r => setTimeout(r, 50));
    await dispatchNextUnit(ctx, pi);
    _skipDepth = Math.max(0, _skipDepth - 1);
    return;
  }

  // Stuck detection — tracks total dispatches per unit (not just consecutive repeats).
  // Pattern A→B→A→B would reset retryCount every time; this map catches it.
  const dispatchKey = `${unitType}/${unitId}`;
  const prevCount = unitDispatchCount.get(dispatchKey) ?? 0;

  // Hard lifetime cap — survives counter resets from loop-recovery/self-repair.
  // Catches the case where reconciliation "succeeds" (artifacts exist) but
  // deriveState keeps returning the same unit, creating an infinite cycle.
  const lifetimeCount = (unitLifetimeDispatches.get(dispatchKey) ?? 0) + 1;
  unitLifetimeDispatches.set(dispatchKey, lifetimeCount);
  if (lifetimeCount > MAX_LIFETIME_DISPATCHES) {
    if (currentUnit) {
      const modelId = ctx.model?.id ?? "unknown";
      snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId, { promptCharCount: lastPromptCharCount, baselineCharCount: lastBaselineCharCount, ...(currentUnitRouting ?? {}) });
    }
    saveActivityLog(ctx, basePath, unitType, unitId);
    const expected = diagnoseExpectedArtifact(unitType, unitId, basePath);
    await stopAuto(ctx, pi);
    ctx.ui.notify(
      `Hard loop detected: ${unitType} ${unitId} dispatched ${lifetimeCount} times total (across reconciliation cycles). Stopping.${expected ? `\n   Expected artifact: ${expected}` : ""}\n   This may indicate deriveState() keeps returning the same unit despite artifacts existing.\n   Check .gsd/completed-units.json and the slice plan checkbox state.`,
      "error",
    );
    return;
  }
  if (prevCount >= MAX_UNIT_DISPATCHES) {
    if (currentUnit) {
      const modelId = ctx.model?.id ?? "unknown";
      snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId, { promptCharCount: lastPromptCharCount, baselineCharCount: lastBaselineCharCount, ...(currentUnitRouting ?? {}) });
    }
    saveActivityLog(ctx, basePath, unitType, unitId);

    // Final reconciliation pass for execute-task: write any missing durable
    // artifacts (summary placeholder + [x] checkbox) so the pipeline can
    // advance instead of stopping. This is the last resort before halting.
    if (unitType === "execute-task") {
      const [mid, sid, tid] = unitId.split("/");
      if (mid && sid && tid) {
        const status = await inspectExecuteTaskDurability(basePath, unitId);
        if (status) {
          const reconciled = skipExecuteTask(basePath, mid, sid, tid, status, "loop-recovery", prevCount);
          // reconciled: skipExecuteTask attempted to write missing artifacts.
          // verifyExpectedArtifact: confirms physical artifacts (summary + [x]) now exist on disk.
          // Both must pass before we clear the dispatch counter and advance.
          if (reconciled && verifyExpectedArtifact(unitType, unitId, basePath)) {
            ctx.ui.notify(
              `Loop recovery: ${unitId} reconciled after ${prevCount + 1} dispatches — blocker artifacts written, pipeline advancing.\n   Review ${status.summaryPath} and replace the placeholder with real work.`,
              "warning",
            );
            // Persist completion so idempotency check prevents re-dispatch
            // if deriveState keeps returning this unit (#462).
            const reconciledKey = `${unitType}/${unitId}`;
            persistCompletedKey(basePath, reconciledKey);
            completedKeySet.add(reconciledKey);
            unitDispatchCount.delete(dispatchKey);
            invalidateStateCache();
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
    if (verifyExpectedArtifact(unitType, unitId, basePath)) {
      ctx.ui.notify(
        `Loop recovery: ${unitType} ${unitId} — artifact verified after ${prevCount + 1} dispatches. Advancing.`,
        "info",
      );
      // Persist completion so the idempotency check prevents re-dispatch
      // if deriveState keeps returning this unit (see #462).
      persistCompletedKey(basePath, dispatchKey);
      completedKeySet.add(dispatchKey);
      unitDispatchCount.delete(dispatchKey);
      invalidateStateCache();
      await new Promise(r => setImmediate(r));
      await dispatchNextUnit(ctx, pi);
      return;
    }

    // Last resort for complete-milestone: generate stub summary to unblock pipeline.
    // All slices are done (otherwise we wouldn't be in completing-milestone phase),
    // but the LLM failed to write the summary N times. A stub lets the pipeline advance.
    if (unitType === "complete-milestone") {
      try {
        const mPath = resolveMilestonePath(basePath, unitId);
        if (mPath) {
          const stubPath = join(mPath, `${unitId}-SUMMARY.md`);
          if (!existsSync(stubPath)) {
            writeFileSync(stubPath, `# ${unitId} Summary\n\nAuto-generated stub — milestone tasks completed but summary generation failed after ${prevCount + 1} attempts.\nReview and replace this stub with a proper summary.\n`);
            ctx.ui.notify(`Generated stub summary for ${unitId} to unblock pipeline. Review later.`, "warning");
            persistCompletedKey(basePath, dispatchKey);
            completedKeySet.add(dispatchKey);
            unitDispatchCount.delete(dispatchKey);
            invalidateStateCache();
            await new Promise(r => setImmediate(r));
            await dispatchNextUnit(ctx, pi);
            return;
          }
        }
      } catch { /* non-fatal — fall through to normal stop */ }
    }

    const expected = diagnoseExpectedArtifact(unitType, unitId, basePath);
    const remediation = buildLoopRemediationSteps(unitType, unitId, basePath);
    await stopAuto(ctx, pi);
    sendDesktopNotification("GSD", `Loop detected: ${unitType} ${unitId}`, "error", "error");
    ctx.ui.notify(
      `Loop detected: ${unitType} ${unitId} dispatched ${prevCount + 1} times total. Expected artifact not found.${expected ? `\n   Expected: ${expected}` : ""}${remediation ? `\n\n   Remediation steps:\n${remediation}` : "\n   Check branch state and .gsd/ artifacts."}`,
      "error",
    );
    return;
  }
  unitDispatchCount.set(dispatchKey, prevCount + 1);
  if (prevCount > 0) {
    // Adaptive self-repair: each retry attempts a different remediation step.
    if (unitType === "execute-task") {
      const status = await inspectExecuteTaskDurability(basePath, unitId);
      const [mid, sid, tid] = unitId.split("/");
      if (status && mid && sid && tid) {
        if (status.summaryExists && !status.taskChecked) {
          // Retry 1+: summary exists but checkbox not marked — mark [x] and advance.
          const repaired = skipExecuteTask(basePath, mid, sid, tid, status, "self-repair", 0);
          // repaired: skipExecuteTask updated metadata (returned early-true even if regex missed).
          // verifyExpectedArtifact: confirms the physical artifact (summary + [x]) now exists.
          if (repaired && verifyExpectedArtifact(unitType, unitId, basePath)) {
            ctx.ui.notify(
              `Self-repaired ${unitId}: summary existed but checkbox was unmarked. Marked [x] and advancing.`,
              "warning",
            );
            // Persist completion so idempotency check prevents re-dispatch (#462).
            const repairedKey = `${unitType}/${unitId}`;
            persistCompletedKey(basePath, repairedKey);
            completedKeySet.add(repairedKey);
            unitDispatchCount.delete(dispatchKey);
            invalidateStateCache();
            await new Promise(r => setImmediate(r));
            await dispatchNextUnit(ctx, pi);
            return;
          }
        } else if (prevCount >= STUB_RECOVERY_THRESHOLD && !status.summaryExists) {
          // Retry STUB_RECOVERY_THRESHOLD+: summary still missing after multiple attempts.
          // Write a minimal stub summary so the next agent session has a recovery artifact
          // to overwrite, rather than starting from scratch again.
          const tasksDir = resolveTasksDir(basePath, mid, sid);
          const sDir = resolveSlicePath(basePath, mid, sid);
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
  if (currentUnit) {
    const modelId = ctx.model?.id ?? "unknown";
    snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId, { promptCharCount: lastPromptCharCount, baselineCharCount: lastBaselineCharCount, ...(currentUnitRouting ?? {}) });
    saveActivityLog(ctx, basePath, currentUnit.type, currentUnit.id);

    // Record routing outcome for adaptive learning
    if (currentUnitRouting) {
      const isRetry = currentUnit.type === unitType && currentUnit.id === unitId;
      recordOutcome(
        currentUnit.type,
        currentUnitRouting.tier as "light" | "standard" | "heavy",
        !isRetry, // success = not being retried
      );
    }

    // Only mark the previous unit as completed if:
    // 1. We're not about to re-dispatch the same unit (retry scenario)
    // 2. The expected artifact actually exists on disk
    // For hook units, skip artifact verification — hooks don't produce standard
    // artifacts and their runtime records were already finalized in handleAgentEnd.
    const closeoutKey = `${currentUnit.type}/${currentUnit.id}`;
    const incomingKey = `${unitType}/${unitId}`;
    const isHookUnit = currentUnit.type.startsWith("hook/");
    const artifactVerified = isHookUnit || verifyExpectedArtifact(currentUnit.type, currentUnit.id, basePath);
    if (closeoutKey !== incomingKey && artifactVerified) {
      if (!isHookUnit) {
        // Only persist completion keys for real units — hook keys are
        // ephemeral and should not pollute the idempotency set.
        persistCompletedKey(basePath, closeoutKey);
        completedKeySet.add(closeoutKey);
      }

      completedUnits.push({
        type: currentUnit.type,
        id: currentUnit.id,
        startedAt: currentUnit.startedAt,
        finishedAt: Date.now(),
      });
      // Cap to last 200 entries to prevent unbounded growth (#611)
      if (completedUnits.length > 200) {
        completedUnits = completedUnits.slice(-200);
      }
      clearUnitRuntimeRecord(basePath, currentUnit.type, currentUnit.id);
      unitDispatchCount.delete(`${currentUnit.type}/${currentUnit.id}`);
      unitRecoveryCount.delete(`${currentUnit.type}/${currentUnit.id}`);
    }
  }
  currentUnit = { type: unitType, id: unitId, startedAt: Date.now() };
  captureAvailableSkills(); // Capture skill telemetry at dispatch time (#599)
  writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
    phase: "dispatched",
    wrapupWarningSent: false,
    timeoutAt: null,
    lastProgressAt: currentUnit.startedAt,
    progressCount: 0,
    lastProgressKind: "dispatch",
  });

  // Status bar + progress widget
  ctx.ui.setStatus("gsd-auto", "auto");
  if (mid) updateSliceProgressCache(basePath, mid, state.activeSlice?.id);
  updateProgressWidget(ctx, unitType, unitId, state);

  // Ensure preconditions — create directories, branches, etc.
  // so the LLM doesn't have to get these right
  ensurePreconditions(unitType, unitId, basePath, state);

  // Fresh session
  const result = await cmdCtx!.newSession();
  if (result.cancelled) {
    await stopAuto(ctx, pi);
    ctx.ui.notify("Auto-mode stopped.", "info");
    return;
  }

  // Branchless architecture: all work commits sequentially on the milestone
  // branch — no per-slice branches or slice-level merges. Milestone merge
  // happens when phase === "complete" (see mergeMilestoneToMain above).

  // Write lock AFTER newSession so we capture the session file path.
  // Pi appends entries incrementally via appendFileSync, so on crash the
  // session file survives with every tool call up to the crash point.
  const sessionFile = ctx.sessionManager.getSessionFile();
  writeLock(lockBase(), unitType, unitId, completedUnits.length, sessionFile);

  // On crash recovery, prepend the full recovery briefing
  // On retry (stuck detection), prepend deep diagnostic from last attempt
  // Cap injected content to prevent unbounded prompt growth → OOM
  const MAX_RECOVERY_CHARS = 50_000;
  let finalPrompt = prompt;
  if (pendingCrashRecovery) {
    const capped = pendingCrashRecovery.length > MAX_RECOVERY_CHARS
      ? pendingCrashRecovery.slice(0, MAX_RECOVERY_CHARS) + "\n\n[...recovery briefing truncated to prevent memory exhaustion]"
      : pendingCrashRecovery;
    finalPrompt = `${capped}\n\n---\n\n${finalPrompt}`;
    pendingCrashRecovery = null;
  } else if ((unitDispatchCount.get(`${unitType}/${unitId}`) ?? 0) > 1) {
    const diagnostic = getDeepDiagnostic(basePath);
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
  lastPromptCharCount = finalPrompt.length;
  lastBaselineCharCount = undefined;
  if (isDbAvailable()) {
    try {
      const { inlineGsdRootFile } = await import("./auto-prompts.js");
      const [decisionsContent, requirementsContent, projectContent] = await Promise.all([
        inlineGsdRootFile(basePath, "decisions.md", "Decisions"),
        inlineGsdRootFile(basePath, "requirements.md", "Requirements"),
        inlineGsdRootFile(basePath, "project.md", "Project"),
      ]);
      lastBaselineCharCount =
        (decisionsContent?.length ?? 0) +
        (requirementsContent?.length ?? 0) +
        (projectContent?.length ?? 0);
    } catch {
      // Non-fatal — baseline measurement is best-effort
    }
  }

  // Switch model if preferences specify one for this unit type
  // Try primary model, then fallbacks in order if setting fails
  const modelConfig = resolveModelWithFallbacksForUnit(unitType);
  if (modelConfig) {
    const availableModels = ctx.modelRegistry.getAvailable();

    // ─── Dynamic Model Routing ─────────────────────────────────────────
    // If enabled, classify unit complexity and potentially downgrade to a
    // cheaper model. The user's configured model is the ceiling.
    const routingConfig = resolveDynamicRoutingConfig();
    let effectiveModelConfig = modelConfig;
    let routingTierLabel = "";
    currentUnitRouting = null;

    if (routingConfig.enabled) {
      // Compute budget pressure if budget ceiling is set
      let budgetPct: number | undefined;
      if (routingConfig.budget_pressure !== false) {
        const budgetCeiling = prefs?.budget_ceiling;
        if (budgetCeiling !== undefined && budgetCeiling > 0) {
          const currentLedger = getLedger();
          const totalCost = currentLedger ? getProjectTotals(currentLedger.units).cost : 0;
          budgetPct = totalCost / budgetCeiling;
        }
      }

      // Classify complexity (hook routing controlled by config.hooks)
      const isHook = unitType.startsWith("hook/");
      const shouldClassify = !isHook || routingConfig.hooks !== false;

      if (shouldClassify) {
        const classification = classifyUnitComplexity(unitType, unitId, basePath, budgetPct);
        const availableModelIds = availableModels.map(m => m.id);
        const routing = resolveModelForComplexity(classification, modelConfig, routingConfig, availableModelIds);

        if (routing.wasDowngraded) {
          effectiveModelConfig = {
            primary: routing.modelId,
            fallbacks: routing.fallbacks,
          };
          if (verbose) {
            ctx.ui.notify(
              `Dynamic routing [${tierLabel(classification.tier)}]: ${routing.modelId} (${classification.reason})`,
              "info",
            );
          }
        }
        routingTierLabel = ` [${tierLabel(classification.tier)}]`;
        currentUnitRouting = { tier: classification.tier, modelDowngraded: routing.wasDowngraded };
      }
    }

    const modelsToTry = [effectiveModelConfig.primary, ...effectiveModelConfig.fallbacks];
    let modelSet = false;

    for (const modelId of modelsToTry) {
      // Resolve model from available models.
      // Handles multiple formats:
      //   "provider/model"           → explicit provider targeting (e.g. "anthropic/claude-opus-4-6")
      //   "bare-id"                  → match by ID across providers
      //   "org/model-name"           → OpenRouter-style IDs where the full string is the model ID
      //   "openrouter/org/model"     → explicit provider + OpenRouter model ID
      const slashIdx = modelId.indexOf("/");
      let model;
      if (slashIdx !== -1) {
        const maybeProvider = modelId.substring(0, slashIdx);
        const id = modelId.substring(slashIdx + 1);

        // Check if the prefix before the first slash is a known provider
        const knownProviders = new Set(availableModels.map(m => m.provider.toLowerCase()));
        if (knownProviders.has(maybeProvider.toLowerCase())) {
          // Explicit "provider/model" format (handles "openrouter/org/model" too)
          model = availableModels.find(
            m => m.provider.toLowerCase() === maybeProvider.toLowerCase()
              && m.id.toLowerCase() === id.toLowerCase(),
          );
        }

        // If the prefix wasn't a known provider, or no match was found within that provider,
        // try matching the full string as a model ID (OpenRouter-style IDs like "org/model-name")
        if (!model) {
          const lower = modelId.toLowerCase();
          model = availableModels.find(
            m => m.id.toLowerCase() === lower
              || `${m.provider}/${m.id}`.toLowerCase() === lower,
          );
        }
      } else {
        // For bare IDs, prefer the current session's provider, then first available match
        const currentProvider = ctx.model?.provider;
        const exactProviderMatch = availableModels.find(
          m => m.id === modelId && m.provider === currentProvider,
        );
        const anyMatch = availableModels.find(m => m.id === modelId);
        model = exactProviderMatch ?? anyMatch;

        // Warn if the ID is ambiguous across providers
        if (anyMatch && !exactProviderMatch) {
          const providers = availableModels
            .filter(m => m.id === modelId)
            .map(m => m.provider);
          if (providers.length > 1) {
            ctx.ui.notify(
              `Model ID "${modelId}" exists in multiple providers (${providers.join(", ")}). ` +
              `Resolved to ${anyMatch.provider}. Use "provider/model" format for explicit targeting.`,
              "warning",
            );
          }
        }
      }
      if (!model) {
        if (verbose) ctx.ui.notify(`Model ${modelId} not found, trying fallback.`, "info");
        continue;
      }

      const ok = await pi.setModel(model, { persist: false });
      if (ok) {
        const fallbackNote = modelId === effectiveModelConfig.primary
          ? ""
          : ` (fallback from ${effectiveModelConfig.primary})`;
        const phase = unitPhaseLabel(unitType);
        ctx.ui.notify(`Model [${phase}]${routingTierLabel}: ${model.provider}/${model.id}${fallbackNote}`, "info");
        modelSet = true;
        break;
      } else {
        const nextModel = modelsToTry[modelsToTry.indexOf(modelId) + 1];
        if (nextModel) {
          if (verbose) ctx.ui.notify(`Failed to set model ${modelId}, trying ${nextModel}...`, "info");
        } else {
          ctx.ui.notify(`All preferred models unavailable for ${unitType}. Using default.`, "warning");
        }
      }
    }

    // modelSet=false is already handled by the "all fallbacks exhausted" warning above
  } else if (autoModeStartModel) {
    // No model preference for this unit type — re-apply the model captured
    // at auto-mode start to prevent bleed from the shared global settings.json
    // when multiple GSD instances run concurrently (#650).
    const availableModels = ctx.modelRegistry.getAvailable();
    const startModel = availableModels.find(
      m => m.provider === autoModeStartModel!.provider && m.id === autoModeStartModel!.id,
    );
    if (startModel) {
      const ok = await pi.setModel(startModel, { persist: false });
      if (!ok) {
        // Fallback: try matching just by ID across providers
        const byId = availableModels.find(m => m.id === autoModeStartModel!.id);
        if (byId) await pi.setModel(byId, { persist: false });
      }
    }
  }

  // Start progress-aware supervision: a soft warning, an idle watchdog, and
  // a larger hard ceiling. Productive long-running tasks may continue past the
  // soft timeout; only idle/stalled tasks pause early.
  clearUnitTimeout();
  const supervisor = resolveAutoSupervisorConfig();
  const softTimeoutMs = (supervisor.soft_timeout_minutes ?? 0) * 60 * 1000;
  const idleTimeoutMs = (supervisor.idle_timeout_minutes ?? 0) * 60 * 1000;
  const hardTimeoutMs = (supervisor.hard_timeout_minutes ?? 0) * 60 * 1000;

  wrapupWarningHandle = setTimeout(() => {
    wrapupWarningHandle = null;
    if (!active || !currentUnit) return;
    writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
      phase: "wrapup-warning-sent",
      wrapupWarningSent: true,
    });
    pi.sendMessage(
      {
        customType: "gsd-auto-wrapup",
        display: verbose,
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

  idleWatchdogHandle = setInterval(async () => {
    if (!active || !currentUnit) return;
    const runtime = readUnitRuntimeRecord(basePath, unitType, unitId);
    if (!runtime) return;
    if (Date.now() - runtime.lastProgressAt < idleTimeoutMs) return;

    // Agent has tool calls currently executing (await_job, long bash, etc.) —
    // not idle, just waiting for tool completion.
    if (inFlightTools.size > 0) {
      writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
        lastProgressAt: Date.now(),
        lastProgressKind: "tool-in-flight",
      });
      return;
    }

    // Before triggering recovery, check if the agent is actually producing
    // work on disk.  `git status --porcelain` is cheap and catches any
    // staged/unstaged/untracked changes the agent made since lastProgressAt.
    if (detectWorkingTreeActivity(basePath)) {
      writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
        lastProgressAt: Date.now(),
        lastProgressKind: "filesystem-activity",
      });
      return;
    }

    if (currentUnit) {
      const modelId = ctx.model?.id ?? "unknown";
      snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId, { promptCharCount: lastPromptCharCount, baselineCharCount: lastBaselineCharCount, ...(currentUnitRouting ?? {}) });
    }
    saveActivityLog(ctx, basePath, unitType, unitId);

    const recovery = await recoverTimedOutUnit(ctx, pi, unitType, unitId, "idle");
    if (recovery === "recovered") return;

    writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
      phase: "paused",
    });
    ctx.ui.notify(
      `Unit ${unitType} ${unitId} made no meaningful progress for ${supervisor.idle_timeout_minutes}min. Pausing auto-mode.`,
      "warning",
    );
    await pauseAuto(ctx, pi);
  }, 15000);

  unitTimeoutHandle = setTimeout(async () => {
    unitTimeoutHandle = null;
    if (!active) return;
    if (currentUnit) {
      writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
        phase: "timeout",
        timeoutAt: Date.now(),
      });
      const modelId = ctx.model?.id ?? "unknown";
      snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId, { promptCharCount: lastPromptCharCount, baselineCharCount: lastBaselineCharCount, ...(currentUnitRouting ?? {}) });
    }
    saveActivityLog(ctx, basePath, unitType, unitId);

    const recovery = await recoverTimedOutUnit(ctx, pi, unitType, unitId, "hard");
    if (recovery === "recovered") return;

    ctx.ui.notify(
      `Unit ${unitType} ${unitId} exceeded ${supervisor.hard_timeout_minutes}min hard timeout. Pausing auto-mode.`,
      "warning",
    );
    await pauseAuto(ctx, pi);
  }, hardTimeoutMs);

  // Inject prompt — verify auto-mode still active (guards against race with timeout/pause)
  if (!active) return;
  pi.sendMessage(
    { customType: "gsd-auto", content: finalPrompt, display: verbose },
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
    _dispatching = false;
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
        // Create slice dir with bare ID
        const newSliceDir = join(slicesDir, sid);
        mkdirSync(join(newSliceDir, "tasks"), { recursive: true });
      } else {
        // Ensure tasks/ subdir exists
        const tasksDir = join(slicesDir, sDir, "tasks");
        if (!existsSync(tasksDir)) {
          mkdirSync(tasksDir, { recursive: true });
        }
      }
    }
  }

}

// ─── Diagnostics ──────────────────────────────────────────────────────────────

async function collectObservabilityWarnings(
  ctx: ExtensionContext,
  unitType: string,
  unitId: string,
): Promise<import("./observability-validator.ts").ValidationIssue[]> {
  // Hook units have custom artifacts — skip standard observability checks
  if (unitType.startsWith("hook/")) return [];

  const parts = unitId.split("/");
  const mid = parts[0];
  const sid = parts[1];
  const tid = parts[2];

  if (!mid || !sid) return [];

  let issues = [] as Awaited<ReturnType<typeof validatePlanBoundary>>;

  if (unitType === "plan-slice") {
    issues = await validatePlanBoundary(basePath, mid, sid);
  } else if (unitType === "execute-task" && tid) {
    issues = await validateExecuteBoundary(basePath, mid, sid, tid);
  } else if (unitType === "complete-slice") {
    issues = await validateCompleteBoundary(basePath, mid, sid);
  }

  if (issues.length > 0) {
    ctx.ui.notify(
      `Observability check (${unitType}) found ${issues.length} warning${issues.length === 1 ? "" : "s"}:\n${formatValidationIssues(issues)}`,
      "warning",
    );
  }

  return issues;
}

function buildObservabilityRepairBlock(issues: import("./observability-validator.ts").ValidationIssue[]): string {
  if (issues.length === 0) return "";
  const items = issues.map(issue => {
    const fileName = issue.file.split("/").pop() || issue.file;
    let line = `- **${fileName}**: ${issue.message}`;
    if (issue.suggestion) line += ` → ${issue.suggestion}`;
    return line;
  });
  return [
    "",
    "---",
    "",
    "## Pre-flight: Observability gaps to fix FIRST",
    "",
    "The following issues were detected in plan/summary files for this unit.",
    "**Read each flagged file, apply the fix described, then proceed with the unit.**",
    "",
    ...items,
    "",
    "---",
    "",
  ].join("\n");
}

async function recoverTimedOutUnit(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  unitType: string,
  unitId: string,
  reason: "idle" | "hard",
): Promise<"recovered" | "paused"> {
  if (!currentUnit) return "paused";

  const runtime = readUnitRuntimeRecord(basePath, unitType, unitId);
  const recoveryAttempts = runtime?.recoveryAttempts ?? 0;
  const maxRecoveryAttempts = reason === "idle" ? 2 : 1;

  const recoveryKey = `${unitType}/${unitId}`;
  const attemptNumber = (unitRecoveryCount.get(recoveryKey) ?? 0) + 1;
  unitRecoveryCount.set(recoveryKey, attemptNumber);

  if (attemptNumber > 1) {
    // Exponential backoff: 2^(n-1) seconds, capped at 30s
    const backoffMs = Math.min(1000 * Math.pow(2, attemptNumber - 2), 30000);
    ctx.ui.notify(
      `Recovery attempt ${attemptNumber} for ${unitType} ${unitId}. Waiting ${backoffMs / 1000}s before retry.`,
      "info",
    );
    await new Promise(r => setTimeout(r, backoffMs));
  }

  if (unitType === "execute-task") {
    const status = await inspectExecuteTaskDurability(basePath, unitId);
    if (!status) return "paused";

    writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
      recovery: status,
    });

    const durableComplete = status.summaryExists && status.taskChecked && status.nextActionAdvanced;
    if (durableComplete) {
      writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
        phase: "finalized",
        recovery: status,
      });
      ctx.ui.notify(
        `${reason === "idle" ? "Idle" : "Timeout"} recovery: ${unitType} ${unitId} already completed on disk. Continuing auto-mode. (attempt ${attemptNumber})`,
        "info",
      );
      unitRecoveryCount.delete(recoveryKey);
      await dispatchNextUnit(ctx, pi);
      return "recovered";
    }

    if (recoveryAttempts < maxRecoveryAttempts) {
      const isEscalation = recoveryAttempts > 0;
      writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
        phase: "recovered",
        recovery: status,
        recoveryAttempts: recoveryAttempts + 1,
        lastRecoveryReason: reason,
        lastProgressAt: Date.now(),
        progressCount: (runtime?.progressCount ?? 0) + 1,
        lastProgressKind: reason === "idle" ? "idle-recovery-retry" : "hard-recovery-retry",
      });

      const steeringLines = isEscalation
        ? [
            `**FINAL ${reason === "idle" ? "IDLE" : "HARD TIMEOUT"} RECOVERY — last chance before this task is skipped.**`,
            `You are still executing ${unitType} ${unitId}.`,
            `Recovery attempt ${recoveryAttempts + 1} of ${maxRecoveryAttempts}.`,
            `Current durability status: ${formatExecuteTaskRecoveryStatus(status)}.`,
            "You MUST finish the durable output NOW, even if incomplete.",
            "Write the task summary with whatever you have accomplished so far.",
            "Mark the task [x] in the plan. Commit your work.",
            "A partial summary is infinitely better than no summary.",
          ]
        : [
            `**${reason === "idle" ? "IDLE" : "HARD TIMEOUT"} RECOVERY — do not stop.**`,
            `You are still executing ${unitType} ${unitId}.`,
            `Recovery attempt ${recoveryAttempts + 1} of ${maxRecoveryAttempts}.`,
            `Current durability status: ${formatExecuteTaskRecoveryStatus(status)}.`,
            "Do not keep exploring.",
            "Immediately finish the required durable output for this unit.",
            "If full completion is impossible, write the partial artifact/state needed for recovery and make the blocker explicit.",
          ];

      pi.sendMessage(
        {
          customType: "gsd-auto-timeout-recovery",
          display: verbose,
          content: steeringLines.join("\n"),
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
      ctx.ui.notify(
        `${reason === "idle" ? "Idle" : "Timeout"} recovery: steering ${unitType} ${unitId} to finish durable output (attempt ${attemptNumber}, session ${recoveryAttempts + 1}/${maxRecoveryAttempts}).`,
        "warning",
      );
      return "recovered";
    }

    // Retries exhausted — write missing durable artifacts and advance.
    const diagnostic = formatExecuteTaskRecoveryStatus(status);
    const [mid, sid, tid] = unitId.split("/");
    const skipped = mid && sid && tid
      ? skipExecuteTask(basePath, mid, sid, tid, status, reason, maxRecoveryAttempts)
      : false;

    if (skipped) {
      writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
        phase: "skipped",
        recovery: status,
        recoveryAttempts: recoveryAttempts + 1,
        lastRecoveryReason: reason,
      });
      ctx.ui.notify(
        `${unitType} ${unitId} skipped after ${maxRecoveryAttempts} recovery attempts (${diagnostic}). Blocker artifacts written. Advancing pipeline. (attempt ${attemptNumber})`,
        "warning",
      );
      unitRecoveryCount.delete(recoveryKey);
      await dispatchNextUnit(ctx, pi);
      return "recovered";
    }

    // Fallback: couldn't write skip artifacts — pause as before.
    writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
      phase: "paused",
      recovery: status,
      recoveryAttempts: recoveryAttempts + 1,
      lastRecoveryReason: reason,
    });
    ctx.ui.notify(
      `${reason === "idle" ? "Idle" : "Timeout"} recovery check for ${unitType} ${unitId}: ${diagnostic}`,
      "warning",
    );
    return "paused";
  }

  const expected = diagnoseExpectedArtifact(unitType, unitId, basePath) ?? "required durable artifact";

  // Check if the artifact already exists on disk — agent may have written it
  // without signaling completion.
  const artifactPath = resolveExpectedArtifactPath(unitType, unitId, basePath);
  if (artifactPath && existsSync(artifactPath)) {
    writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
      phase: "finalized",
      recoveryAttempts: recoveryAttempts + 1,
      lastRecoveryReason: reason,
    });
    ctx.ui.notify(
      `${reason === "idle" ? "Idle" : "Timeout"} recovery: ${unitType} ${unitId} artifact already exists on disk. Advancing. (attempt ${attemptNumber})`,
      "info",
    );
    unitRecoveryCount.delete(recoveryKey);
    await dispatchNextUnit(ctx, pi);
    return "recovered";
  }

  if (recoveryAttempts < maxRecoveryAttempts) {
    const isEscalation = recoveryAttempts > 0;
    writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
      phase: "recovered",
      recoveryAttempts: recoveryAttempts + 1,
      lastRecoveryReason: reason,
      lastProgressAt: Date.now(),
      progressCount: (runtime?.progressCount ?? 0) + 1,
      lastProgressKind: reason === "idle" ? "idle-recovery-retry" : "hard-recovery-retry",
    });

    const steeringLines = isEscalation
      ? [
          `**FINAL ${reason === "idle" ? "IDLE" : "HARD TIMEOUT"} RECOVERY — last chance before skip.**`,
          `You are still executing ${unitType} ${unitId}.`,
          `Recovery attempt ${recoveryAttempts + 1} of ${maxRecoveryAttempts} — next failure skips this unit.`,
          `Expected durable output: ${expected}.`,
          "You MUST write the artifact file NOW, even if incomplete.",
          "Write whatever you have — partial research, preliminary findings, best-effort analysis.",
          "A partial artifact is infinitely better than no artifact.",
          "If you are truly blocked, write the file with a BLOCKER section explaining why.",
        ]
      : [
          `**${reason === "idle" ? "IDLE" : "HARD TIMEOUT"} RECOVERY — stay in auto-mode.**`,
          `You are still executing ${unitType} ${unitId}.`,
          `Recovery attempt ${recoveryAttempts + 1} of ${maxRecoveryAttempts}.`,
          `Expected durable output: ${expected}.`,
          "Stop broad exploration.",
          "Write the required artifact now.",
          "If blocked, write the partial artifact and explicitly record the blocker instead of going silent.",
        ];

    pi.sendMessage(
      {
        customType: "gsd-auto-timeout-recovery",
        display: verbose,
        content: steeringLines.join("\n"),
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
    ctx.ui.notify(
      `${reason === "idle" ? "Idle" : "Timeout"} recovery: steering ${unitType} ${unitId} to produce ${expected} (attempt ${attemptNumber}, session ${recoveryAttempts + 1}/${maxRecoveryAttempts}).`,
      "warning",
    );
    return "recovered";
  }

  // Retries exhausted — write a blocker placeholder and advance the pipeline
  // instead of silently stalling.
  const placeholder = writeBlockerPlaceholder(
    unitType, unitId, basePath,
    `${reason} recovery exhausted ${maxRecoveryAttempts} attempts without producing the artifact.`,
  );

  if (placeholder) {
    writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
      phase: "skipped",
      recoveryAttempts: recoveryAttempts + 1,
      lastRecoveryReason: reason,
    });
    ctx.ui.notify(
      `${unitType} ${unitId} skipped after ${maxRecoveryAttempts} recovery attempts. Blocker placeholder written to ${placeholder}. Advancing pipeline. (attempt ${attemptNumber})`,
      "warning",
    );
    unitRecoveryCount.delete(recoveryKey);
    await dispatchNextUnit(ctx, pi);
    return "recovered";
  }

  // Fallback: couldn't resolve artifact path — pause as before.
  writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
    phase: "paused",
    recoveryAttempts: recoveryAttempts + 1,
    lastRecoveryReason: reason,
  });
  return "paused";
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
  // Ensure auto-mode is active
  if (!active) {
    // Initialize auto-mode state minimally
    active = true;
    stepMode = true;
    cmdCtx = ctx as ExtensionCommandContext;
    basePath = targetBasePath;
    autoStartTime = Date.now();
    currentUnit = null;
    completedUnits = [];
  }

  const hookUnitType = `hook/${hookName}`;
  const hookStartedAt = Date.now();
  
  // Set up the trigger unit as the "current" unit so post-unit hooks can reference it
  currentUnit = { type: triggerUnitType, id: triggerUnitId, startedAt: hookStartedAt };
  
  // Create a new session for the hook
  const result = await cmdCtx!.newSession();
  if (result.cancelled) {
    await stopAuto(ctx, pi);
    return false;
  }

  // Update current unit to the hook unit
  currentUnit = { type: hookUnitType, id: triggerUnitId, startedAt: hookStartedAt };
  
  // Write runtime record
  writeUnitRuntimeRecord(basePath, hookUnitType, triggerUnitId, hookStartedAt, {
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
  writeLock(lockBase(), hookUnitType, triggerUnitId, completedUnits.length, sessionFile);

  // Set up timeout
  clearUnitTimeout();
  const supervisor = resolveAutoSupervisorConfig();
  const hookHardTimeoutMs = (supervisor.hard_timeout_minutes ?? 30) * 60 * 1000;
  unitTimeoutHandle = setTimeout(async () => {
    unitTimeoutHandle = null;
    if (!active) return;
    if (currentUnit) {
      writeUnitRuntimeRecord(basePath, hookUnitType, triggerUnitId, hookStartedAt, {
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
  ctx.ui.setStatus("gsd-auto", stepMode ? "next" : "auto");
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
