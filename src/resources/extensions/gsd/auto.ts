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
import { loadFile, parseRoadmap, getManifestStatus, clearParseCache } from "./files.js";
export { inlinePriorMilestoneSummary } from "./files.js";
import { collectSecretsFromManifest } from "../get-secrets-from-user.js";
import {
  gsdRoot, resolveMilestoneFile, resolveSliceFile, resolveSlicePath,
  resolveMilestonePath, resolveDir, resolveTasksDir, resolveTaskFile,
  relMilestoneFile, relSliceFile, relSlicePath, relMilestonePath,
  milestonesDir,
  buildMilestoneFileName, buildSliceFileName, buildTaskFileName,
  clearPathCache,
} from "./paths.js";
import { saveActivityLog } from "./activity-log.js";
import { synthesizeCrashRecovery, getDeepDiagnostic } from "./session-forensics.js";
import { writeLock, clearLock, readCrashLock, formatCrashInfo, isLockProcessAlive } from "./crash-recovery.js";
import {
  clearUnitRuntimeRecord,
  formatExecuteTaskRecoveryStatus,
  inspectExecuteTaskDurability,
  readUnitRuntimeRecord,
  writeUnitRuntimeRecord,
} from "./unit-runtime.js";
import { resolveAutoSupervisorConfig, resolveModelWithFallbacksForUnit, loadEffectiveGSDPreferences } from "./preferences.js";
import { sendDesktopNotification } from "./notifications.js";
import type { GSDPreferences } from "./preferences.js";
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
import { runGSDDoctor, rebuildState } from "./doctor.js";
import { snapshotSkills, clearSkillSnapshot } from "./skill-discovery.js";
import {
  initMetrics, resetMetrics, snapshotUnitMetrics, getLedger,
  getProjectTotals, formatCost, formatTokenCount,
} from "./metrics.js";
import { join } from "node:path";
import { sep as pathSep } from "node:path";
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
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
import { GitServiceImpl, runGit } from "./git-service.js";
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
} from "./auto-worktree.js";
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
import {
  buildResearchMilestonePrompt,
  buildPlanMilestonePrompt,
  buildResearchSlicePrompt,
  buildPlanSlicePrompt,
  buildExecuteTaskPrompt,
  buildCompleteSlicePrompt,
  buildCompleteMilestonePrompt,
  buildReplanSlicePrompt,
  buildRunUatPrompt,
  buildReassessRoadmapPrompt,
  checkNeedsReassessment,
  checkNeedsRunUat,
} from "./auto-prompts.js";
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

/** Crash recovery prompt — set by startAuto, consumed by first dispatchNextUnit */
let pendingCrashRecovery: string | null = null;

/** Dashboard tracking */
let autoStartTime: number = 0;
let completedUnits: { type: string; id: string; startedAt: number; finishedAt: number }[] = [];
let currentUnit: { type: string; id: string; startedAt: number } | null = null;

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

/** SIGTERM handler registered while auto-mode is active — cleared on stop/pause. */
let _sigtermHandler: (() => void) | null = null;

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
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function isAutoActive(): boolean {
  return active;
}

export function isAutoPaused(): boolean {
  return paused;
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
    }
  }, DISPATCH_GAP_TIMEOUT_MS);
}

export async function stopAuto(ctx?: ExtensionContext, pi?: ExtensionAPI): Promise<void> {
  if (!active && !paused) return;
  clearUnitTimeout();
  if (basePath) clearLock(basePath);
  clearSkillSnapshot();
  _dispatching = false;
  _skipDepth = 0;

  // Remove SIGTERM handler registered at auto-mode start
  deregisterSigtermHandler();

  // ── Auto-worktree: exit worktree and reset basePath on stop ──
  if (currentMilestoneId && isInAutoWorktree(basePath)) {
    try {
      teardownAutoWorktree(originalBasePath, currentMilestoneId);
      basePath = originalBasePath;
      gitService = new GitServiceImpl(basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});
      ctx?.ui.notify("Exited auto-worktree.", "info");
    } catch (err) {
      ctx?.ui.notify(
        `Auto-worktree teardown failed: ${err instanceof Error ? err.message : String(err)}`,
        "warning",
      );
      // Force basePath back to original even if teardown failed
      if (originalBasePath) {
        basePath = originalBasePath;
        try { process.chdir(basePath); } catch { /* best-effort */ }
      }
    }
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
  resetHookState();
  if (basePath) clearPersistedHookState(basePath);
  active = false;
  paused = false;
  stepMode = false;
  unitDispatchCount.clear();
  unitRecoveryCount.clear();
  lastBudgetAlertLevel = 0;
  unitLifetimeDispatches.clear();
  currentUnit = null;
  currentMilestoneId = null;
  originalBasePath = "";
  clearSliceProgressCache();
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
  if (basePath) clearLock(basePath);

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
    if (currentMilestoneId && originalBasePath && !isInAutoWorktree(basePath) && !detectWorktreeName(basePath) && !detectWorktreeName(originalBasePath)) {
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

    // Re-register SIGTERM handler for the resumed session
    registerSigtermHandler(basePath);

    ctx.ui.setStatus("gsd-auto", stepMode ? "next" : "auto");
    ctx.ui.setFooter(hideFooter);
    ctx.ui.notify(stepMode ? "Step-mode resumed." : "Auto-mode resumed.", "info");
    // Restore hook state from disk in case session was interrupted
    restoreHookState(base);
    // Rebuild disk state before resuming — user interaction during pause may have changed files
    try { await rebuildState(base); } catch { /* non-fatal */ }
    try {
      const report = await runGSDDoctor(base, { fix: true });
      if (report.fixesApplied.length > 0) {
        ctx.ui.notify(`Resume: applied ${report.fixesApplied.length} fix(es) to state.`, "info");
      }
    } catch { /* non-fatal */ }
    // Self-heal: clear stale runtime records where artifacts already exist
    await selfHealRuntimeRecords(base, ctx, completedKeySet);
    invalidateStateCache();
    clearParseCache();
    clearPathCache();
    await dispatchNextUnit(ctx, pi);
    return;
  }

  // Ensure git repo exists — GSD needs it for worktree isolation
  try {
    execSync("git rev-parse --git-dir", { cwd: base, stdio: "pipe" });
  } catch {
    const mainBranch = loadEffectiveGSDPreferences()?.preferences?.git?.main_branch || "main";
    execFileSync("git", ["init", "-b", mainBranch], { cwd: base, stdio: "pipe" });
  }

  // Ensure .gitignore has baseline patterns
  ensureGitignore(base);
  untrackRuntimeFiles(base);

  // Bootstrap .gsd/ if it doesn't exist
  const gsdDir = join(base, ".gsd");
  if (!existsSync(gsdDir)) {
    mkdirSync(join(gsdDir, "milestones"), { recursive: true });
    try {
      execSync("git add -A .gsd .gitignore && git commit -m 'chore: init gsd'", {
        cwd: base, stdio: "pipe",
      });
    } catch { /* nothing to commit */ }
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

  const state = await deriveState(base);

  // No active work at all — start a new milestone via the discuss flow.
  if (!state.activeMilestone || state.phase === "complete") {
    const { showSmartEntry } = await import("./guided-flow.js");
    await showSmartEntry(ctx, pi, base, { step: requestedStepMode });
    return;
  }

  // Active milestone exists but has no roadmap — check if context exists.
  // If context was pre-written (multi-milestone planning), auto-mode can
  // research and plan it. If no context either, need user discussion.
  if (state.phase === "pre-planning") {
    const contextFile = resolveMilestoneFile(base, state.activeMilestone.id, "CONTEXT");
    const hasContext = !!(contextFile && await loadFile(contextFile));
    if (!hasContext) {
      const { showSmartEntry } = await import("./guided-flow.js");
      await showSmartEntry(ctx, pi, base, { step: requestedStepMode });
      return;
    }
    // Has context, no roadmap — auto-mode will research + plan it
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
  autoStartTime = Date.now();
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
    captureIntegrationBranch(base, currentMilestoneId);
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

  if (currentMilestoneId && !detectWorktreeName(base) && !isUnderGsdWorktrees(base)) {
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
      // Re-register SIGTERM handler with the new basePath
      registerSigtermHandler(basePath);
    } catch (err) {
      // Worktree creation is non-fatal — continue in the project root.
      ctx.ui.notify(
        `Auto-worktree setup failed: ${err instanceof Error ? err.message : String(err)}. Continuing in project root.`,
        "warning",
      );
    }
  }

  // Initialize metrics — loads existing ledger from disk
  initMetrics(base);

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
  const mid = state.activeMilestone.id;
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

  // Invalidate deriveState() cache — the unit just completed and may have
  // written planning files (task summaries, roadmap checkboxes, etc.)
  invalidateStateCache();
  clearParseCache();
  clearPathCache();

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
    } catch {
      // Non-fatal — doctor failure should never block dispatch
    }
    try {
      await rebuildState(basePath);
      autoCommitCurrentBranch(basePath, currentUnit.type, currentUnit.id);
    } catch {
      // Non-fatal
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

  // ── Post-unit hooks: check if a configured hook should run before normal dispatch ──
  if (currentUnit && !stepMode) {
    const hookUnit = checkPostUnitHooks(currentUnit.type, currentUnit.id, basePath);
    if (hookUnit) {
      // Dispatch the hook unit instead of normal flow
      const hookStartedAt = Date.now();
      if (currentUnit) {
        const modelId = ctx.model?.id ?? "unknown";
        snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId);
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
      writeLock(basePath, hookUnit.unitType, hookUnit.unitId, completedUnits.length, sessionFile);
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
  _updateProgressWidget(ctx, unitType, unitId, state, widgetStateAccessors);
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

  // Clear stale directory listing cache so deriveState sees fresh disk state (#431)
  clearPathCache();
  // Clear parsed roadmap/plan cache — doctor may have re-populated it with
  // stale data between handleAgentEnd and this dispatch call (Path B fix).
  clearParseCache();

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
    // Reset stuck detection for new milestone
    unitDispatchCount.clear();
    unitRecoveryCount.clear();
    unitLifetimeDispatches.clear();
    // Capture integration branch for the new milestone and update git service
    captureIntegrationBranch(originalBasePath || basePath, mid);
  }
  if (mid) {
    currentMilestoneId = mid;
    setActiveMilestoneId(basePath, mid);
  }

  if (!mid) {
    // Save final session before stopping
    if (currentUnit) {
      const modelId = ctx.model?.id ?? "unknown";
      snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId);
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
    invalidateStateCache();
    clearParseCache();
    clearPathCache();
    state = await deriveState(basePath);
    mid = state.activeMilestone?.id;
    midTitle = state.activeMilestone?.title;
  }

  // After merge guard removal (branchless architecture), mid/midTitle could be undefined
  if (!mid || !midTitle) {
    if (currentUnit) {
      const modelId = ctx.model?.id ?? "unknown";
      snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId);
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
      snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId);
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
      }
    }
    sendDesktopNotification("GSD", `Milestone ${mid} complete!`, "success", "milestone");
    await stopAuto(ctx, pi);
    return;
  }

  if (state.phase === "blocked") {
    if (currentUnit) {
      const modelId = ctx.model?.id ?? "unknown";
      snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId);
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
    if (contextUsage && contextUsage.percent >= contextThreshold) {
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

  const needsRunUat = await checkNeedsRunUat(basePath, mid, state, prefs);
  // Flag: for human/mixed UAT, pause auto-mode after the prompt is sent so the user
  // can perform the UAT manually. On next resume, result file will exist → skip.
  let pauseAfterUatDispatch = false;

  // ── Phase-first dispatch: complete-slice MUST run before reassessment ──
  // If the current phase is "summarizing", complete-slice is responsible for
  // complete-slice must run before reassessment.
  if (state.phase === "summarizing") {
    const sid = state.activeSlice!.id;
    const sTitle = state.activeSlice!.title;
    unitType = "complete-slice";
    unitId = `${mid}/${sid}`;
    prompt = await buildCompleteSlicePrompt(mid, midTitle!, sid, sTitle, basePath);
  } else {
    // ── Adaptive Replanning: check if last completed slice needs reassessment ──
    // Computed here (after summarizing guard) so complete-slice always runs first.
    const needsReassess = await checkNeedsReassessment(basePath, mid, state);
    if (needsRunUat) {
      const { sliceId, uatType } = needsRunUat;
      unitType = "run-uat";
      unitId = `${mid}/${sliceId}`;
      const uatFile = resolveSliceFile(basePath, mid, sliceId, "UAT")!;
      const uatContent = await loadFile(uatFile);
      prompt = await buildRunUatPrompt(
        mid, sliceId, relSliceFile(basePath, mid, sliceId, "UAT"), uatContent ?? "", basePath,
      );
      // For non-artifact-driven UAT types, pause after the prompt is dispatched.
      // The agent receives the prompt, writes S0x-UAT-RESULT.md surfacing the UAT,
      // then auto-mode pauses for human execution. On resume, result file exists → skip.
      if (uatType !== "artifact-driven") {
        pauseAfterUatDispatch = true;
      }
    } else if (needsReassess) {
      unitType = "reassess-roadmap";
      unitId = `${mid}/${needsReassess.sliceId}`;
      prompt = await buildReassessRoadmapPrompt(mid, midTitle!, needsReassess.sliceId, basePath);
    } else if (state.phase === "needs-discussion") {
      // Draft milestone — pause auto-mode and notify user.
      // This milestone has a CONTEXT-DRAFT.md from a prior multi-milestone discussion
      // where the user chose "Needs own discussion". Auto-mode cannot proceed because
      // the draft is seed material, not a finalized context — planning requires a
      // dedicated discussion first.
      await stopAuto(ctx, pi);
      ctx.ui.notify(
        `${mid}: ${midTitle} has draft context from a prior discussion — needs its own discussion before planning.\nRun /gsd to discuss.`,
        "warning",
      );
      return;

    } else if (state.phase === "pre-planning") {
      // Need roadmap — check if context exists
      const contextFile = resolveMilestoneFile(basePath, mid, "CONTEXT");
      const hasContext = !!(contextFile && await loadFile(contextFile));

      if (!hasContext) {
        await stopAuto(ctx, pi);
        ctx.ui.notify("No context or roadmap yet. Run /gsd to discuss first.", "warning");
        return;
      }

      // Research before roadmap if no research exists
      const researchFile = resolveMilestoneFile(basePath, mid, "RESEARCH");
      const hasResearch = !!researchFile;

      if (!hasResearch) {
        unitType = "research-milestone";
        unitId = mid;
        prompt = await buildResearchMilestonePrompt(mid, midTitle!, basePath);
      } else {
        unitType = "plan-milestone";
        unitId = mid;
        prompt = await buildPlanMilestonePrompt(mid, midTitle!, basePath);
      }

    } else if (state.phase === "planning") {
      // Slice needs planning — but research first if no research exists
      const sid = state.activeSlice!.id;
      const sTitle = state.activeSlice!.title;
      const researchFile = resolveSliceFile(basePath, mid, sid, "RESEARCH");
      const hasResearch = !!researchFile;

      if (!hasResearch) {
        // Skip slice research for S01 when milestone research already exists —
        // the milestone research already covers the same ground for the first slice.
        const milestoneResearchFile = resolveMilestoneFile(basePath, mid, "RESEARCH");
        const hasMilestoneResearch = !!milestoneResearchFile;
        if (hasMilestoneResearch && sid === "S01") {
          unitType = "plan-slice";
          unitId = `${mid}/${sid}`;
          prompt = await buildPlanSlicePrompt(mid, midTitle!, sid, sTitle, basePath);
        } else {
          unitType = "research-slice";
          unitId = `${mid}/${sid}`;
          prompt = await buildResearchSlicePrompt(mid, midTitle!, sid, sTitle, basePath);
        }
      } else {
        unitType = "plan-slice";
        unitId = `${mid}/${sid}`;
        prompt = await buildPlanSlicePrompt(mid, midTitle!, sid, sTitle, basePath);
      }

    } else if (state.phase === "replanning-slice") {
      // Blocker discovered — replan the slice before continuing
      const sid = state.activeSlice!.id;
      const sTitle = state.activeSlice!.title;
      unitType = "replan-slice";
      unitId = `${mid}/${sid}`;
      prompt = await buildReplanSlicePrompt(mid, midTitle!, sid, sTitle, basePath);

    } else if (state.phase === "executing" && state.activeTask) {
      // Execute next task
      const sid = state.activeSlice!.id;
      const sTitle = state.activeSlice!.title;
      const tid = state.activeTask.id;
      const tTitle = state.activeTask.title;
      unitType = "execute-task";
      unitId = `${mid}/${sid}/${tid}`;
      prompt = await buildExecuteTaskPrompt(mid, sid, sTitle, tid, tTitle, basePath);

    } else if (state.phase === "completing-milestone") {
      // All slices done — complete the milestone
      unitType = "complete-milestone";
      unitId = mid;
      prompt = await buildCompleteMilestonePrompt(mid, midTitle!, basePath);

    } else {
      if (currentUnit) {
        const modelId = ctx.model?.id ?? "unknown";
        snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId);
        saveActivityLog(ctx, basePath, currentUnit.type, currentUnit.id);
      }
      await stopAuto(ctx, pi);
      ctx.ui.notify(`Unhandled phase "${state.phase}" — run /gsd doctor to diagnose.`, "info");
      return;
    }
  }

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
      snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId);
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
      snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId);
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
    snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId);
    saveActivityLog(ctx, basePath, currentUnit.type, currentUnit.id);

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
      clearUnitRuntimeRecord(basePath, currentUnit.type, currentUnit.id);
      unitDispatchCount.delete(`${currentUnit.type}/${currentUnit.id}`);
      unitRecoveryCount.delete(`${currentUnit.type}/${currentUnit.id}`);
    }
  }
  currentUnit = { type: unitType, id: unitId, startedAt: Date.now() };
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

  // NOTE: Slice merge happens AFTER the complete-slice unit finishes,
  // not here at dispatch time. See the merge logic at the top of
  // dispatchNextUnit where we check if the previous unit was complete-slice.

  // Write lock AFTER newSession so we capture the session file path.
  // Pi appends entries incrementally via appendFileSync, so on crash the
  // session file survives with every tool call up to the crash point.
  const sessionFile = ctx.sessionManager.getSessionFile();
  writeLock(basePath, unitType, unitId, completedUnits.length, sessionFile);

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

  // Switch model if preferences specify one for this unit type
  // Try primary model, then fallbacks in order if setting fails
  const modelConfig = resolveModelWithFallbacksForUnit(unitType);
  if (modelConfig) {
    const availableModels = ctx.modelRegistry.getAvailable();
    const modelsToTry = [modelConfig.primary, ...modelConfig.fallbacks];
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
        const fallbackNote = modelId === modelConfig.primary
          ? ""
          : ` (fallback from ${modelConfig.primary})`;
        const phase = unitPhaseLabel(unitType);
        ctx.ui.notify(`Model [${phase}]: ${model.provider}/${model.id}${fallbackNote}`, "info");
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
      snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId);
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
      snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId);
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
