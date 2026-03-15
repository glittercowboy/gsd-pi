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
import type { GSDState } from "./types.js";
import { loadFile, parseContinue, parsePlan, parseRoadmap, parseSummary, extractUatType, inlinePriorMilestoneSummary, getManifestStatus, clearParseCache } from "./files.js";
export { inlinePriorMilestoneSummary };
import type { UatType } from "./files.js";
import { collectSecretsFromManifest } from "../get-secrets-from-user.js";
import { loadPrompt, inlineTemplate } from "./prompt-loader.js";
import {
  gsdRoot, resolveMilestoneFile, resolveSliceFile, resolveSlicePath,
  resolveMilestonePath, resolveDir, resolveTasksDir, resolveTaskFiles, resolveTaskFile,
  relMilestoneFile, relSliceFile, relTaskFile, relSlicePath, relMilestonePath,
  milestonesDir, resolveGsdRootFile, relGsdRootFile,
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
import { resolveAutoSupervisorConfig, resolveModelForUnit, resolveModelWithFallbacksForUnit, resolveSkillDiscoveryMode, loadEffectiveGSDPreferences } from "./preferences.js";
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
  formatHookStatus,
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
import { dirname, join } from "node:path";
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import {
  autoCommitCurrentBranch,
  captureIntegrationBranch,
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
import type { GitPreferences } from "./git-service.js";
import { truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import { makeUI, GLYPH, INDENT } from "../shared/ui.js";
import { showNextAction } from "../shared/next-action-ui.js";

// ─── Disk-backed completed-unit helpers ───────────────────────────────────────

/** Path to the persisted completed-unit keys file. */
function completedKeysPath(base: string): string {
  return join(base, ".gsd", "completed-units.json");
}

/** Write a completed unit key to disk (read-modify-write append to set). */
function persistCompletedKey(base: string, key: string): void {
  const file = completedKeysPath(base);
  let keys: string[] = [];
  try {
    if (existsSync(file)) {
      keys = JSON.parse(readFileSync(file, "utf-8"));
    }
  } catch { /* corrupt file — start fresh */ }
  if (!keys.includes(key)) {
    keys.push(key);
    writeFileSync(file, JSON.stringify(keys), "utf-8");
  }
}

/** Remove a stale completed unit key from disk. */
function removePersistedKey(base: string, key: string): void {
  const file = completedKeysPath(base);
  try {
    if (existsSync(file)) {
      let keys: string[] = JSON.parse(readFileSync(file, "utf-8"));
      keys = keys.filter(k => k !== key);
      writeFileSync(file, JSON.stringify(keys), "utf-8");
    }
  } catch { /* non-fatal */ }
}

/** Load all completed unit keys from disk into the in-memory set. */
function loadPersistedKeys(base: string, target: Set<string>): void {
  const file = completedKeysPath(base);
  try {
    if (existsSync(file)) {
      const keys: string[] = JSON.parse(readFileSync(file, "utf-8"));
      for (const k of keys) target.add(k);
    }
  } catch { /* non-fatal */ }
}

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

/**
 * Register a SIGTERM handler that clears the lock file and exits cleanly.
 * Captures the active base path at registration time so the handler
 * always references the correct path even if the module variable changes.
 * Removes any previously registered handler before installing the new one.
 */
function registerSigtermHandler(currentBasePath: string): void {
  if (_sigtermHandler) process.off("SIGTERM", _sigtermHandler);
  _sigtermHandler = () => {
    clearLock(currentBasePath);
    process.exit(0);
  };
  process.on("SIGTERM", _sigtermHandler);
}

/** Deregister the SIGTERM handler (called on stop/pause). */
function deregisterSigtermHandler(): void {
  if (_sigtermHandler) {
    process.off("SIGTERM", _sigtermHandler);
    _sigtermHandler = null;
  }
}

/** Format token counts for compact display */
function formatWidgetTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/**
 * Footer factory that renders zero lines — hides the built-in footer entirely.
 * All footer info (pwd, branch, tokens, cost, model) is shown inside the
 * progress widget instead, so there's no gap or redundancy.
 */
const hideFooter = () => ({
  render(_width: number): string[] { return []; },
  invalidate() {},
  dispose() {},
});

/** Dashboard data for the overlay */
export interface AutoDashboardData {
  active: boolean;
  paused: boolean;
  stepMode: boolean;
  startTime: number;
  elapsed: number;
  currentUnit: { type: string; id: string; startedAt: number } | null;
  completedUnits: { type: string; id: string; startedAt: number; finishedAt: number }[];
  basePath: string;
  /** Running cost and token totals from metrics ledger */
  totalCost: number;
  totalTokens: number;
}

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
    ctx.ui.notify(
      "Dispatch gap detected — no unit dispatched after previous unit completed. Re-evaluating state.",
      "warning",
    );

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
  unitLifetimeDispatches.clear();
  currentUnit = null;
  currentMilestoneId = null;
  originalBasePath = "";
  cachedSliceProgress = null;
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

/**
 * Self-heal: scan runtime records in .gsd/ and clear any where the expected
 * artifact already exists on disk. This repairs incomplete closeouts from
 * prior crashes — preventing spurious re-dispatch of already-completed units.
 */
async function selfHealRuntimeRecords(base: string, ctx: ExtensionContext): Promise<void> {
  try {
    const { listUnitRuntimeRecords } = await import("./unit-runtime.js");
    const records = listUnitRuntimeRecords(base);
    let healed = 0;
    for (const record of records) {
      const { unitType, unitId } = record;
      const artifactPath = resolveExpectedArtifactPath(unitType, unitId, base);
      if (artifactPath && existsSync(artifactPath)) {
        // Artifact exists — unit completed but closeout didn't finish.
        clearUnitRuntimeRecord(base, unitType, unitId);
        healed++;
      }
    }
    if (healed > 0) {
      ctx.ui.notify(`Self-heal: cleared ${healed} stale runtime record(s) with completed artifacts.`, "info");
    }
  } catch {
    // Non-fatal — self-heal should never block auto-mode start
  }
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
    if (currentMilestoneId && originalBasePath && !isInAutoWorktree(basePath)) {
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
    await selfHealRuntimeRecords(base, ctx);
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
  originalBasePath = base;
  if (currentMilestoneId) {
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
  await selfHealRuntimeRecords(base, ctx);

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
  const nextDesc = describeNextUnit(state);

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

/**
 * Describe what the next unit will be, based on current state.
 */
export function describeNextUnit(state: GSDState): { label: string; description: string } {
  const sid = state.activeSlice?.id;
  const sTitle = state.activeSlice?.title;
  const tid = state.activeTask?.id;
  const tTitle = state.activeTask?.title;

  switch (state.phase) {
    case "needs-discussion":
      return { label: "Discuss milestone draft", description: "Milestone has a draft context — needs discussion before planning." };
    case "pre-planning":
      return { label: "Research & plan milestone", description: "Scout the landscape and create the roadmap." };
    case "planning":
      return { label: `Plan ${sid}: ${sTitle}`, description: "Research and decompose into tasks." };
    case "executing":
      return { label: `Execute ${tid}: ${tTitle}`, description: "Run the next task in a fresh session." };
    case "summarizing":
      return { label: `Complete ${sid}: ${sTitle}`, description: "Write summary, UAT, and merge to main." };
    case "replanning-slice":
      return { label: `Replan ${sid}: ${sTitle}`, description: "Blocker found — replan the slice." };
    case "completing-milestone":
      return { label: "Complete milestone", description: "Write milestone summary." };
    default:
      return { label: "Continue", description: "Execute the next step." };
  }
}

// ─── Progress Widget ──────────────────────────────────────────────────────

function unitVerb(unitType: string): string {
  if (unitType.startsWith("hook/")) return `hook: ${unitType.slice(5)}`;
  switch (unitType) {
    case "research-milestone":
    case "research-slice": return "researching";
    case "plan-milestone":
    case "plan-slice": return "planning";
    case "execute-task": return "executing";
    case "complete-slice": return "completing";
    case "replan-slice": return "replanning";
    case "reassess-roadmap": return "reassessing";
    case "run-uat": return "running UAT";
    default: return unitType;
  }
}

function unitPhaseLabel(unitType: string): string {
  if (unitType.startsWith("hook/")) return "HOOK";
  switch (unitType) {
    case "research-milestone": return "RESEARCH";
    case "research-slice": return "RESEARCH";
    case "plan-milestone": return "PLAN";
    case "plan-slice": return "PLAN";
    case "execute-task": return "EXECUTE";
    case "complete-slice": return "COMPLETE";
    case "replan-slice": return "REPLAN";
    case "reassess-roadmap": return "REASSESS";
    case "run-uat": return "UAT";
    default: return unitType.toUpperCase();
  }
}

function peekNext(unitType: string, state: GSDState): string {
  // Show active hook info in progress display
  const activeHookState = getActiveHook();
  if (activeHookState) {
    return `hook: ${activeHookState.hookName} (cycle ${activeHookState.cycle})`;
  }

  const sid = state.activeSlice?.id ?? "";
  if (unitType.startsWith("hook/")) return `continue ${sid}`;
  switch (unitType) {
    case "research-milestone": return "plan milestone roadmap";
    case "plan-milestone": return "plan or execute first slice";
    case "research-slice": return `plan ${sid}`;
    case "plan-slice": return "execute first task";
    case "execute-task": return `continue ${sid}`;
    case "complete-slice": return "reassess roadmap";
    case "replan-slice": return `re-execute ${sid}`;
    case "reassess-roadmap": return "advance to next slice";
    case "run-uat": return "reassess roadmap";
    default: return "";
  }
}



/** Right-align helper: build a line with left content and right content. */
function rightAlign(left: string, right: string, width: number): string {
  const leftVis = visibleWidth(left);
  const rightVis = visibleWidth(right);
  const gap = Math.max(1, width - leftVis - rightVis);
  return truncateToWidth(left + " ".repeat(gap) + right, width);
}

function updateProgressWidget(
  ctx: ExtensionContext,
  unitType: string,
  unitId: string,
  state: GSDState,
): void {
  if (!ctx.hasUI) return;

  const verb = unitVerb(unitType);
  const phaseLabel = unitPhaseLabel(unitType);
  const mid = state.activeMilestone;
  const slice = state.activeSlice;
  const task = state.activeTask;
  const next = peekNext(unitType, state);

  // Cache git branch at widget creation time (not per render)
  let cachedBranch: string | null = null;
  try { cachedBranch = getCurrentBranch(basePath); } catch { /* not in git repo */ }

  // Cache pwd with ~ substitution
  let widgetPwd = process.cwd();
  const widgetHome = process.env.HOME || process.env.USERPROFILE;
  if (widgetHome && widgetPwd.startsWith(widgetHome)) {
    widgetPwd = `~${widgetPwd.slice(widgetHome.length)}`;
  }
  if (cachedBranch) widgetPwd = `${widgetPwd} (${cachedBranch})`;

  ctx.ui.setWidget("gsd-progress", (tui, theme) => {
    let pulseBright = true;
    let cachedLines: string[] | undefined;
    let cachedWidth: number | undefined;

    const pulseTimer = setInterval(() => {
      pulseBright = !pulseBright;
      cachedLines = undefined;
      tui.requestRender();
    }, 800);

    return {
      render(width: number): string[] {
        if (cachedLines && cachedWidth === width) return cachedLines;

        const ui = makeUI(theme, width);
        const lines: string[] = [];
        const pad = INDENT.base;

        // ── Line 1: Top bar ───────────────────────────────────────────────
        lines.push(...ui.bar());

        const dot = pulseBright
          ? theme.fg("accent", GLYPH.statusActive)
          : theme.fg("dim", GLYPH.statusPending);
        const elapsed = formatAutoElapsed();
        const modeTag = stepMode ? "NEXT" : "AUTO";
        const headerLeft = `${pad}${dot} ${theme.fg("accent", theme.bold("GSD"))}  ${theme.fg("success", modeTag)}`;
        const headerRight = elapsed ? theme.fg("dim", elapsed) : "";
        lines.push(rightAlign(headerLeft, headerRight, width));

        lines.push("");

        if (mid) {
          lines.push(truncateToWidth(`${pad}${theme.fg("dim", mid.title)}`, width));
        }

        if (slice && unitType !== "research-milestone" && unitType !== "plan-milestone") {
          lines.push(truncateToWidth(
            `${pad}${theme.fg("text", theme.bold(`${slice.id}: ${slice.title}`))}`,
            width,
          ));
        }

        lines.push("");

        const target = task ? `${task.id}: ${task.title}` : unitId;
        const actionLeft = `${pad}${theme.fg("accent", "▸")} ${theme.fg("accent", verb)}  ${theme.fg("text", target)}`;
        const phaseBadge = theme.fg("dim", phaseLabel);
        lines.push(rightAlign(actionLeft, phaseBadge, width));
        lines.push("");

        if (mid) {
          const roadmapSlices = getRoadmapSlicesSync();
          if (roadmapSlices) {
            const { done, total, activeSliceTasks } = roadmapSlices;
            const barWidth = Math.max(8, Math.min(24, Math.floor(width * 0.3)));
            const pct = total > 0 ? done / total : 0;
            const filled = Math.round(pct * barWidth);
            const bar = theme.fg("success", "█".repeat(filled))
              + theme.fg("dim", "░".repeat(barWidth - filled));

            let meta = theme.fg("dim", `${done}/${total} slices`);

            if (activeSliceTasks && activeSliceTasks.total > 0) {
              meta += theme.fg("dim", `  ·  task ${activeSliceTasks.done + 1}/${activeSliceTasks.total}`);
            }

            lines.push(truncateToWidth(`${pad}${bar}  ${meta}`, width));
          }
        }

        lines.push("");

        if (next) {
          lines.push(truncateToWidth(
            `${pad}${theme.fg("dim", "→")} ${theme.fg("dim", `then ${next}`)}`,
            width,
          ));
        }

        // ── Footer info (pwd, tokens, cost, context, model) ──────────────
        lines.push("");
        lines.push(truncateToWidth(theme.fg("dim", `${pad}${widgetPwd}`), width, theme.fg("dim", "…")));

        // Token stats from current unit session + cumulative cost from metrics
        {
          let totalInput = 0, totalOutput = 0;
          let totalCacheRead = 0, totalCacheWrite = 0;
          if (cmdCtx) {
            for (const entry of cmdCtx.sessionManager.getEntries()) {
              if (entry.type === "message" && (entry as any).message?.role === "assistant") {
                const u = (entry as any).message.usage;
                if (u) {
                  totalInput += u.input || 0;
                  totalOutput += u.output || 0;
                  totalCacheRead += u.cacheRead || 0;
                  totalCacheWrite += u.cacheWrite || 0;
                }
              }
            }
          }
          const mLedger = getLedger();
          const autoTotals = mLedger ? getProjectTotals(mLedger.units) : null;
          const cumulativeCost = autoTotals?.cost ?? 0;

          const cxUsage = cmdCtx?.getContextUsage?.();
          const cxWindow = cxUsage?.contextWindow ?? cmdCtx?.model?.contextWindow ?? 0;
          const cxPctVal = cxUsage?.percent ?? 0;
          const cxPct = cxUsage?.percent !== null ? cxPctVal.toFixed(1) : "?";

          const sp: string[] = [];
          if (totalInput) sp.push(`↑${formatWidgetTokens(totalInput)}`);
          if (totalOutput) sp.push(`↓${formatWidgetTokens(totalOutput)}`);
          if (totalCacheRead) sp.push(`R${formatWidgetTokens(totalCacheRead)}`);
          if (totalCacheWrite) sp.push(`W${formatWidgetTokens(totalCacheWrite)}`);
          if (cumulativeCost) sp.push(`$${cumulativeCost.toFixed(3)}`);

          const cxDisplay = cxPct === "?"
            ? `?/${formatWidgetTokens(cxWindow)}`
            : `${cxPct}%/${formatWidgetTokens(cxWindow)}`;
          if (cxPctVal > 90) {
            sp.push(theme.fg("error", cxDisplay));
          } else if (cxPctVal > 70) {
            sp.push(theme.fg("warning", cxDisplay));
          } else {
            sp.push(cxDisplay);
          }

          const sLeft = sp.map(p => p.includes("\x1b[") ? p : theme.fg("dim", p))
            .join(theme.fg("dim", " "));

          const modelId = cmdCtx?.model?.id ?? "";
          const modelProvider = cmdCtx?.model?.provider ?? "";
          const modelPhase = phaseLabel ? theme.fg("dim", `[${phaseLabel}] `) : "";
          const modelDisplay = modelProvider && modelId
            ? `${modelProvider}/${modelId}`
            : modelId;
          const sRight = modelDisplay
            ? `${modelPhase}${theme.fg("dim", modelDisplay)}`
            : "";
          lines.push(rightAlign(`${pad}${sLeft}`, sRight, width));
        }

        const hintParts: string[] = [];
        hintParts.push("esc pause");
        hintParts.push(process.platform === "darwin" ? "⌃⌥G dashboard" : "Ctrl+Alt+G dashboard");
        lines.push(...ui.hints(hintParts));

        lines.push(...ui.bar());

        cachedLines = lines;
        cachedWidth = width;
        return lines;
      },
      invalidate() {
        cachedLines = undefined;
        cachedWidth = undefined;
      },
      dispose() {
        clearInterval(pulseTimer);
      },
    };
  });
}

/** Format elapsed time since auto-mode started */
function formatAutoElapsed(): string {
  if (!autoStartTime) return "";
  const ms = Date.now() - autoStartTime;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs > 0 ? ` ${rs}s` : ""}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

/** Cached slice progress for the widget — avoid async in render */
let cachedSliceProgress: {
  done: number;
  total: number;
  milestoneId: string;
  /** Real task progress for the active slice, if its plan file exists */
  activeSliceTasks: { done: number; total: number } | null;
} | null = null;

function updateSliceProgressCache(base: string, mid: string, activeSid?: string): void {
  try {
    const roadmapFile = resolveMilestoneFile(base, mid, "ROADMAP");
    if (!roadmapFile) return;
    const content = readFileSync(roadmapFile, "utf-8");
    const roadmap = parseRoadmap(content);

    let activeSliceTasks: { done: number; total: number } | null = null;
    if (activeSid) {
      try {
        const planFile = resolveSliceFile(base, mid, activeSid, "PLAN");
        if (planFile && existsSync(planFile)) {
          const planContent = readFileSync(planFile, "utf-8");
          const plan = parsePlan(planContent);
          activeSliceTasks = {
            done: plan.tasks.filter(t => t.done).length,
            total: plan.tasks.length,
          };
        }
      } catch {
        // Non-fatal — just omit task count
      }
    }

    cachedSliceProgress = {
      done: roadmap.slices.filter(s => s.done).length,
      total: roadmap.slices.length,
      milestoneId: mid,
      activeSliceTasks,
    };
  } catch {
    // Non-fatal — widget just won't show progress bar
  }
}

function getRoadmapSlicesSync(): { done: number; total: number; activeSliceTasks: { done: number; total: number } | null } | null {
  return cachedSliceProgress;
}

// ─── Core Loop ────────────────────────────────────────────────────────────────

async function dispatchNextUnit(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> {
  if (!active || !cmdCtx) {
    if (active && !cmdCtx) {
      ctx.ui.notify("Auto-mode dispatch failed: no command context. Run /gsd auto to restart.", "error");
    }
    return;
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
  // If MERGE_HEAD or SQUASH_MSG exists, check whether conflicts are resolved.
  // If resolved: finalize the commit. If still conflicted: abort and reset.
  {
    const mergeHeadPath = join(basePath, ".git", "MERGE_HEAD");
    const squashMsgPath = join(basePath, ".git", "SQUASH_MSG");
    const hasMergeHead = existsSync(mergeHeadPath);
    const hasSquashMsg = existsSync(squashMsgPath);
    if (hasMergeHead || hasSquashMsg) {
      const unmerged = runGit(basePath, ["diff", "--name-only", "--diff-filter=U"], { allowFailure: true });
      if (!unmerged || !unmerged.trim()) {
        // All conflicts resolved — finalize the merge/squash commit
        try {
          runGit(basePath, ["commit", "--no-edit"], { allowFailure: false });
          const mode = hasMergeHead ? "merge" : "squash commit";
          ctx.ui.notify(`Finalized leftover ${mode} from prior session.`, "info");
        } catch {
          // Commit may already exist; non-fatal
        }
      } else {
        // Still conflicted — abort and reset
        if (hasMergeHead) {
          runGit(basePath, ["merge", "--abort"], { allowFailure: true });
        } else if (hasSquashMsg) {
          try { unlinkSync(squashMsgPath); } catch { /* best-effort */ }
        }
        runGit(basePath, ["reset", "--hard", "HEAD"], { allowFailure: true });
        ctx.ui.notify(
          "Detected leftover merge state with unresolved conflicts — cleaned up. Re-deriving state.",
          "warning",
        );
      }
      invalidateStateCache();
      clearParseCache();
      clearPathCache();
      state = await deriveState(basePath);
      mid = state.activeMilestone?.id;
      midTitle = state.activeMilestone?.title;
    }
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
    ctx.ui.notify(`Blocked: ${state.blockers.join(", ")}. Fix and run /gsd auto.`, "warning");
    return;
  }

  // ── UAT Dispatch: run-uat fires after complete-slice merge, before reassessment ──
  // Ensures the UAT file and slice summary are both on main when UAT runs.
  const prefs = loadEffectiveGSDPreferences()?.preferences;

  // Budget ceiling guard — pause before starting next unit if ceiling is hit
  const budgetCeiling = prefs?.budget_ceiling;
  if (budgetCeiling !== undefined) {
    const currentLedger = getLedger();
    const totalCost = currentLedger ? getProjectTotals(currentLedger.units).cost : 0;
    if (totalCost >= budgetCeiling) {
      ctx.ui.notify(
        `Budget ceiling ${formatCost(budgetCeiling)} reached (spent ${formatCost(totalCost)}). Pausing auto-mode — /gsd auto to continue.`,
        "warning",
      );
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
      ctx.ui.notify(`Unexpected phase: ${state.phase}. Stopping auto-mode.`, "warning");
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
      // Yield to the event loop before re-dispatching to avoid tight recursion
      // when many units are already completed (e.g., after crash recovery).
      await new Promise(r => setImmediate(r));
      await dispatchNextUnit(ctx, pi);
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

    const expected = diagnoseExpectedArtifact(unitType, unitId, basePath);
    const remediation = buildLoopRemediationSteps(unitType, unitId, basePath);
    await stopAuto(ctx, pi);
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
    ctx.ui.notify("New session cancelled — auto-mode stopped.", "warning");
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
        ctx.ui.notify(`Model ${modelId} not found in available models, trying fallback.`, "warning");
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
          ctx.ui.notify(
            `Failed to set model ${modelId}, trying fallback ${nextModel}...`,
            "warning",
          );
        } else {
          ctx.ui.notify(
            `Failed to set model ${modelId} and all fallbacks exhausted. Using default model.`,
            "warning",
          );
        }
      }
    }

    if (!modelSet) {
      ctx.ui.notify(
        `Could not set any preferred model for ${unitType}. Continuing with default.`,
        "warning",
      );
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
}

// ─── Skill Discovery ──────────────────────────────────────────────────────────

/**
 * Build the skill discovery template variables for research prompts.
 * Returns { skillDiscoveryMode, skillDiscoveryInstructions } for template substitution.
 */
function buildSkillDiscoveryVars(): { skillDiscoveryMode: string; skillDiscoveryInstructions: string } {
  const mode = resolveSkillDiscoveryMode();

  if (mode === "off") {
    return {
      skillDiscoveryMode: "off",
      skillDiscoveryInstructions: " Skill discovery is disabled. Skip this step.",
    };
  }

  const autoInstall = mode === "auto";
  const instructions = `
   Identify the key technologies, frameworks, and services this work depends on (e.g. Stripe, Clerk, Supabase, JUCE, SwiftUI).
   For each, check if a professional agent skill already exists:
   - First check \`<available_skills>\` in your system prompt — a skill may already be installed.
   - For technologies without an installed skill, run: \`npx skills find "<technology>"\`
   - Only consider skills that are **directly relevant** to core technologies — not tangentially related.
   - Evaluate results by install count and relevance to the actual work.${autoInstall
    ? `
   - Install relevant skills: \`npx skills add <owner/repo@skill> -g -y\`
   - Record installed skills in the "Skills Discovered" section of your research output.
   - Installed skills will automatically appear in subsequent units' system prompts — no manual steps needed.`
    : `
   - Note promising skills in your research output with their install commands, but do NOT install them.
   - The user will decide which to install.`
  }`;

  return {
    skillDiscoveryMode: mode,
    skillDiscoveryInstructions: instructions,
  };
}

// ─── Inline Helpers ───────────────────────────────────────────────────────────

/**
 * Load a file and format it for inlining into a prompt.
 * Returns the content wrapped with a source path header, or a fallback
 * message if the file doesn't exist. This eliminates tool calls — the LLM
 * gets the content directly instead of "Read this file:".
 */
async function inlineFile(
  absPath: string | null, relPath: string, label: string,
): Promise<string> {
  const content = absPath ? await loadFile(absPath) : null;
  if (!content) {
    return `### ${label}\nSource: \`${relPath}\`\n\n_(not found — file does not exist yet)_`;
  }
  return `### ${label}\nSource: \`${relPath}\`\n\n${content.trim()}`;
}

/**
 * Load a file for inlining, returning null if it doesn't exist.
 * Use when the file is optional and should be omitted entirely if absent.
 */
async function inlineFileOptional(
  absPath: string | null, relPath: string, label: string,
): Promise<string | null> {
  const content = absPath ? await loadFile(absPath) : null;
  if (!content) return null;
  return `### ${label}\nSource: \`${relPath}\`\n\n${content.trim()}`;
}

/**
 * Load and inline dependency slice summaries (full content, not just paths).
 */
async function inlineDependencySummaries(
  mid: string, sid: string, base: string,
): Promise<string> {
  const roadmapFile = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
  if (!roadmapContent) return "- (no dependencies)";

  const roadmap = parseRoadmap(roadmapContent);
  const sliceEntry = roadmap.slices.find(s => s.id === sid);
  if (!sliceEntry || sliceEntry.depends.length === 0) return "- (no dependencies)";

  const sections: string[] = [];
  const seen = new Set<string>();
  for (const dep of sliceEntry.depends) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    const summaryFile = resolveSliceFile(base, mid, dep, "SUMMARY");
    const summaryContent = summaryFile ? await loadFile(summaryFile) : null;
    const relPath = relSliceFile(base, mid, dep, "SUMMARY");
    if (summaryContent) {
      sections.push(`#### ${dep} Summary\nSource: \`${relPath}\`\n\n${summaryContent.trim()}`);
    } else {
      sections.push(`- \`${relPath}\` _(not found)_`);
    }
  }
  return sections.join("\n\n");
}

/**
 * Load a well-known .gsd/ root file for optional inlining.
 * Handles the existsSync check internally.
 */
async function inlineGsdRootFile(
  base: string, filename: string, label: string,
): Promise<string | null> {
  const key = filename.replace(/\.md$/i, "").toUpperCase() as "PROJECT" | "DECISIONS" | "QUEUE" | "STATE" | "REQUIREMENTS";
  const absPath = resolveGsdRootFile(base, key);
  if (!existsSync(absPath)) return null;
  return inlineFileOptional(absPath, relGsdRootFile(key), label);
}

// ─── Prompt Builders ──────────────────────────────────────────────────────────

async function buildResearchMilestonePrompt(mid: string, midTitle: string, base: string): Promise<string> {
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");

  const inlined: string[] = [];
  inlined.push(await inlineFile(contextPath, contextRel, "Milestone Context"));
  const projectInline = await inlineGsdRootFile(base, "project.md", "Project");
  if (projectInline) inlined.push(projectInline);
  const requirementsInline = await inlineGsdRootFile(base, "requirements.md", "Requirements");
  if (requirementsInline) inlined.push(requirementsInline);
  const decisionsInline = await inlineGsdRootFile(base, "decisions.md", "Decisions");
  if (decisionsInline) inlined.push(decisionsInline);
  inlined.push(inlineTemplate("research", "Research"));

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const outputRelPath = relMilestoneFile(base, mid, "RESEARCH");
  return loadPrompt("research-milestone", {
    milestoneId: mid, milestoneTitle: midTitle,
    milestonePath: relMilestonePath(base, mid),
    contextPath: contextRel,
    outputPath: outputRelPath,
    inlinedContext,
    ...buildSkillDiscoveryVars(),
  });
}

async function buildPlanMilestonePrompt(mid: string, midTitle: string, base: string): Promise<string> {
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");
  const researchPath = resolveMilestoneFile(base, mid, "RESEARCH");
  const researchRel = relMilestoneFile(base, mid, "RESEARCH");

  const inlined: string[] = [];
  inlined.push(await inlineFile(contextPath, contextRel, "Milestone Context"));
  const researchInline = await inlineFileOptional(researchPath, researchRel, "Milestone Research");
  if (researchInline) inlined.push(researchInline);
  const priorSummaryInline = await inlinePriorMilestoneSummary(mid, base);
  if (priorSummaryInline) inlined.push(priorSummaryInline);
  const projectInline = await inlineGsdRootFile(base, "project.md", "Project");
  if (projectInline) inlined.push(projectInline);
  const requirementsInline = await inlineGsdRootFile(base, "requirements.md", "Requirements");
  if (requirementsInline) inlined.push(requirementsInline);
  const decisionsInline = await inlineGsdRootFile(base, "decisions.md", "Decisions");
  if (decisionsInline) inlined.push(decisionsInline);
  inlined.push(inlineTemplate("roadmap", "Roadmap"));
  inlined.push(inlineTemplate("decisions", "Decisions"));
  inlined.push(inlineTemplate("plan", "Slice Plan"));
  inlined.push(inlineTemplate("task-plan", "Task Plan"));
  inlined.push(inlineTemplate("secrets-manifest", "Secrets Manifest"));

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const outputRelPath = relMilestoneFile(base, mid, "ROADMAP");
  const secretsOutputPath = relMilestoneFile(base, mid, "SECRETS");
  return loadPrompt("plan-milestone", {
    milestoneId: mid, milestoneTitle: midTitle,
    milestonePath: relMilestonePath(base, mid),
    contextPath: contextRel,
    researchPath: researchRel,
    outputPath: outputRelPath,
    secretsOutputPath,
    inlinedContext,
  });
}

async function buildResearchSlicePrompt(
  mid: string, _midTitle: string, sid: string, sTitle: string, base: string,
): Promise<string> {
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");
  const milestoneResearchPath = resolveMilestoneFile(base, mid, "RESEARCH");
  const milestoneResearchRel = relMilestoneFile(base, mid, "RESEARCH");

  const inlined: string[] = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));
  const contextInline = await inlineFileOptional(contextPath, contextRel, "Milestone Context");
  if (contextInline) inlined.push(contextInline);
  const researchInline = await inlineFileOptional(milestoneResearchPath, milestoneResearchRel, "Milestone Research");
  if (researchInline) inlined.push(researchInline);
  const decisionsInline = await inlineGsdRootFile(base, "decisions.md", "Decisions");
  if (decisionsInline) inlined.push(decisionsInline);
  const requirementsInline = await inlineGsdRootFile(base, "requirements.md", "Requirements");
  if (requirementsInline) inlined.push(requirementsInline);
  inlined.push(inlineTemplate("research", "Research"));

  const depContent = await inlineDependencySummaries(mid, sid, base);

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const outputRelPath = relSliceFile(base, mid, sid, "RESEARCH");
  return loadPrompt("research-slice", {
    milestoneId: mid, sliceId: sid, sliceTitle: sTitle,
    slicePath: relSlicePath(base, mid, sid),
    roadmapPath: roadmapRel,
    contextPath: contextRel,
    milestoneResearchPath: milestoneResearchRel,
    outputPath: outputRelPath,
    inlinedContext,
    dependencySummaries: depContent,
    ...buildSkillDiscoveryVars(),
  });
}

async function buildPlanSlicePrompt(
  mid: string, _midTitle: string, sid: string, sTitle: string, base: string,
): Promise<string> {
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const researchPath = resolveSliceFile(base, mid, sid, "RESEARCH");
  const researchRel = relSliceFile(base, mid, sid, "RESEARCH");

  const inlined: string[] = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));
  const researchInline = await inlineFileOptional(researchPath, researchRel, "Slice Research");
  if (researchInline) inlined.push(researchInline);
  const decisionsInline = await inlineGsdRootFile(base, "decisions.md", "Decisions");
  if (decisionsInline) inlined.push(decisionsInline);
  const requirementsInline = await inlineGsdRootFile(base, "requirements.md", "Requirements");
  if (requirementsInline) inlined.push(requirementsInline);
  inlined.push(inlineTemplate("plan", "Slice Plan"));
  inlined.push(inlineTemplate("task-plan", "Task Plan"));

  const depContent = await inlineDependencySummaries(mid, sid, base);

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const outputRelPath = relSliceFile(base, mid, sid, "PLAN");
  return loadPrompt("plan-slice", {
    milestoneId: mid, sliceId: sid, sliceTitle: sTitle,
    slicePath: relSlicePath(base, mid, sid),
    roadmapPath: roadmapRel,
    researchPath: researchRel,
    outputPath: outputRelPath,
    inlinedContext,
    dependencySummaries: depContent,
  });
}

async function buildExecuteTaskPrompt(
  mid: string, sid: string, sTitle: string,
  tid: string, tTitle: string, base: string,
): Promise<string> {

  const priorSummaries = await getPriorTaskSummaryPaths(mid, sid, tid, base);
  const priorLines = priorSummaries.length > 0
    ? priorSummaries.map(p => `- \`${p}\``).join("\n")
    : "- (no prior tasks)";

  const taskPlanPath = resolveTaskFile(base, mid, sid, tid, "PLAN");
  const taskPlanContent = taskPlanPath ? await loadFile(taskPlanPath) : null;
  const taskPlanRelPath = relTaskFile(base, mid, sid, tid, "PLAN");
  const taskPlanInline = taskPlanContent
    ? [
      "## Inlined Task Plan (authoritative local execution contract)",
      `Source: \`${taskPlanRelPath}\``,
      "",
      taskPlanContent.trim(),
    ].join("\n")
    : [
      "## Inlined Task Plan (authoritative local execution contract)",
      `Task plan not found at dispatch time. Read \`${taskPlanRelPath}\` before executing.`,
    ].join("\n");

  const slicePlanPath = resolveSliceFile(base, mid, sid, "PLAN");
  const slicePlanContent = slicePlanPath ? await loadFile(slicePlanPath) : null;
  const slicePlanExcerpt = extractSliceExecutionExcerpt(slicePlanContent, relSliceFile(base, mid, sid, "PLAN"));

  // Check for continue file (new naming or legacy)
  const continueFile = resolveSliceFile(base, mid, sid, "CONTINUE");
  const legacyContinueDir = resolveSlicePath(base, mid, sid);
  const legacyContinuePath = legacyContinueDir ? join(legacyContinueDir, "continue.md") : null;
  const continueContent = continueFile ? await loadFile(continueFile) : null;
  const legacyContinueContent = !continueContent && legacyContinuePath ? await loadFile(legacyContinuePath) : null;
  const continueRelPath = relSliceFile(base, mid, sid, "CONTINUE");
  const resumeSection = buildResumeSection(
    continueContent,
    legacyContinueContent,
    continueRelPath,
    legacyContinuePath ? `${relSlicePath(base, mid, sid)}/continue.md` : null,
  );

  const carryForwardSection = await buildCarryForwardSection(priorSummaries, base);
  const inlinedTemplates = [
    inlineTemplate("task-summary", "Task Summary"),
    inlineTemplate("decisions", "Decisions"),
  ].join("\n\n---\n\n");

  const taskSummaryPath = `${relSlicePath(base, mid, sid)}/tasks/${tid}-SUMMARY.md`;

  return loadPrompt("execute-task", {
    milestoneId: mid, sliceId: sid, sliceTitle: sTitle, taskId: tid, taskTitle: tTitle,
    planPath: relSliceFile(base, mid, sid, "PLAN"),
    slicePath: relSlicePath(base, mid, sid),
    taskPlanPath: taskPlanRelPath,
    taskPlanInline,
    slicePlanExcerpt,
    carryForwardSection,
    resumeSection,
    priorTaskLines: priorLines,
    taskSummaryPath,
    inlinedTemplates,
  });
}

async function buildCompleteSlicePrompt(
  mid: string, _midTitle: string, sid: string, sTitle: string, base: string,
): Promise<string> {

  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const slicePlanPath = resolveSliceFile(base, mid, sid, "PLAN");
  const slicePlanRel = relSliceFile(base, mid, sid, "PLAN");

  const inlined: string[] = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));
  inlined.push(await inlineFile(slicePlanPath, slicePlanRel, "Slice Plan"));
  const requirementsInline = await inlineGsdRootFile(base, "requirements.md", "Requirements");
  if (requirementsInline) inlined.push(requirementsInline);

  // Inline all task summaries for this slice
  const tDir = resolveTasksDir(base, mid, sid);
  if (tDir) {
    const summaryFiles = resolveTaskFiles(tDir, "SUMMARY").sort();
    for (const file of summaryFiles) {
      const absPath = join(tDir, file);
      const content = await loadFile(absPath);
      const sRel = relSlicePath(base, mid, sid);
      const relPath = `${sRel}/tasks/${file}`;
      if (content) {
        inlined.push(`### Task Summary: ${file.replace(/-SUMMARY\.md$/i, "")}\nSource: \`${relPath}\`\n\n${content.trim()}`);
      }
    }
  }
  inlined.push(inlineTemplate("slice-summary", "Slice Summary"));
  inlined.push(inlineTemplate("uat", "UAT"));

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const sliceRel = relSlicePath(base, mid, sid);
  const sliceSummaryPath = `${sliceRel}/${sid}-SUMMARY.md`;
  const sliceUatPath = `${sliceRel}/${sid}-UAT.md`;

  return loadPrompt("complete-slice", {
    milestoneId: mid, sliceId: sid, sliceTitle: sTitle,
    slicePath: sliceRel,
    roadmapPath: roadmapRel,
    inlinedContext,
    sliceSummaryPath,
    sliceUatPath,
  });
}

async function buildCompleteMilestonePrompt(
  mid: string, midTitle: string, base: string,
): Promise<string> {
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");

  const inlined: string[] = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));

  // Inline all slice summaries (deduplicated by slice ID)
  const roadmapContent = roadmapPath ? await loadFile(roadmapPath) : null;
  if (roadmapContent) {
    const roadmap = parseRoadmap(roadmapContent);
    const seenSlices = new Set<string>();
    for (const slice of roadmap.slices) {
      if (seenSlices.has(slice.id)) continue;
      seenSlices.add(slice.id);
      const summaryPath = resolveSliceFile(base, mid, slice.id, "SUMMARY");
      const summaryRel = relSliceFile(base, mid, slice.id, "SUMMARY");
      inlined.push(await inlineFile(summaryPath, summaryRel, `${slice.id} Summary`));
    }
  }

  // Inline root GSD files
  const requirementsInline = await inlineGsdRootFile(base, "requirements.md", "Requirements");
  if (requirementsInline) inlined.push(requirementsInline);
  const decisionsInline = await inlineGsdRootFile(base, "decisions.md", "Decisions");
  if (decisionsInline) inlined.push(decisionsInline);
  const projectInline = await inlineGsdRootFile(base, "project.md", "Project");
  if (projectInline) inlined.push(projectInline);
  // Inline milestone context file (milestone-level, not GSD root)
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");
  const contextInline = await inlineFileOptional(contextPath, contextRel, "Milestone Context");
  if (contextInline) inlined.push(contextInline);
  inlined.push(inlineTemplate("milestone-summary", "Milestone Summary"));

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const milestoneSummaryPath = `${relMilestonePath(base, mid)}/${mid}-SUMMARY.md`;

  return loadPrompt("complete-milestone", {
    milestoneId: mid,
    milestoneTitle: midTitle,
    roadmapPath: roadmapRel,
    inlinedContext,
    milestoneSummaryPath,
  });
}

// ─── Replan Slice Prompt ───────────────────────────────────────────────────────

async function buildReplanSlicePrompt(
  mid: string, midTitle: string, sid: string, sTitle: string, base: string,
): Promise<string> {
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const slicePlanPath = resolveSliceFile(base, mid, sid, "PLAN");
  const slicePlanRel = relSliceFile(base, mid, sid, "PLAN");

  const inlined: string[] = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));
  inlined.push(await inlineFile(slicePlanPath, slicePlanRel, "Current Slice Plan"));

  // Find the blocker task summary — the completed task with blocker_discovered: true
  let blockerTaskId = "";
  const tDir = resolveTasksDir(base, mid, sid);
  if (tDir) {
    const summaryFiles = resolveTaskFiles(tDir, "SUMMARY").sort();
    for (const file of summaryFiles) {
      const absPath = join(tDir, file);
      const content = await loadFile(absPath);
      if (!content) continue;
      const summary = parseSummary(content);
      const sRel = relSlicePath(base, mid, sid);
      const relPath = `${sRel}/tasks/${file}`;
      if (summary.frontmatter.blocker_discovered) {
        blockerTaskId = summary.frontmatter.id || file.replace(/-SUMMARY\.md$/i, "");
        inlined.push(`### Blocker Task Summary: ${blockerTaskId}\nSource: \`${relPath}\`\n\n${content.trim()}`);
      }
    }
  }

  // Inline decisions
  const decisionsInline = await inlineGsdRootFile(base, "decisions.md", "Decisions");
  if (decisionsInline) inlined.push(decisionsInline);

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const replanPath = `${relSlicePath(base, mid, sid)}/${sid}-REPLAN.md`;

  return loadPrompt("replan-slice", {
    milestoneId: mid,
    sliceId: sid,
    sliceTitle: sTitle,
    slicePath: relSlicePath(base, mid, sid),
    planPath: slicePlanRel,
    blockerTaskId,
    inlinedContext,
    replanPath,
  });
}

// ─── Adaptive Replanning ──────────────────────────────────────────────────────

/**
 * Check if the most recently completed slice needs reassessment.
 * Returns { sliceId } if reassessment is needed, null otherwise.
 *
 * Skips reassessment when:
 * - No roadmap exists yet
 * - No slices are completed
 * - The last completed slice already has an assessment file
 * - All slices are complete (milestone done — no point reassessing)
 */
async function checkNeedsReassessment(
  base: string, mid: string, state: GSDState,
): Promise<{ sliceId: string } | null> {
  const roadmapFile = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
  if (!roadmapContent) return null;

  const roadmap = parseRoadmap(roadmapContent);
  const completedSlices = roadmap.slices.filter(s => s.done);
  const incompleteSlices = roadmap.slices.filter(s => !s.done);

  // No completed slices or all slices done — skip
  if (completedSlices.length === 0 || incompleteSlices.length === 0) return null;

  // Check the last completed slice
  const lastCompleted = completedSlices[completedSlices.length - 1];
  const assessmentFile = resolveSliceFile(base, mid, lastCompleted.id, "ASSESSMENT");
  const hasAssessment = !!(assessmentFile && await loadFile(assessmentFile));

  if (hasAssessment) return null;

  // Also need a summary to reassess against
  const summaryFile = resolveSliceFile(base, mid, lastCompleted.id, "SUMMARY");
  const hasSummary = !!(summaryFile && await loadFile(summaryFile));

  if (!hasSummary) return null;

  return { sliceId: lastCompleted.id };
}

/**
 * Check if the most recently completed slice needs a UAT run.
 * Returns { sliceId, uatType } if UAT should be dispatched, null otherwise.
 *
 * Skips when:
 * - No roadmap or no completed slices
 * - All slices are done (milestone complete path — reassessment handles it)
 * - uat_dispatch preference is not enabled
 * - No UAT file exists for the slice
 * - UAT result file already exists (idempotent — already ran)
 */
async function checkNeedsRunUat(
  base: string, mid: string, state: GSDState, prefs: GSDPreferences | undefined,
): Promise<{ sliceId: string; uatType: UatType } | null> {
  const roadmapFile = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
  if (!roadmapContent) return null;

  const roadmap = parseRoadmap(roadmapContent);
  const completedSlices = roadmap.slices.filter(s => s.done);
  const incompleteSlices = roadmap.slices.filter(s => !s.done);

  // No completed slices — nothing to UAT yet
  if (completedSlices.length === 0) return null;

  // All slices done — milestone complete path, skip (reassessment handles)
  if (incompleteSlices.length === 0) return null;

  // uat_dispatch must be opted in
  if (!prefs?.uat_dispatch) return null;

  // Take the last completed slice
  const lastCompleted = completedSlices[completedSlices.length - 1];
  const sid = lastCompleted.id;

  // UAT file must exist
  const uatFile = resolveSliceFile(base, mid, sid, "UAT");
  if (!uatFile) return null;
  const uatContent = await loadFile(uatFile);
  if (!uatContent) return null;

  // If UAT result already exists, skip (idempotent)
  const uatResultFile = resolveSliceFile(base, mid, sid, "UAT-RESULT");
  if (uatResultFile) {
    const hasResult = !!(await loadFile(uatResultFile));
    if (hasResult) return null;
  }

  // Classify UAT type; unknown type → treat as human-experience (human review)
  const uatType = extractUatType(uatContent) ?? "human-experience";

  return { sliceId: sid, uatType };
}

async function buildRunUatPrompt(
  mid: string, sliceId: string, uatPath: string, uatContent: string, base: string,
): Promise<string> {
  const inlined: string[] = [];
  inlined.push(await inlineFile(resolveSliceFile(base, mid, sliceId, "UAT"), uatPath, `${sliceId} UAT`));

  const summaryPath = resolveSliceFile(base, mid, sliceId, "SUMMARY");
  const summaryRel = relSliceFile(base, mid, sliceId, "SUMMARY");
  if (summaryPath) {
    const summaryInline = await inlineFileOptional(summaryPath, summaryRel, `${sliceId} Summary`);
    if (summaryInline) inlined.push(summaryInline);
  }

  const projectInline = await inlineGsdRootFile(base, "project.md", "Project");
  if (projectInline) inlined.push(projectInline);

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const uatResultPath = relSliceFile(base, mid, sliceId, "UAT-RESULT");
  const uatType = extractUatType(uatContent) ?? "human-experience";

  return loadPrompt("run-uat", {
    milestoneId: mid,
    sliceId,
    uatPath,
    uatResultPath,
    uatType,
    inlinedContext,
  });
}

async function buildReassessRoadmapPrompt(
  mid: string, midTitle: string, completedSliceId: string, base: string,
): Promise<string> {
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const summaryPath = resolveSliceFile(base, mid, completedSliceId, "SUMMARY");
  const summaryRel = relSliceFile(base, mid, completedSliceId, "SUMMARY");

  const inlined: string[] = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Current Roadmap"));
  inlined.push(await inlineFile(summaryPath, summaryRel, `${completedSliceId} Summary`));
  const projectInline = await inlineGsdRootFile(base, "project.md", "Project");
  if (projectInline) inlined.push(projectInline);
  const requirementsInline = await inlineGsdRootFile(base, "requirements.md", "Requirements");
  if (requirementsInline) inlined.push(requirementsInline);
  const decisionsInline = await inlineGsdRootFile(base, "decisions.md", "Decisions");
  if (decisionsInline) inlined.push(decisionsInline);

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const assessmentPath = relSliceFile(base, mid, completedSliceId, "ASSESSMENT");

  return loadPrompt("reassess-roadmap", {
    milestoneId: mid,
    milestoneTitle: midTitle,
    completedSliceId,
    roadmapPath: roadmapRel,
    completedSliceSummaryPath: summaryRel,
    assessmentPath,
    inlinedContext,
  });
}

function extractSliceExecutionExcerpt(content: string | null, relPath: string): string {
  if (!content) {
    return [
      "## Slice Plan Excerpt",
      `Slice plan not found at dispatch time. Read \`${relPath}\` before running slice-level verification.`,
    ].join("\n");
  }

  const lines = content.split("\n");
  const goalLine = lines.find(l => l.startsWith("**Goal:**"))?.trim();
  const demoLine = lines.find(l => l.startsWith("**Demo:**"))?.trim();

  const verification = extractMarkdownSection(content, "Verification");
  const observability = extractMarkdownSection(content, "Observability / Diagnostics");

  const parts = ["## Slice Plan Excerpt", `Source: \`${relPath}\``];
  if (goalLine) parts.push(goalLine);
  if (demoLine) parts.push(demoLine);
  if (verification) {
    parts.push("", "### Slice Verification", verification.trim());
  }
  if (observability) {
    parts.push("", "### Slice Observability / Diagnostics", observability.trim());
  }

  return parts.join("\n");
}

function extractMarkdownSection(content: string, heading: string): string | null {
  const match = new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, "m").exec(content);
  if (!match) return null;

  const start = match.index + match[0].length;
  const rest = content.slice(start);
  const nextHeading = rest.match(/^##\s+/m);
  const end = nextHeading?.index ?? rest.length;
  return rest.slice(0, end).trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildResumeSection(
  continueContent: string | null,
  legacyContinueContent: string | null,
  continueRelPath: string,
  legacyContinueRelPath: string | null,
): string {
  const resolvedContent = continueContent ?? legacyContinueContent;
  const resolvedRelPath = continueContent ? continueRelPath : legacyContinueRelPath;

  if (!resolvedContent || !resolvedRelPath) {
    return ["## Resume State", "- No continue file present. Start from the top of the task plan."].join("\n");
  }

  const cont = parseContinue(resolvedContent);
  const lines = [
    "## Resume State",
    `Source: \`${resolvedRelPath}\``,
    `- Status: ${cont.frontmatter.status || "in_progress"}`,
  ];

  if (cont.frontmatter.step && cont.frontmatter.totalSteps) {
    lines.push(`- Progress: step ${cont.frontmatter.step} of ${cont.frontmatter.totalSteps}`);
  }
  if (cont.completedWork) lines.push(`- Completed: ${oneLine(cont.completedWork)}`);
  if (cont.remainingWork) lines.push(`- Remaining: ${oneLine(cont.remainingWork)}`);
  if (cont.decisions) lines.push(`- Decisions: ${oneLine(cont.decisions)}`);
  if (cont.nextAction) lines.push(`- Next action: ${oneLine(cont.nextAction)}`);

  return lines.join("\n");
}

async function buildCarryForwardSection(priorSummaryPaths: string[], base: string): Promise<string> {
  if (priorSummaryPaths.length === 0) {
    return ["## Carry-Forward Context", "- No prior task summaries in this slice."].join("\n");
  }

  const items = await Promise.all(priorSummaryPaths.map(async (relPath) => {
    const absPath = join(base, relPath);
    const content = await loadFile(absPath);
    if (!content) return `- \`${relPath}\``;

    const summary = parseSummary(content);
    const provided = summary.frontmatter.provides.slice(0, 2).join("; ");
    const decisions = summary.frontmatter.key_decisions.slice(0, 2).join("; ");
    const patterns = summary.frontmatter.patterns_established.slice(0, 2).join("; ");
    const diagnostics = extractMarkdownSection(content, "Diagnostics");

    const parts = [summary.title || relPath];
    if (summary.oneLiner) parts.push(summary.oneLiner);
    if (provided) parts.push(`provides: ${provided}`);
    if (decisions) parts.push(`decisions: ${decisions}`);
    if (patterns) parts.push(`patterns: ${patterns}`);
    if (diagnostics) parts.push(`diagnostics: ${oneLine(diagnostics)}`);

    return `- \`${relPath}\` — ${parts.join(" | ")}`;
  }));

  return ["## Carry-Forward Context", ...items].join("\n");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

async function getPriorTaskSummaryPaths(
  mid: string, sid: string, currentTid: string, base: string,
): Promise<string[]> {
  const tDir = resolveTasksDir(base, mid, sid);
  if (!tDir) return [];

  const summaryFiles = resolveTaskFiles(tDir, "SUMMARY");
  const currentNum = parseInt(currentTid.replace(/^T/, ""), 10);
  const sRel = relSlicePath(base, mid, sid);

  return summaryFiles
    .filter(f => {
      const num = parseInt(f.replace(/^T/, ""), 10);
      return num < currentNum;
    })
    .map(f => `${sRel}/tasks/${f}`);
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

/**
 * Write skip artifacts for a stuck execute-task: a blocker task summary and
 * the [x] checkbox in the slice plan. Returns true if artifacts were written.
 */
export function skipExecuteTask(
  base: string, mid: string, sid: string, tid: string,
  status: { summaryExists: boolean; taskChecked: boolean },
  reason: string, maxAttempts: number,
): boolean {
  // Write a blocker task summary if missing.
  if (!status.summaryExists) {
    const tasksDir = resolveTasksDir(base, mid, sid);
    const sDir = resolveSlicePath(base, mid, sid);
    const targetDir = tasksDir ?? (sDir ? join(sDir, "tasks") : null);
    if (!targetDir) return false;
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    const summaryPath = join(targetDir, buildTaskFileName(tid, "SUMMARY"));
    const content = [
      `# BLOCKER — task skipped by auto-mode recovery`,
      ``,
      `Task \`${tid}\` in slice \`${sid}\` (milestone \`${mid}\`) failed to complete after ${reason} recovery exhausted ${maxAttempts} attempts.`,
      ``,
      `This placeholder was written by auto-mode so the pipeline can advance.`,
      `Review this task manually and replace this file with a real summary.`,
    ].join("\n");
    writeFileSync(summaryPath, content, "utf-8");
  }

  // Mark [x] in the slice plan if not already checked.
  if (!status.taskChecked) {
    const planAbs = resolveSliceFile(base, mid, sid, "PLAN");
    if (planAbs && existsSync(planAbs)) {
      const planContent = readFileSync(planAbs, "utf-8");
      const escapedTid = tid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`^(- \\[) \\] (\\*\\*${escapedTid}:)`, "m");
      if (re.test(planContent)) {
        writeFileSync(planAbs, planContent.replace(re, "$1x] $2"), "utf-8");
      }
    }
  }

  return true;
}

/**
 * Detect whether the agent is producing work on disk by checking git for
 * any working-tree changes (staged, unstaged, or untracked). Returns true
 * if there are uncommitted changes — meaning the agent is actively working,
 * even though it hasn't signaled progress through runtime records.
 */
function detectWorkingTreeActivity(cwd: string): boolean {
  try {
    const out = execSync("git status --porcelain", {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    return out.toString().trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve the expected artifact for a non-execute-task unit to an absolute path.
 * Returns null for unit types that don't produce a single file (execute-task,
 * complete-slice, replan-slice).
 */
export function resolveExpectedArtifactPath(unitType: string, unitId: string, base: string): string | null {
  const parts = unitId.split("/");
  const mid = parts[0]!;
  const sid = parts[1];
  switch (unitType) {
    case "research-milestone": {
      const dir = resolveMilestonePath(base, mid);
      return dir ? join(dir, buildMilestoneFileName(mid, "RESEARCH")) : null;
    }
    case "plan-milestone": {
      const dir = resolveMilestonePath(base, mid);
      return dir ? join(dir, buildMilestoneFileName(mid, "ROADMAP")) : null;
    }
    case "research-slice": {
      const dir = resolveSlicePath(base, mid, sid!);
      return dir ? join(dir, buildSliceFileName(sid!, "RESEARCH")) : null;
    }
    case "plan-slice": {
      const dir = resolveSlicePath(base, mid, sid!);
      return dir ? join(dir, buildSliceFileName(sid!, "PLAN")) : null;
    }
    case "reassess-roadmap": {
      const dir = resolveSlicePath(base, mid, sid!);
      return dir ? join(dir, buildSliceFileName(sid!, "ASSESSMENT")) : null;
    }
    case "run-uat": {
      const dir = resolveSlicePath(base, mid, sid!);
      return dir ? join(dir, buildSliceFileName(sid!, "UAT-RESULT")) : null;
    }
    case "execute-task": {
      const tid = parts[2];
      const dir = resolveSlicePath(base, mid, sid!);
      return dir && tid ? join(dir, "tasks", buildTaskFileName(tid, "SUMMARY")) : null;
    }
    case "complete-slice": {
      const dir = resolveSlicePath(base, mid, sid!);
      return dir ? join(dir, buildSliceFileName(sid!, "SUMMARY")) : null;
    }
    case "complete-milestone": {
      const dir = resolveMilestonePath(base, mid);
      return dir ? join(dir, buildMilestoneFileName(mid, "SUMMARY")) : null;
    }
    default:
      return null;
  }
}

/**
 * Check whether the expected artifact(s) for a unit exist on disk.
 * Returns true if all required artifacts exist, or if the unit type has no
 * single verifiable artifact (e.g., replan-slice).
 *
 * complete-slice requires both SUMMARY and UAT files — verifying only
 * the summary allowed the unit to be marked complete when the LLM
 * skipped writing the UAT file (see #176).
 */
export function verifyExpectedArtifact(unitType: string, unitId: string, base: string): boolean {
  // Clear stale directory listing cache so artifact checks see fresh disk state (#431)
  clearPathCache();

  // Hook units have no standard artifact — always pass. Their lifecycle
  // is managed by the hook engine, not the artifact verification system.
  if (unitType.startsWith("hook/")) return true;


  const absPath = resolveExpectedArtifactPath(unitType, unitId, base);
  // Unit types with no verifiable artifact always pass (e.g. replan-slice).
  // For all other types, null means the parent directory is missing on disk
  // — treat as stale completion state so the key gets evicted (#313).
  if (!absPath) return unitType === "replan-slice";
  if (!existsSync(absPath)) return false;

  // execute-task must also have its checkbox marked [x] in the slice plan
  if (unitType === "execute-task") {
    const parts = unitId.split("/");
    const mid = parts[0];
    const sid = parts[1];
    const tid = parts[2];
    if (mid && sid && tid) {
      const planAbs = resolveSliceFile(base, mid, sid, "PLAN");
      if (planAbs && existsSync(planAbs)) {
        const planContent = readFileSync(planAbs, "utf-8");
        const escapedTid = tid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`^- \\[[xX]\\] \\*\\*${escapedTid}:`, "m");
        if (!re.test(planContent)) return false;
      }
    }
  }

  // complete-slice must also produce a UAT file AND mark the slice [x] in the roadmap.
  // Without the roadmap check, a crash after writing SUMMARY+UAT but before updating
  // the roadmap causes an infinite skip loop: the idempotency key says "done" but the
  // state machine keeps returning the same complete-slice unit (roadmap still shows
  // the slice incomplete), so dispatchNextUnit recurses forever.
  if (unitType === "complete-slice") {
    const parts = unitId.split("/");
    const mid = parts[0];
    const sid = parts[1];
    if (mid && sid) {
      const dir = resolveSlicePath(base, mid, sid);
      if (dir) {
        const uatPath = join(dir, buildSliceFileName(sid, "UAT"));
        if (!existsSync(uatPath)) return false;
      }
      // Verify the roadmap has the slice marked [x]. If not, the completion
      // record is stale — the unit must re-run to update the roadmap.
      const roadmapFile = resolveMilestoneFile(base, mid, "ROADMAP");
      if (roadmapFile && existsSync(roadmapFile)) {
        try {
          const roadmapContent = readFileSync(roadmapFile, "utf-8");
          const roadmap = parseRoadmap(roadmapContent);
          const slice = roadmap.slices.find(s => s.id === sid);
          if (slice && !slice.done) return false;
        } catch { /* corrupt roadmap — be lenient and treat as verified */ }
      }
    }
  }

  return true;
}

/**
 * Write a placeholder artifact so the pipeline can advance past a stuck unit.
 * Returns the relative path written, or null if the path couldn't be resolved.
 */
export function writeBlockerPlaceholder(unitType: string, unitId: string, base: string, reason: string): string | null {
  const absPath = resolveExpectedArtifactPath(unitType, unitId, base);
  if (!absPath) return null;
  const dir = dirname(absPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const content = [
    `# BLOCKER — auto-mode recovery failed`,
    ``,
    `Unit \`${unitType}\` for \`${unitId}\` failed to produce this artifact after idle recovery exhausted all retries.`,
    ``,
    `**Reason**: ${reason}`,
    ``,
    `This placeholder was written by auto-mode so the pipeline can advance.`,
    `Review and replace this file before relying on downstream artifacts.`,
  ].join("\n");
  writeFileSync(absPath, content, "utf-8");
  return diagnoseExpectedArtifact(unitType, unitId, base);
}

function diagnoseExpectedArtifact(unitType: string, unitId: string, base: string): string | null {
  const parts = unitId.split("/");
  const mid = parts[0];
  const sid = parts[1];
  switch (unitType) {
    case "research-milestone":
      return `${relMilestoneFile(base, mid!, "RESEARCH")} (milestone research)`;
    case "plan-milestone":
      return `${relMilestoneFile(base, mid!, "ROADMAP")} (milestone roadmap)`;
    case "research-slice":
      return `${relSliceFile(base, mid!, sid!, "RESEARCH")} (slice research)`;
    case "plan-slice":
      return `${relSliceFile(base, mid!, sid!, "PLAN")} (slice plan)`;
    case "execute-task": {
      const tid = parts[2];
      return `Task ${tid} marked [x] in ${relSliceFile(base, mid!, sid!, "PLAN")} + summary written`;
    }
    case "complete-slice":
      return `Slice ${sid} marked [x] in ${relMilestoneFile(base, mid!, "ROADMAP")} + summary + UAT written`;
    case "replan-slice":
      return `${relSliceFile(base, mid!, sid!, "REPLAN")} + updated ${relSliceFile(base, mid!, sid!, "PLAN")}`;
    case "reassess-roadmap":
      return `${relSliceFile(base, mid!, sid!, "ASSESSMENT")} (roadmap reassessment)`;
    case "run-uat":
      return `${relSliceFile(base, mid!, sid!, "UAT-RESULT")} (UAT result)`;
    case "complete-milestone":
      return `${relMilestoneFile(base, mid!, "SUMMARY")} (milestone summary)`;
    default:
      return null;
  }
}

/**
 * Build concrete, manual remediation steps for a loop-detected unit failure.
 * These are shown when automatic reconciliation is not possible.
 */
export function buildLoopRemediationSteps(unitType: string, unitId: string, base: string): string | null {
  const parts = unitId.split("/");
  const mid = parts[0];
  const sid = parts[1];
  const tid = parts[2];
  switch (unitType) {
    case "execute-task": {
      if (!mid || !sid || !tid) break;
      const planRel = relSliceFile(base, mid, sid, "PLAN");
      const summaryRel = relTaskFile(base, mid, sid, tid, "SUMMARY");
      return [
        `   1. Write ${summaryRel} (even a partial summary is sufficient to unblock the pipeline)`,
        `   2. Mark ${tid} [x] in ${planRel}: change "- [ ] **${tid}:" → "- [x] **${tid}:"`,
        `   3. Run \`gsd doctor\` to reconcile .gsd/ state`,
        `   4. Resume auto-mode — it will pick up from the next task`,
      ].join("\n");
    }
    case "plan-slice":
    case "research-slice": {
      if (!mid || !sid) break;
      const artifactRel = unitType === "plan-slice"
        ? relSliceFile(base, mid, sid, "PLAN")
        : relSliceFile(base, mid, sid, "RESEARCH");
      return [
        `   1. Write ${artifactRel} manually (or with the LLM in interactive mode)`,
        `   2. Run \`gsd doctor\` to reconcile .gsd/ state`,
        `   3. Resume auto-mode`,
      ].join("\n");
    }
    case "complete-slice": {
      if (!mid || !sid) break;
      return [
        `   1. Write the slice summary and UAT file for ${sid} in ${relSlicePath(base, mid, sid)}`,
        `   2. Mark ${sid} [x] in ${relMilestoneFile(base, mid, "ROADMAP")}`,
        `   3. Run \`gsd doctor\` to reconcile .gsd/ state`,
        `   4. Resume auto-mode`,
      ].join("\n");
    }
    default:
      break;
  }
  return null;
}
