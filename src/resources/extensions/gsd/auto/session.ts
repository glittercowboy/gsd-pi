/**
 * AutoSession — encapsulates all mutable auto-mode state into a single instance.
 *
 * Replaces ~40 module-level variables scattered across auto.ts with typed
 * properties on a class instance. Benefits:
 *
 * - reset() clears everything in one call (was 25+ manual resets in stopAuto)
 * - toJSON() provides diagnostic snapshots
 * - grep `s.` shows every state access
 * - Constructable for testing
 *
 * MAINTENANCE RULE: All new mutable auto-mode state MUST be added here as a
 * class property, not as a module-level variable in auto.ts. If the state
 * needs clearing on stop, add it to reset(). Tests in
 * auto-session-encapsulation.test.ts enforce that auto.ts has no module-level
 * `let` or `var` declarations.
 */

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import type { GitServiceImpl } from "../git-service.js";
import type { CaptureEntry } from "../captures.js";
import type { BudgetAlertLevel } from "../auto-budget.js";

// ─── Exported Types ──────────────────────────────────────────────────────────

export interface CompletedUnit {
  type: string;
  id: string;
  startedAt: number;
  finishedAt: number;
}

export interface CurrentUnit {
  type: string;
  id: string;
  startedAt: number;
}

export interface UnitRouting {
  tier: string;
  modelDowngraded: boolean;
}

export interface StartModel {
  provider: string;
  id: string;
}

export interface PendingVerificationRetry {
  unitId: string;
  failureContext: string;
  attempt: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const MAX_UNIT_DISPATCHES = 3;
export const STUB_RECOVERY_THRESHOLD = 2;
export const MAX_LIFETIME_DISPATCHES = 6;
export const MAX_CONSECUTIVE_SKIPS = 3;
export const DISPATCH_GAP_TIMEOUT_MS = 5_000;
export const MAX_SKIP_DEPTH = 20;
export const NEW_SESSION_TIMEOUT_MS = 30_000;
export const DISPATCH_HANG_TIMEOUT_MS = 60_000;

// ─── AutoSession ─────────────────────────────────────────────────────────────

export class AutoSession {
  // ── Lifecycle ────────────────────────────────────────────────────────────
  active = false;
  paused = false;
  stepMode = false;
  verbose = false;
  cmdCtx: ExtensionCommandContext | null = null;

  // ── Paths ────────────────────────────────────────────────────────────────
  basePath = "";
  originalBasePath = "";
  gitService: GitServiceImpl | null = null;

  // ── Dispatch counters ────────────────────────────────────────────────────
  readonly unitDispatchCount = new Map<string, number>();
  readonly unitLifetimeDispatches = new Map<string, number>();
  readonly unitRecoveryCount = new Map<string, number>();
  readonly unitConsecutiveSkips = new Map<string, number>();
  readonly completedKeySet = new Set<string>();

  // ── Timers ───────────────────────────────────────────────────────────────
  unitTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  wrapupWarningHandle: ReturnType<typeof setTimeout> | null = null;
  idleWatchdogHandle: ReturnType<typeof setInterval> | null = null;
  continueHereHandle: ReturnType<typeof setInterval> | null = null;
  dispatchGapHandle: ReturnType<typeof setTimeout> | null = null;

  // ── Current unit ─────────────────────────────────────────────────────────
  currentUnit: CurrentUnit | null = null;
  currentUnitRouting: UnitRouting | null = null;
  completedUnits: CompletedUnit[] = [];
  currentMilestoneId: string | null = null;

  // ── Model state ──────────────────────────────────────────────────────────
  autoModeStartModel: StartModel | null = null;
  originalModelId: string | null = null;
  originalModelProvider: string | null = null;
  lastBudgetAlertLevel: BudgetAlertLevel = 0;

  // ── Recovery ─────────────────────────────────────────────────────────────
  pendingCrashRecovery: string | null = null;
  pendingVerificationRetry: PendingVerificationRetry | null = null;
  readonly verificationRetryCount = new Map<string, number>();
  pausedSessionFile: string | null = null;
  resourceVersionOnStart: string | null = null;
  lastStateRebuildAt = 0;

  // ── Guards ───────────────────────────────────────────────────────────────
  handlingAgentEnd = false;
  pendingAgentEndRetry = false;
  dispatching = false;
  skipDepth = 0;
  readonly recentlyEvictedKeys = new Set<string>();

  // ── Metrics ──────────────────────────────────────────────────────────────
  autoStartTime = 0;
  lastPromptCharCount: number | undefined;
  lastBaselineCharCount: number | undefined;
  pendingQuickTasks: CaptureEntry[] = [];

  // ── Signal handler ───────────────────────────────────────────────────────
  sigtermHandler: (() => void) | null = null;

  // ── Methods ──────────────────────────────────────────────────────────────

  clearTimers(): void {
    if (this.unitTimeoutHandle) { clearTimeout(this.unitTimeoutHandle); this.unitTimeoutHandle = null; }
    if (this.wrapupWarningHandle) { clearTimeout(this.wrapupWarningHandle); this.wrapupWarningHandle = null; }
    if (this.idleWatchdogHandle) { clearInterval(this.idleWatchdogHandle); this.idleWatchdogHandle = null; }
    if (this.continueHereHandle) { clearInterval(this.continueHereHandle); this.continueHereHandle = null; }
    if (this.dispatchGapHandle) { clearTimeout(this.dispatchGapHandle); this.dispatchGapHandle = null; }
  }

  resetDispatchCounters(): void {
    this.unitDispatchCount.clear();
    this.unitLifetimeDispatches.clear();
    this.unitConsecutiveSkips.clear();
  }

  get lockBasePath(): string {
    return this.originalBasePath || this.basePath;
  }

  completeCurrentUnit(): CompletedUnit | null {
    if (!this.currentUnit) return null;
    const done: CompletedUnit = { ...this.currentUnit, finishedAt: Date.now() };
    this.completedUnits.push(done);
    this.currentUnit = null;
    return done;
  }

  reset(): void {
    this.clearTimers();

    // Lifecycle
    this.active = false;
    this.paused = false;
    this.stepMode = false;
    this.verbose = false;
    this.cmdCtx = null;

    // Paths
    this.basePath = "";
    this.originalBasePath = "";
    this.gitService = null;

    // Dispatch
    this.unitDispatchCount.clear();
    this.unitLifetimeDispatches.clear();
    this.unitRecoveryCount.clear();
    this.unitConsecutiveSkips.clear();
    // Note: completedKeySet is intentionally NOT cleared — it persists
    // across restarts to prevent re-dispatching completed units.

    // Unit
    this.currentUnit = null;
    this.currentUnitRouting = null;
    this.completedUnits = [];
    this.currentMilestoneId = null;

    // Model
    this.autoModeStartModel = null;
    this.originalModelId = null;
    this.originalModelProvider = null;
    this.lastBudgetAlertLevel = 0;

    // Recovery
    this.pendingCrashRecovery = null;
    this.pendingVerificationRetry = null;
    this.verificationRetryCount.clear();
    this.pausedSessionFile = null;
    this.resourceVersionOnStart = null;
    this.lastStateRebuildAt = 0;

    // Guards
    this.handlingAgentEnd = false;
    this.pendingAgentEndRetry = false;
    this.dispatching = false;
    this.skipDepth = 0;
    this.recentlyEvictedKeys.clear();

    // Metrics
    this.autoStartTime = 0;
    this.lastPromptCharCount = undefined;
    this.lastBaselineCharCount = undefined;
    this.pendingQuickTasks = [];

    // Signal handler
    this.sigtermHandler = null;
  }

  toJSON(): Record<string, unknown> {
    return {
      active: this.active,
      paused: this.paused,
      stepMode: this.stepMode,
      basePath: this.basePath,
      currentMilestoneId: this.currentMilestoneId,
      currentUnit: this.currentUnit,
      completedUnits: this.completedUnits.length,
      completedKeySet: this.completedKeySet.size,
      unitDispatchCount: Object.fromEntries(this.unitDispatchCount),
      dispatching: this.dispatching,
      skipDepth: this.skipDepth,
    };
  }
}
