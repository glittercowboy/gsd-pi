/**
 * auto-loop.ts — Linear loop execution backbone for auto-mode.
 *
 * Replaces the recursive dispatchNextUnit → handleAgentEnd → dispatchNextUnit
 * pattern with a while loop. The agent_end event resolves a promise instead
 * of recursing.
 *
 * MAINTENANCE RULE: Module-level mutable state is limited to `_currentResolve`
 * (per-unit one-shot resolver) and `_sessionSwitchInFlight` (guard for
 * session rotation). No queue — stale agent_end events are dropped.
 */

import { importExtensionModule, type ExtensionAPI, type ExtensionContext } from "@gsd/pi-coding-agent";

import type { AutoSession, SidecarItem } from "./auto/session.js";
import { NEW_SESSION_TIMEOUT_MS } from "./auto/session.js";
import type { GSDPreferences } from "./preferences.js";
import type { SessionLockStatus } from "./session-lock.js";
import type { GSDState } from "./types.js";
import type { CloseoutOptions } from "./auto-unit-closeout.js";
import type { PostUnitContext, PreVerificationOpts } from "./auto-post-unit.js";
import type {
  VerificationContext,
  VerificationResult,
} from "./auto-verification.js";
import type { DispatchAction } from "./auto-dispatch.js";
import type { WorktreeResolver } from "./worktree-resolver.js";
import { debugLog } from "./debug-logger.js";
import { gsdRoot } from "./paths.js";
import { atomicWriteSync } from "./atomic-write.js";
import { join } from "node:path";
import type { CmuxLogLevel } from "../cmux/index.js";

/**
 * Maximum total loop iterations before forced stop. Prevents runaway loops
 * when units alternate IDs (bypassing the same-unit stuck detector).
 * A milestone with 20 slices × 5 tasks × 3 phases ≈ 300 units. 500 gives
 * generous headroom including retries and sidecar work.
 */
const MAX_LOOP_ITERATIONS = 500;
/** Maximum characters of failure/crash context included in recovery prompts. */
const MAX_RECOVERY_CHARS = 50_000;

/** Data-driven budget threshold notifications (descending). The 100% entry
 *  triggers special enforcement logic (halt/pause/warn); sub-100 entries fire
 *  a simple notification. */
const BUDGET_THRESHOLDS: Array<{
  pct: number;
  label: string;
  notifyLevel: "info" | "warning" | "error";
  cmuxLevel: "progress" | "warning" | "error";
}> = [
  { pct: 100, label: "Budget ceiling reached", notifyLevel: "error", cmuxLevel: "error" },
  { pct: 90, label: "Budget 90%", notifyLevel: "warning", cmuxLevel: "warning" },
  { pct: 80, label: "Approaching budget ceiling — 80%", notifyLevel: "warning", cmuxLevel: "warning" },
  { pct: 75, label: "Budget 75%", notifyLevel: "info", cmuxLevel: "progress" },
];

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Minimal shape of the event parameter from pi.on("agent_end", ...).
 * The full event has more fields, but the loop only needs messages.
 */
export interface AgentEndEvent {
  messages: unknown[];
}

/**
 * Result of a single unit execution (one iteration of the loop).
 */
export interface UnitResult {
  status: "completed" | "cancelled" | "error";
  event?: AgentEndEvent;
}

// ─── Per-unit one-shot promise state ────────────────────────────────────────
//
// A single module-level resolve function scoped to the current unit execution.
// No queue — if an agent_end arrives with no pending resolver, it is dropped
// (logged as warning). This is simpler and safer than the previous session-
// scoped pendingResolve + pendingAgentEndQueue pattern.

let _currentResolve: ((result: UnitResult) => void) | null = null;
let _sessionSwitchInFlight = false;

// ─── resolveAgentEnd ─────────────────────────────────────────────────────────

/**
 * Called from the agent_end event handler in index.ts to resolve the
 * in-flight unit promise. One-shot: the resolver is nulled before calling
 * to prevent double-resolution from model fallback retries.
 *
 * If no resolver exists (event arrived between loop iterations or during
 * session switch), the event is dropped with a debug warning.
 */
export function resolveAgentEnd(event: AgentEndEvent): void {
  if (_sessionSwitchInFlight) {
    debugLog("resolveAgentEnd", { status: "ignored-during-switch" });
    return;
  }
  if (_currentResolve) {
    debugLog("resolveAgentEnd", { status: "resolving", hasEvent: true });
    const r = _currentResolve;
    _currentResolve = null;
    r({ status: "completed", event });
  } else {
    debugLog("resolveAgentEnd", {
      status: "no-pending-resolve",
      warning: "agent_end with no pending unit",
    });
  }
}

export function isSessionSwitchInFlight(): boolean {
  return _sessionSwitchInFlight;
}

// ─── resetPendingResolve (test helper) ───────────────────────────────────────

/**
 * Reset module-level promise state. Only exported for test cleanup —
 * production code should never call this.
 */
export function _resetPendingResolve(): void {
  _currentResolve = null;
  _sessionSwitchInFlight = false;
}

/**
 * No-op for backward compatibility with tests that previously set the
 * active session. The module no longer holds a session reference.
 */
export function _setActiveSession(_session: AutoSession | null): void {
  // No-op — kept for test backward compatibility
}

// ─── detectStuck ─────────────────────────────────────────────────────────────

type WindowEntry = { key: string; error?: string };

/**
 * Analyze a sliding window of recent unit dispatches for stuck patterns.
 * Returns a signal with reason if stuck, null otherwise.
 *
 * Rule 1: Same error string twice in a row → stuck immediately.
 * Rule 2: Same unit key 3+ consecutive times → stuck (preserves prior behavior).
 * Rule 3: Oscillation A→B→A→B in last 4 entries → stuck.
 */
export function detectStuck(
  window: readonly WindowEntry[],
): { stuck: true; reason: string } | null {
  if (window.length < 2) return null;

  const last = window[window.length - 1];
  const prev = window[window.length - 2];

  // Rule 1: Same error repeated consecutively
  if (last.error && prev.error && last.error === prev.error) {
    return {
      stuck: true,
      reason: `Same error repeated: ${last.error.slice(0, 200)}`,
    };
  }

  // Rule 2: Same unit 3+ consecutive times
  if (window.length >= 3) {
    const lastThree = window.slice(-3);
    if (lastThree.every((u) => u.key === last.key)) {
      return {
        stuck: true,
        reason: `${last.key} derived 3 consecutive times without progress`,
      };
    }
  }

  // Rule 3: Oscillation (A→B→A→B in last 4)
  if (window.length >= 4) {
    const w = window.slice(-4);
    if (
      w[0].key === w[2].key &&
      w[1].key === w[3].key &&
      w[0].key !== w[1].key
    ) {
      return {
        stuck: true,
        reason: `Oscillation detected: ${w[0].key} ↔ ${w[1].key}`,
      };
    }
  }

  return null;
}

// ─── runUnit ─────────────────────────────────────────────────────────────────

/**
 * Execute a single unit: create a new session, send the prompt, and await
 * the agent_end promise. Returns a UnitResult describing what happened.
 *
 * The promise is one-shot: resolveAgentEnd() is the only way to resolve it.
 * On session creation failure or timeout, returns { status: 'cancelled' }
 * without awaiting the promise.
 */
export async function runUnit(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  s: AutoSession,
  unitType: string,
  unitId: string,
  prompt: string,
): Promise<UnitResult> {
  debugLog("runUnit", { phase: "start", unitType, unitId });

  // ── Session creation with timeout ──
  debugLog("runUnit", { phase: "session-create", unitType, unitId });

  let sessionResult: { cancelled: boolean };
  let sessionTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  _sessionSwitchInFlight = true;
  try {
    const sessionPromise = s.cmdCtx!.newSession().finally(() => {
      _sessionSwitchInFlight = false;
    });
    const timeoutPromise = new Promise<{ cancelled: true }>((resolve) => {
      sessionTimeoutHandle = setTimeout(
        () => resolve({ cancelled: true }),
        NEW_SESSION_TIMEOUT_MS,
      );
    });
    sessionResult = await Promise.race([sessionPromise, timeoutPromise]);
  } catch (sessionErr) {
    if (sessionTimeoutHandle) clearTimeout(sessionTimeoutHandle);
    const msg =
      sessionErr instanceof Error ? sessionErr.message : String(sessionErr);
    debugLog("runUnit", {
      phase: "session-error",
      unitType,
      unitId,
      error: msg,
    });
    return { status: "cancelled" };
  }
  if (sessionTimeoutHandle) clearTimeout(sessionTimeoutHandle);

  if (sessionResult.cancelled) {
    debugLog("runUnit-session-timeout", { unitType, unitId });
    return { status: "cancelled" };
  }

  if (!s.active) {
    return { status: "cancelled" };
  }

  // ── Create the agent_end promise (per-unit one-shot) ──
  // This happens after newSession completes so session-switch agent_end events
  // from the previous session cannot resolve the new unit.
  _sessionSwitchInFlight = false;
  const unitPromise = new Promise<UnitResult>((resolve) => {
    _currentResolve = resolve;
  });

  // Ensure cwd matches basePath before dispatch (#1389).
  // async_bash and background jobs can drift cwd away from the worktree.
  // Realigning here prevents commits from landing on the wrong branch.
  try {
    if (process.cwd() !== s.basePath) {
      process.chdir(s.basePath);
    }
  } catch { /* non-fatal — chdir may fail if dir was removed */ }

  // ── Send the prompt ──
  debugLog("runUnit", { phase: "send-message", unitType, unitId });

  pi.sendMessage(
    { customType: "gsd-auto", content: prompt, display: s.verbose },
    { triggerTurn: true },
  );

  // ── Await agent_end ──
  debugLog("runUnit", { phase: "awaiting-agent-end", unitType, unitId });
  const result = await unitPromise;
  debugLog("runUnit", {
    phase: "agent-end-received",
    unitType,
    unitId,
    status: result.status,
  });

  return result;
}

// ─── LoopDeps ────────────────────────────────────────────────────────────────

/**
 * Dependencies injected by the caller (auto.ts startAuto) so autoLoop
 * can access private functions from auto.ts without exporting them.
 */
export interface LoopDeps {
  lockBase: () => string;
  buildSnapshotOpts: (
    unitType: string,
    unitId: string,
  ) => CloseoutOptions & Record<string, unknown>;
  stopAuto: (
    ctx?: ExtensionContext,
    pi?: ExtensionAPI,
    reason?: string,
  ) => Promise<void>;
  pauseAuto: (ctx?: ExtensionContext, pi?: ExtensionAPI) => Promise<void>;
  clearUnitTimeout: () => void;
  updateProgressWidget: (
    ctx: ExtensionContext,
    unitType: string,
    unitId: string,
    state: GSDState,
  ) => void;
  syncCmuxSidebar: (preferences: GSDPreferences | undefined, state: GSDState) => void;
  logCmuxEvent: (
    preferences: GSDPreferences | undefined,
    message: string,
    level?: CmuxLogLevel,
  ) => void;

  // State and cache functions
  invalidateAllCaches: () => void;
  deriveState: (basePath: string) => Promise<GSDState>;
  loadEffectiveGSDPreferences: () =>
    | { preferences?: GSDPreferences }
    | undefined;

  // Pre-dispatch health gate
  preDispatchHealthGate: (
    basePath: string,
  ) => Promise<{ proceed: boolean; reason?: string; fixesApplied: string[] }>;

  // Worktree sync
  syncProjectRootToWorktree: (
    originalBase: string,
    basePath: string,
    milestoneId: string | null,
  ) => void;

  // Resource version guard
  checkResourcesStale: (version: string | null) => string | null;

  // Session lock
  validateSessionLock: (basePath: string) => SessionLockStatus;
  updateSessionLock: (
    basePath: string,
    unitType: string,
    unitId: string,
    completedUnits: number,
    sessionFile?: string,
  ) => void;
  handleLostSessionLock: (
    ctx?: ExtensionContext,
    lockStatus?: SessionLockStatus,
  ) => void;

  // Milestone transition functions
  sendDesktopNotification: (
    title: string,
    body: string,
    kind: string,
    category: string,
  ) => void;
  setActiveMilestoneId: (basePath: string, mid: string) => void;
  pruneQueueOrder: (basePath: string, pendingIds: string[]) => void;
  isInAutoWorktree: (basePath: string) => boolean;
  shouldUseWorktreeIsolation: () => boolean;
  mergeMilestoneToMain: (
    basePath: string,
    milestoneId: string,
    roadmapContent: string,
  ) => { pushed: boolean };
  teardownAutoWorktree: (basePath: string, milestoneId: string) => void;
  createAutoWorktree: (basePath: string, milestoneId: string) => string;
  captureIntegrationBranch: (
    basePath: string,
    mid: string,
    opts?: { commitDocs?: boolean },
  ) => void;
  getIsolationMode: () => string;
  getCurrentBranch: (basePath: string) => string;
  autoWorktreeBranch: (milestoneId: string) => string;
  resolveMilestoneFile: (
    basePath: string,
    milestoneId: string,
    fileType: string,
  ) => string | null;
  reconcileMergeState: (basePath: string, ctx: ExtensionContext) => boolean;

  // Budget/context/secrets
  getLedger: () => unknown;
  getProjectTotals: (units: unknown) => { cost: number };
  formatCost: (cost: number) => string;
  getBudgetAlertLevel: (pct: number) => number;
  getNewBudgetAlertLevel: (lastLevel: number, pct: number) => number;
  getBudgetEnforcementAction: (enforcement: string, pct: number) => string;
  getManifestStatus: (
    basePath: string,
    mid: string | undefined,
    projectRoot?: string,
  ) => Promise<{ pending: unknown[] } | null>;
  collectSecretsFromManifest: (
    basePath: string,
    mid: string | undefined,
    ctx: ExtensionContext,
  ) => Promise<{
    applied: unknown[];
    skipped: unknown[];
    existingSkipped: unknown[];
  } | null>;

  // Dispatch
  resolveDispatch: (dctx: {
    basePath: string;
    mid: string;
    midTitle: string;
    state: GSDState;
    prefs: GSDPreferences | undefined;
    session?: AutoSession;
  }) => Promise<DispatchAction>;
  runPreDispatchHooks: (
    unitType: string,
    unitId: string,
    prompt: string,
    basePath: string,
  ) => {
    firedHooks: string[];
    action: string;
    prompt?: string;
    unitType?: string;
  };
  getPriorSliceCompletionBlocker: (
    basePath: string,
    mainBranch: string,
    unitType: string,
    unitId: string,
  ) => string | null;
  getMainBranch: (basePath: string) => string;
  collectObservabilityWarnings: (
    ctx: ExtensionContext,
    basePath: string,
    unitType: string,
    unitId: string,
  ) => Promise<unknown[]>;
  buildObservabilityRepairBlock: (issues: unknown[]) => string | null;

  // Unit closeout + runtime records
  closeoutUnit: (
    ctx: ExtensionContext,
    basePath: string,
    unitType: string,
    unitId: string,
    startedAt: number,
    opts?: CloseoutOptions & Record<string, unknown>,
  ) => Promise<void>;
  verifyExpectedArtifact: (
    unitType: string,
    unitId: string,
    basePath: string,
  ) => boolean;
  clearUnitRuntimeRecord: (
    basePath: string,
    unitType: string,
    unitId: string,
  ) => void;
  writeUnitRuntimeRecord: (
    basePath: string,
    unitType: string,
    unitId: string,
    startedAt: number,
    record: Record<string, unknown>,
  ) => void;
  recordOutcome: (unitType: string, tier: string, success: boolean) => void;
  writeLock: (
    lockBase: string,
    unitType: string,
    unitId: string,
    completedCount: number,
    sessionFile?: string,
  ) => void;
  captureAvailableSkills: () => void;
  ensurePreconditions: (
    unitType: string,
    unitId: string,
    basePath: string,
    state: GSDState,
  ) => void;
  updateSliceProgressCache: (
    basePath: string,
    mid: string,
    sliceId?: string,
  ) => void;

  // Model selection + supervision
  selectAndApplyModel: (
    ctx: ExtensionContext,
    pi: ExtensionAPI,
    unitType: string,
    unitId: string,
    basePath: string,
    prefs: GSDPreferences | undefined,
    verbose: boolean,
    startModel: { provider: string; id: string } | null,
    retryContext?: { isRetry: boolean; previousTier?: string },
  ) => Promise<{ routing: { tier: string; modelDowngraded: boolean } | null }>;
  startUnitSupervision: (sctx: {
    s: AutoSession;
    ctx: ExtensionContext;
    pi: ExtensionAPI;
    unitType: string;
    unitId: string;
    prefs: GSDPreferences | undefined;
    buildSnapshotOpts: () => CloseoutOptions & Record<string, unknown>;
    buildRecoveryContext: () => unknown;
    pauseAuto: (ctx?: ExtensionContext, pi?: ExtensionAPI) => Promise<void>;
  }) => void;

  // Prompt helpers
  getDeepDiagnostic: (basePath: string) => string | null;
  isDbAvailable: () => boolean;
  reorderForCaching: (prompt: string) => string;

  // Filesystem
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: string) => string;
  atomicWriteSync: (path: string, content: string) => void;

  // Git
  GitServiceImpl: new (basePath: string, gitConfig: unknown) => unknown;

  // WorktreeResolver
  resolver: WorktreeResolver;

  // Post-unit processing
  postUnitPreVerification: (
    pctx: PostUnitContext,
    opts?: PreVerificationOpts,
  ) => Promise<"dispatched" | "continue">;
  runPostUnitVerification: (
    vctx: VerificationContext,
    pauseAuto: (ctx?: ExtensionContext, pi?: ExtensionAPI) => Promise<void>,
  ) => Promise<VerificationResult>;
  postUnitPostVerification: (
    pctx: PostUnitContext,
  ) => Promise<"continue" | "step-wizard" | "stopped">;

  // Session manager
  getSessionFile: (ctx: ExtensionContext) => string;
}

// ─── generateMilestoneReport ──────────────────────────────────────────────────

/**
 * Generate and write an HTML milestone report snapshot.
 * Extracted from the milestone-transition block in autoLoop.
 */
async function generateMilestoneReport(
  s: AutoSession,
  ctx: ExtensionContext,
  milestoneId: string,
): Promise<void> {
  const { loadVisualizerData } = await importExtensionModule<typeof import("./visualizer-data.js")>(import.meta.url, "./visualizer-data.js");
  const { generateHtmlReport } = await importExtensionModule<typeof import("./export-html.js")>(import.meta.url, "./export-html.js");
  const { writeReportSnapshot } = await importExtensionModule<typeof import("./reports.js")>(import.meta.url, "./reports.js");
  const { basename } = await import("node:path");

  const snapData = await loadVisualizerData(s.basePath);
  const completedMs = snapData.milestones.find(
    (m: { id: string }) => m.id === milestoneId,
  );
  const msTitle = completedMs?.title ?? milestoneId;
  const gsdVersion = process.env.GSD_VERSION ?? "0.0.0";
  const projName = basename(s.basePath);
  const doneSlices = snapData.milestones.reduce(
    (acc: number, m: { slices: { done: boolean }[] }) =>
      acc + m.slices.filter((sl: { done: boolean }) => sl.done).length,
    0,
  );
  const totalSlices = snapData.milestones.reduce(
    (acc: number, m: { slices: unknown[] }) => acc + m.slices.length,
    0,
  );
  const outPath = writeReportSnapshot({
    basePath: s.basePath,
    html: generateHtmlReport(snapData, {
      projectName: projName,
      projectPath: s.basePath,
      gsdVersion,
      milestoneId,
      indexRelPath: "index.html",
    }),
    milestoneId,
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
    doneMilestones: snapData.milestones.filter(
      (m: { status: string }) => m.status === "complete",
    ).length,
    totalMilestones: snapData.milestones.length,
    phase: snapData.phase,
  });
  ctx.ui.notify(
    `Report saved: .gsd/reports/${basename(outPath)} — open index.html to browse progression.`,
    "info",
  );
}

// ─── closeoutAndStop ──────────────────────────────────────────────────────────

/**
 * If a unit is in-flight, close it out, then stop auto-mode.
 * Extracted from ~4 identical if-closeout-then-stop sequences in autoLoop.
 */
async function closeoutAndStop(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  s: AutoSession,
  deps: LoopDeps,
  reason: string,
): Promise<void> {
  if (s.currentUnit) {
    await deps.closeoutUnit(
      ctx,
      s.basePath,
      s.currentUnit.type,
      s.currentUnit.id,
      s.currentUnit.startedAt,
      deps.buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id),
    );
  }
  await deps.stopAuto(ctx, pi, reason);
}

// ─── autoLoop ────────────────────────────────────────────────────────────────

/**
 * Main auto-mode execution loop. Iterates: derive → dispatch → guards →
 * runUnit → finalize → repeat. Exits when s.active becomes false or a
 * terminal condition is reached.
 *
 * This is the linear replacement for the recursive
 * dispatchNextUnit → handleAgentEnd → dispatchNextUnit chain.
 */
export async function autoLoop(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  s: AutoSession,
  deps: LoopDeps,
): Promise<void> {
  debugLog("autoLoop", { phase: "enter" });
  let iteration = 0;
  // ── Sliding-window stuck detection ──
  const recentUnits: Array<{ key: string; error?: string }> = [];
  const STUCK_WINDOW_SIZE = 6;
  let stuckRecoveryAttempts = 0;

  let consecutiveErrors = 0;

  while (s.active) {
    iteration++;
    debugLog("autoLoop", { phase: "loop-top", iteration });

    if (iteration > MAX_LOOP_ITERATIONS) {
      debugLog("autoLoop", {
        phase: "exit",
        reason: "max-iterations",
        iteration,
      });
      await deps.stopAuto(
        ctx,
        pi,
        `Safety: loop exceeded ${MAX_LOOP_ITERATIONS} iterations — possible runaway`,
      );
      break;
    }

    if (!s.cmdCtx) {
      debugLog("autoLoop", { phase: "exit", reason: "no-cmdCtx" });
      break;
    }

    try {
      // ── Blanket try/catch: one bad iteration must not kill the session
      const prefs = deps.loadEffectiveGSDPreferences()?.preferences;

      // ── Check sidecar queue before deriveState ──
      let sidecarItem: SidecarItem | undefined;
      if (s.sidecarQueue.length > 0) {
        sidecarItem = s.sidecarQueue.shift()!;
        debugLog("autoLoop", {
          phase: "sidecar-dequeue",
          kind: sidecarItem.kind,
          unitType: sidecarItem.unitType,
          unitId: sidecarItem.unitId,
        });
      }

      const sessionLockBase = deps.lockBase();
      if (sessionLockBase) {
        const lockStatus = deps.validateSessionLock(sessionLockBase);
        if (!lockStatus.valid) {
          debugLog("autoLoop", {
            phase: "session-lock-invalid",
            reason: lockStatus.failureReason ?? "unknown",
            existingPid: lockStatus.existingPid,
            expectedPid: lockStatus.expectedPid,
          });
          deps.handleLostSessionLock(ctx, lockStatus);
          debugLog("autoLoop", {
            phase: "exit",
            reason: "session-lock-lost",
            detail: lockStatus.failureReason ?? "unknown",
          });
          break;
        }
      }

      // Variables shared between the sidecar and normal paths
      let unitType: string;
      let unitId: string;
      let prompt: string;
      let pauseAfterUatDispatch = false;
      let state: GSDState;
      let mid: string | undefined;
      let midTitle: string | undefined;
      let observabilityIssues: unknown[] = [];

      if (!sidecarItem) {
      // ── Phase 1: Pre-dispatch ───────────────────────────────────────────

      // Resource version guard
      const staleMsg = deps.checkResourcesStale(s.resourceVersionOnStart);
      if (staleMsg) {
        await deps.stopAuto(ctx, pi, staleMsg);
        debugLog("autoLoop", { phase: "exit", reason: "resources-stale" });
        break;
      }

      deps.invalidateAllCaches();
      s.lastPromptCharCount = undefined;
      s.lastBaselineCharCount = undefined;

      // Pre-dispatch health gate
      try {
        const healthGate = await deps.preDispatchHealthGate(s.basePath);
        if (healthGate.fixesApplied.length > 0) {
          ctx.ui.notify(
            `Pre-dispatch: ${healthGate.fixesApplied.join(", ")}`,
            "info",
          );
        }
        if (!healthGate.proceed) {
          ctx.ui.notify(
            healthGate.reason ?? "Pre-dispatch health check failed.",
            "error",
          );
          await deps.pauseAuto(ctx, pi);
          debugLog("autoLoop", { phase: "exit", reason: "health-gate-failed" });
          break;
        }
      } catch {
        // Non-fatal
      }

      // Sync project root artifacts into worktree
      if (
        s.originalBasePath &&
        s.basePath !== s.originalBasePath &&
        s.currentMilestoneId
      ) {
        deps.syncProjectRootToWorktree(
          s.originalBasePath,
          s.basePath,
          s.currentMilestoneId,
        );
      }

      // Derive state
      state = await deps.deriveState(s.basePath);
      deps.syncCmuxSidebar(prefs, state);
      mid = state.activeMilestone?.id;
      midTitle = state.activeMilestone?.title;
      debugLog("autoLoop", {
        phase: "state-derived",
        iteration,
        mid,
        statePhase: state.phase,
      });

      // ── Milestone transition ────────────────────────────────────────────
      if (mid && s.currentMilestoneId && mid !== s.currentMilestoneId) {
        ctx.ui.notify(
          `Milestone ${s.currentMilestoneId} complete. Advancing to ${mid}: ${midTitle}.`,
          "info",
        );
        deps.sendDesktopNotification(
          "GSD",
          `Milestone ${s.currentMilestoneId} complete!`,
          "success",
          "milestone",
        );
        deps.logCmuxEvent(
          prefs,
          `Milestone ${s.currentMilestoneId} complete. Advancing to ${mid}.`,
          "success",
        );

        const vizPrefs = prefs;
        if (vizPrefs?.auto_visualize) {
          ctx.ui.notify("Run /gsd visualize to see progress overview.", "info");
        }
        if (vizPrefs?.auto_report !== false) {
          try {
            await generateMilestoneReport(s, ctx, s.currentMilestoneId!);
          } catch (err) {
            ctx.ui.notify(
              `Report generation failed: ${err instanceof Error ? err.message : String(err)}`,
              "warning",
            );
          }
        }

        // Reset dispatch counters for new milestone
        s.unitDispatchCount.clear();
        s.unitRecoveryCount.clear();
        s.unitLifetimeDispatches.clear();
        recentUnits.length = 0;
        stuckRecoveryAttempts = 0;

        // Worktree lifecycle on milestone transition — merge current, enter next
        deps.resolver.mergeAndExit(s.currentMilestoneId!, ctx.ui);

        // Opt-in: create draft PR on milestone completion
        if (prefs?.git?.auto_pr) {
          try {
            const { createDraftPR } = await import("./git-service.js");
            const prUrl = createDraftPR(
              s.basePath,
              s.currentMilestoneId!,
              `[GSD] ${s.currentMilestoneId} complete`,
              `Milestone ${s.currentMilestoneId} completed by GSD auto-mode.\n\nSee .gsd/${s.currentMilestoneId}/ for details.`,
            );
            if (prUrl) {
              ctx.ui.notify(`Draft PR created: ${prUrl}`, "info");
            }
          } catch {
            // Non-fatal — PR creation is best-effort
          }
        }

        deps.invalidateAllCaches();

        state = await deps.deriveState(s.basePath);
        mid = state.activeMilestone?.id;
        midTitle = state.activeMilestone?.title;

        if (mid) {
          if (deps.getIsolationMode() !== "none") {
            deps.captureIntegrationBranch(s.basePath, mid, {
              commitDocs: prefs?.git?.commit_docs,
            });
          }
          deps.resolver.enterMilestone(mid, ctx.ui);
        } else {
          // mid is undefined — no milestone to capture integration branch for
        }

        const pendingIds = state.registry
          .filter(
            (m: { status: string }) =>
              m.status !== "complete" && m.status !== "parked",
          )
          .map((m: { id: string }) => m.id);
        deps.pruneQueueOrder(s.basePath, pendingIds);
      }

      if (mid) {
        s.currentMilestoneId = mid;
        deps.setActiveMilestoneId(s.basePath, mid);
      }

      // ── Terminal conditions ──────────────────────────────────────────────

      if (!mid) {
        if (s.currentUnit) {
          await deps.closeoutUnit(
            ctx,
            s.basePath,
            s.currentUnit.type,
            s.currentUnit.id,
            s.currentUnit.startedAt,
            deps.buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id),
          );
        }

        const incomplete = state.registry.filter(
          (m: { status: string }) =>
            m.status !== "complete" && m.status !== "parked",
        );
        if (incomplete.length === 0 && state.registry.length > 0) {
          // All milestones complete — merge milestone branch before stopping
          if (s.currentMilestoneId) {
            deps.resolver.mergeAndExit(s.currentMilestoneId, ctx.ui);

            // Opt-in: create draft PR on milestone completion
            if (prefs?.git?.auto_pr) {
              try {
                const { createDraftPR } = await import("./git-service.js");
                const prUrl = createDraftPR(
                  s.basePath,
                  s.currentMilestoneId,
                  `[GSD] ${s.currentMilestoneId} complete`,
                  `Milestone ${s.currentMilestoneId} completed by GSD auto-mode.\n\nSee .gsd/${s.currentMilestoneId}/ for details.`,
                );
                if (prUrl) {
                  ctx.ui.notify(`Draft PR created: ${prUrl}`, "info");
                }
              } catch {
                // Non-fatal — PR creation is best-effort
              }
            }
          }
          deps.sendDesktopNotification(
            "GSD",
            "All milestones complete!",
            "success",
            "milestone",
          );
          deps.logCmuxEvent(
            prefs,
            "All milestones complete.",
            "success",
          );
          await deps.stopAuto(ctx, pi, "All milestones complete");
        } else if (incomplete.length === 0 && state.registry.length === 0) {
          // Empty registry — no milestones visible, likely a path resolution bug
          const diag = `basePath=${s.basePath}, phase=${state.phase}`;
          ctx.ui.notify(
            `No milestones visible in current scope. Possible path resolution issue.\n   Diagnostic: ${diag}`,
            "error",
          );
          await deps.stopAuto(
            ctx,
            pi,
            `No milestones found — check basePath resolution`,
          );
        } else if (state.phase === "blocked") {
          const blockerMsg = `Blocked: ${state.blockers.join(", ")}`;
          await deps.stopAuto(ctx, pi, blockerMsg);
          ctx.ui.notify(`${blockerMsg}. Fix and run /gsd auto.`, "warning");
          deps.sendDesktopNotification("GSD", blockerMsg, "error", "attention");
          deps.logCmuxEvent(prefs, blockerMsg, "error");
        } else {
          const ids = incomplete.map((m: { id: string }) => m.id).join(", ");
          const diag = `basePath=${s.basePath}, milestones=[${state.registry.map((m: { id: string; status: string }) => `${m.id}:${m.status}`).join(", ")}], phase=${state.phase}`;
          ctx.ui.notify(
            `Unexpected: ${incomplete.length} incomplete milestone(s) (${ids}) but no active milestone.\n   Diagnostic: ${diag}`,
            "error",
          );
          await deps.stopAuto(
            ctx,
            pi,
            `No active milestone — ${incomplete.length} incomplete (${ids}), see diagnostic above`,
          );
        }
        debugLog("autoLoop", { phase: "exit", reason: "no-active-milestone" });
        break;
      }

      if (!midTitle) {
        midTitle = mid;
        ctx.ui.notify(
          `Milestone ${mid} has no title in roadmap — using ID as fallback.`,
          "warning",
        );
      }

      // Mid-merge safety check
      if (deps.reconcileMergeState(s.basePath, ctx)) {
        deps.invalidateAllCaches();
        state = await deps.deriveState(s.basePath);
        mid = state.activeMilestone?.id;
        midTitle = state.activeMilestone?.title;
      }

      if (!mid || !midTitle) {
        const noMilestoneReason = !mid
          ? "No active milestone after merge reconciliation"
          : `Milestone ${mid} has no title after reconciliation`;
        await closeoutAndStop(ctx, pi, s, deps, noMilestoneReason);
        debugLog("autoLoop", {
          phase: "exit",
          reason: "no-milestone-after-reconciliation",
        });
        break;
      }

      // Terminal: complete
      if (state.phase === "complete") {
        // Milestone merge on complete (before closeout so branch state is clean)
        if (s.currentMilestoneId) {
          deps.resolver.mergeAndExit(s.currentMilestoneId, ctx.ui);

          // Opt-in: create draft PR on milestone completion
          if (prefs?.git?.auto_pr) {
            try {
              const { createDraftPR } = await import("./git-service.js");
              const prUrl = createDraftPR(
                s.basePath,
                s.currentMilestoneId,
                `[GSD] ${s.currentMilestoneId} complete`,
                `Milestone ${s.currentMilestoneId} completed by GSD auto-mode.\n\nSee .gsd/${s.currentMilestoneId}/ for details.`,
              );
              if (prUrl) {
                ctx.ui.notify(`Draft PR created: ${prUrl}`, "info");
              }
            } catch {
              // Non-fatal — PR creation is best-effort
            }
          }
        }
        deps.sendDesktopNotification(
          "GSD",
          `Milestone ${mid} complete!`,
          "success",
          "milestone",
        );
        deps.logCmuxEvent(
          prefs,
          `Milestone ${mid} complete.`,
          "success",
        );
        await closeoutAndStop(ctx, pi, s, deps, `Milestone ${mid} complete`);
        debugLog("autoLoop", { phase: "exit", reason: "milestone-complete" });
        break;
      }

      // Terminal: blocked
      if (state.phase === "blocked") {
        const blockerMsg = `Blocked: ${state.blockers.join(", ")}`;
        await closeoutAndStop(ctx, pi, s, deps, blockerMsg);
        ctx.ui.notify(`${blockerMsg}. Fix and run /gsd auto.`, "warning");
        deps.sendDesktopNotification("GSD", blockerMsg, "error", "attention");
        deps.logCmuxEvent(prefs, blockerMsg, "error");
        debugLog("autoLoop", { phase: "exit", reason: "blocked" });
        break;
      }

      // ── Phase 2: Guards ─────────────────────────────────────────────────

      // Budget ceiling guard
      const budgetCeiling = prefs?.budget_ceiling;
      if (budgetCeiling !== undefined && budgetCeiling > 0) {
        const currentLedger = deps.getLedger() as { units: unknown } | null;
        const totalCost = currentLedger
          ? deps.getProjectTotals(currentLedger.units).cost
          : 0;
        const budgetPct = totalCost / budgetCeiling;
        const budgetAlertLevel = deps.getBudgetAlertLevel(budgetPct);
        const newBudgetAlertLevel = deps.getNewBudgetAlertLevel(
          s.lastBudgetAlertLevel,
          budgetPct,
        );
        const enforcement = prefs?.budget_enforcement ?? "pause";
        const budgetEnforcementAction = deps.getBudgetEnforcementAction(
          enforcement,
          budgetPct,
        );

        // Data-driven threshold check — loop descending, fire first match
        const threshold = BUDGET_THRESHOLDS.find(
          (t) => newBudgetAlertLevel >= t.pct,
        );
        if (threshold) {
          s.lastBudgetAlertLevel =
            newBudgetAlertLevel as AutoSession["lastBudgetAlertLevel"];

          if (threshold.pct === 100 && budgetEnforcementAction !== "none") {
            // 100% — special enforcement logic (halt/pause/warn)
            const msg = `Budget ceiling ${deps.formatCost(budgetCeiling)} reached (spent ${deps.formatCost(totalCost)}).`;
            if (budgetEnforcementAction === "halt") {
              deps.sendDesktopNotification("GSD", msg, "error", "budget");
              await deps.stopAuto(ctx, pi, "Budget ceiling reached");
              debugLog("autoLoop", { phase: "exit", reason: "budget-halt" });
              break;
            }
            if (budgetEnforcementAction === "pause") {
              ctx.ui.notify(
                `${msg} Pausing auto-mode — /gsd auto to override and continue.`,
                "warning",
              );
              deps.sendDesktopNotification("GSD", msg, "warning", "budget");
              deps.logCmuxEvent(prefs, msg, "warning");
              await deps.pauseAuto(ctx, pi);
              debugLog("autoLoop", { phase: "exit", reason: "budget-pause" });
              break;
            }
            ctx.ui.notify(`${msg} Continuing (enforcement: warn).`, "warning");
            deps.sendDesktopNotification("GSD", msg, "warning", "budget");
            deps.logCmuxEvent(prefs, msg, "warning");
          } else if (threshold.pct < 100) {
            // Sub-100% — simple notification
            const msg = `${threshold.label}: ${deps.formatCost(totalCost)} / ${deps.formatCost(budgetCeiling)}`;
            ctx.ui.notify(msg, threshold.notifyLevel);
            deps.sendDesktopNotification(
              "GSD",
              msg,
              threshold.notifyLevel,
              "budget",
            );
            deps.logCmuxEvent(prefs, msg, threshold.cmuxLevel);
          }
        } else if (budgetAlertLevel === 0) {
          s.lastBudgetAlertLevel = 0;
        }
      } else {
        s.lastBudgetAlertLevel = 0;
      }

      // Context window guard
      const contextThreshold = prefs?.context_pause_threshold ?? 0;
      if (contextThreshold > 0 && s.cmdCtx) {
        const contextUsage = s.cmdCtx.getContextUsage();
        if (
          contextUsage &&
          contextUsage.percent !== null &&
          contextUsage.percent >= contextThreshold
        ) {
          const msg = `Context window at ${contextUsage.percent}% (threshold: ${contextThreshold}%). Pausing to prevent truncated output.`;
          ctx.ui.notify(
            `${msg} Run /gsd auto to continue (will start fresh session).`,
            "warning",
          );
          deps.sendDesktopNotification(
            "GSD",
            `Context ${contextUsage.percent}% — paused`,
            "warning",
            "attention",
          );
          await deps.pauseAuto(ctx, pi);
          debugLog("autoLoop", { phase: "exit", reason: "context-window" });
          break;
        }
      }

      // Secrets re-check gate
      try {
        const manifestStatus = await deps.getManifestStatus(s.basePath, mid, s.originalBasePath);
        if (manifestStatus && manifestStatus.pending.length > 0) {
          const result = await deps.collectSecretsFromManifest(
            s.basePath,
            mid,
            ctx,
          );
          if (
            result &&
            result.applied &&
            result.skipped &&
            result.existingSkipped
          ) {
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

      // ── Phase 3: Dispatch resolution ────────────────────────────────────

      debugLog("autoLoop", { phase: "dispatch-resolve", iteration });
      const dispatchResult = await deps.resolveDispatch({
        basePath: s.basePath,
        mid,
        midTitle: midTitle!,
        state,
        prefs,
        session: s,
      });

      if (dispatchResult.action === "stop") {
        await closeoutAndStop(ctx, pi, s, deps, dispatchResult.reason);
        debugLog("autoLoop", { phase: "exit", reason: "dispatch-stop" });
        break;
      }

      if (dispatchResult.action !== "dispatch") {
        // Non-dispatch action (e.g. "skip") — re-derive state
        await new Promise((r) => setImmediate(r));
        continue;
      }

      unitType = dispatchResult.unitType;
      unitId = dispatchResult.unitId;
      prompt = dispatchResult.prompt;
      pauseAfterUatDispatch = dispatchResult.pauseAfterDispatch ?? false;

      // ── Sliding-window stuck detection with graduated recovery ──
      const derivedKey = `${unitType}/${unitId}`;

      if (!s.pendingVerificationRetry) {
        recentUnits.push({ key: derivedKey });
        if (recentUnits.length > STUCK_WINDOW_SIZE) recentUnits.shift();

        const stuckSignal = detectStuck(recentUnits);
        if (stuckSignal) {
          debugLog("autoLoop", {
            phase: "stuck-check",
            unitType,
            unitId,
            reason: stuckSignal.reason,
            recoveryAttempts: stuckRecoveryAttempts,
          });

          if (stuckRecoveryAttempts === 0) {
            // Level 1: try verifying the artifact, then cache invalidation + retry
            stuckRecoveryAttempts++;
            const artifactExists = deps.verifyExpectedArtifact(
              unitType,
              unitId,
              s.basePath,
            );
            if (artifactExists) {
              debugLog("autoLoop", {
                phase: "stuck-recovery",
                level: 1,
                action: "artifact-found",
              });
              ctx.ui.notify(
                `Stuck recovery: artifact for ${unitType} ${unitId} found on disk. Invalidating caches.`,
                "info",
              );
              deps.invalidateAllCaches();
              continue;
            }
            ctx.ui.notify(
              `Stuck on ${unitType} ${unitId} (${stuckSignal.reason}). Invalidating caches and retrying.`,
              "warning",
            );
            deps.invalidateAllCaches();
          } else {
            // Level 2: hard stop — genuinely stuck
            debugLog("autoLoop", {
              phase: "stuck-detected",
              unitType,
              unitId,
              reason: stuckSignal.reason,
            });
            await deps.stopAuto(
              ctx,
              pi,
              `Stuck: ${stuckSignal.reason}`,
            );
            ctx.ui.notify(
              `Stuck on ${unitType} ${unitId} — ${stuckSignal.reason}. The expected artifact was not written.`,
              "error",
            );
            break;
          }
        } else {
          // Progress detected — reset recovery counter
          if (stuckRecoveryAttempts > 0) {
            debugLog("autoLoop", {
              phase: "stuck-counter-reset",
              from: recentUnits[recentUnits.length - 2]?.key ?? "",
              to: derivedKey,
            });
            stuckRecoveryAttempts = 0;
          }
        }
      }

      // Pre-dispatch hooks
      const preDispatchResult = deps.runPreDispatchHooks(
        unitType,
        unitId,
        prompt,
        s.basePath,
      );
      if (preDispatchResult.firedHooks.length > 0) {
        ctx.ui.notify(
          `Pre-dispatch hook${preDispatchResult.firedHooks.length > 1 ? "s" : ""}: ${preDispatchResult.firedHooks.join(", ")}`,
          "info",
        );
      }
      if (preDispatchResult.action === "skip") {
        ctx.ui.notify(
          `Skipping ${unitType} ${unitId} (pre-dispatch hook).`,
          "info",
        );
        await new Promise((r) => setImmediate(r));
        continue;
      }
      if (preDispatchResult.action === "replace") {
        prompt = preDispatchResult.prompt ?? prompt;
        if (preDispatchResult.unitType) unitType = preDispatchResult.unitType;
      } else if (preDispatchResult.prompt) {
        prompt = preDispatchResult.prompt;
      }

      const priorSliceBlocker = deps.getPriorSliceCompletionBlocker(
        s.basePath,
        deps.getMainBranch(s.basePath),
        unitType,
        unitId,
      );
      if (priorSliceBlocker) {
        await deps.stopAuto(ctx, pi, priorSliceBlocker);
        debugLog("autoLoop", { phase: "exit", reason: "prior-slice-blocker" });
        break;
      }

      observabilityIssues = await deps.collectObservabilityWarnings(
        ctx,
        s.basePath,
        unitType,
        unitId,
      );

      // Derive state for shared use in execution phase
      // (state, mid, midTitle already set above)

      } else {
        // ── Sidecar path: use values from the sidecar item directly ──
        unitType = sidecarItem.unitType;
        unitId = sidecarItem.unitId;
        prompt = sidecarItem.prompt;
        // Derive minimal state for progress widget / execution context
        state = await deps.deriveState(s.basePath);
        mid = state.activeMilestone?.id;
        midTitle = state.activeMilestone?.title;
      }

      // ── Phase 4: Unit execution ─────────────────────────────────────────

      debugLog("autoLoop", {
        phase: "unit-execution",
        iteration,
        unitType,
        unitId,
      });

      // Detect retry and capture previous tier for escalation
      const isRetry = !!(
        s.currentUnit &&
        s.currentUnit.type === unitType &&
        s.currentUnit.id === unitId
      );
      const previousTier = s.currentUnitRouting?.tier;

      s.currentUnit = { type: unitType, id: unitId, startedAt: Date.now() };
      deps.captureAvailableSkills();
      deps.writeUnitRuntimeRecord(
        s.basePath,
        unitType,
        unitId,
        s.currentUnit.startedAt,
        {
          phase: "dispatched",
          wrapupWarningSent: false,
          timeoutAt: null,
          lastProgressAt: s.currentUnit.startedAt,
          progressCount: 0,
          lastProgressKind: "dispatch",
        },
      );

      // Status bar + progress widget
      ctx.ui.setStatus("gsd-auto", "auto");
      if (mid)
        deps.updateSliceProgressCache(s.basePath, mid, state.activeSlice?.id);
      deps.updateProgressWidget(ctx, unitType, unitId, state);

      deps.ensurePreconditions(unitType, unitId, s.basePath, state);

      // Prompt injection
      let finalPrompt = prompt;

      if (s.pendingVerificationRetry) {
        const retryCtx = s.pendingVerificationRetry;
        s.pendingVerificationRetry = null;
        const capped =
          retryCtx.failureContext.length > MAX_RECOVERY_CHARS
            ? retryCtx.failureContext.slice(0, MAX_RECOVERY_CHARS) +
              "\n\n[...failure context truncated]"
            : retryCtx.failureContext;
        finalPrompt = `**VERIFICATION FAILED — AUTO-FIX ATTEMPT ${retryCtx.attempt}**\n\nThe verification gate ran after your previous attempt and found failures. Fix these issues before completing the task.\n\n${capped}\n\n---\n\n${finalPrompt}`;
      }

      if (s.pendingCrashRecovery) {
        const capped =
          s.pendingCrashRecovery.length > MAX_RECOVERY_CHARS
            ? s.pendingCrashRecovery.slice(0, MAX_RECOVERY_CHARS) +
              "\n\n[...recovery briefing truncated to prevent memory exhaustion]"
            : s.pendingCrashRecovery;
        finalPrompt = `${capped}\n\n---\n\n${finalPrompt}`;
        s.pendingCrashRecovery = null;
      } else if ((s.unitDispatchCount.get(`${unitType}/${unitId}`) ?? 0) > 1) {
        const diagnostic = deps.getDeepDiagnostic(s.basePath);
        if (diagnostic) {
          const cappedDiag =
            diagnostic.length > MAX_RECOVERY_CHARS
              ? diagnostic.slice(0, MAX_RECOVERY_CHARS) +
                "\n\n[...diagnostic truncated to prevent memory exhaustion]"
              : diagnostic;
          finalPrompt = `**RETRY — your previous attempt did not produce the required artifact.**\n\nDiagnostic from previous attempt:\n${cappedDiag}\n\nFix whatever went wrong and make sure you write the required file this time.\n\n---\n\n${finalPrompt}`;
        }
      }

      const repairBlock =
        deps.buildObservabilityRepairBlock(observabilityIssues);
      if (repairBlock) {
        finalPrompt = `${finalPrompt}${repairBlock}`;
      }

      // Prompt char measurement
      s.lastPromptCharCount = finalPrompt.length;
      s.lastBaselineCharCount = undefined;
      if (deps.isDbAvailable()) {
        try {
          const { inlineGsdRootFile } = await importExtensionModule<typeof import("./auto-prompts.js")>(import.meta.url, "./auto-prompts.js");
          const [decisionsContent, requirementsContent, projectContent] =
            await Promise.all([
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

      // Cache-optimize prompt section ordering
      try {
        finalPrompt = deps.reorderForCaching(finalPrompt);
      } catch (reorderErr) {
        const msg =
          reorderErr instanceof Error ? reorderErr.message : String(reorderErr);
        process.stderr.write(
          `[gsd] prompt reorder failed (non-fatal): ${msg}\n`,
        );
      }

      // Select and apply model (with tier escalation on retry — normal units only)
      const modelResult = await deps.selectAndApplyModel(
        ctx,
        pi,
        unitType,
        unitId,
        s.basePath,
        prefs,
        s.verbose,
        s.autoModeStartModel,
        sidecarItem ? undefined : { isRetry, previousTier },
      );
      s.currentUnitRouting =
        modelResult.routing as AutoSession["currentUnitRouting"];

      // Start unit supervision
      deps.clearUnitTimeout();
      deps.startUnitSupervision({
        s,
        ctx,
        pi,
        unitType,
        unitId,
        prefs,
        buildSnapshotOpts: () => deps.buildSnapshotOpts(unitType, unitId),
        buildRecoveryContext: () => ({}),
        pauseAuto: deps.pauseAuto,
      });

      // Session + send + await
      const sessionFile = deps.getSessionFile(ctx);
      deps.updateSessionLock(
        deps.lockBase(),
        unitType,
        unitId,
        s.completedUnits.length,
        sessionFile,
      );
      deps.writeLock(
        deps.lockBase(),
        unitType,
        unitId,
        s.completedUnits.length,
        sessionFile,
      );

      debugLog("autoLoop", {
        phase: "runUnit-start",
        iteration,
        unitType,
        unitId,
      });
      const unitResult = await runUnit(
        ctx,
        pi,
        s,
        unitType,
        unitId,
        finalPrompt,
      );
      debugLog("autoLoop", {
        phase: "runUnit-end",
        iteration,
        unitType,
        unitId,
        status: unitResult.status,
      });

      // Tag the most recent window entry with error info for stuck detection
      if (unitResult.status === "error" || unitResult.status === "cancelled") {
        const lastEntry = recentUnits[recentUnits.length - 1];
        if (lastEntry) {
          lastEntry.error = `${unitResult.status}:${unitType}/${unitId}`;
        }
      } else if (unitResult.event?.messages?.length) {
        const lastMsg = unitResult.event.messages[unitResult.event.messages.length - 1];
        const msgStr = typeof lastMsg === "string" ? lastMsg : JSON.stringify(lastMsg);
        if (/error|fail|exception/i.test(msgStr)) {
          const lastEntry = recentUnits[recentUnits.length - 1];
          if (lastEntry) {
            lastEntry.error = msgStr.slice(0, 200);
          }
        }
      }

      if (unitResult.status === "cancelled") {
        ctx.ui.notify(
          `Session creation timed out or was cancelled for ${unitType} ${unitId}. Will retry.`,
          "warning",
        );
        await deps.stopAuto(ctx, pi, "Session creation failed");
        debugLog("autoLoop", { phase: "exit", reason: "session-failed" });
        break;
      }

      // ── Immediate unit closeout (metrics, activity log, memory) ────────
      // Run right after runUnit() returns so telemetry is never lost to a
      // crash between iterations.
      await deps.closeoutUnit(
        ctx,
        s.basePath,
        unitType,
        unitId,
        s.currentUnit.startedAt,
        deps.buildSnapshotOpts(unitType, unitId),
      );

      if (s.currentUnitRouting) {
        deps.recordOutcome(
          unitType,
          s.currentUnitRouting.tier as "light" | "standard" | "heavy",
          true, // success assumed; dispatch will re-dispatch if artifact missing
        );
      }

      const isHookUnit = unitType.startsWith("hook/");
      const artifactVerified =
        isHookUnit ||
        deps.verifyExpectedArtifact(unitType, unitId, s.basePath);
      if (artifactVerified) {
        s.completedUnits.push({
          type: unitType,
          id: unitId,
          startedAt: s.currentUnit.startedAt,
          finishedAt: Date.now(),
        });
        if (s.completedUnits.length > 200) {
          s.completedUnits = s.completedUnits.slice(-200);
        }
        // Flush completed-units to disk so the record survives crashes
        try {
          const completedKeysPath = join(gsdRoot(s.basePath), "completed-units.json");
          const keys = s.completedUnits.map((u) => `${u.type}/${u.id}`);
          atomicWriteSync(completedKeysPath, JSON.stringify(keys, null, 2));
        } catch { /* non-fatal: disk flush failure */ }

        deps.clearUnitRuntimeRecord(s.basePath, unitType, unitId);
        s.unitDispatchCount.delete(`${unitType}/${unitId}`);
        s.unitRecoveryCount.delete(`${unitType}/${unitId}`);
      }

      // ── Phase 5: Finalize ───────────────────────────────────────────────

      debugLog("autoLoop", { phase: "finalize", iteration });

      // Clear unit timeout (unit completed)
      deps.clearUnitTimeout();

      // Post-unit context for pre/post verification
      const postUnitCtx: PostUnitContext = {
        s,
        ctx,
        pi,
        buildSnapshotOpts: deps.buildSnapshotOpts,
        lockBase: deps.lockBase,
        stopAuto: deps.stopAuto,
        pauseAuto: deps.pauseAuto,
        updateProgressWidget: deps.updateProgressWidget,
      };

      // Pre-verification processing (commit, doctor, state rebuild, etc.)
      // Sidecar items use lightweight pre-verification opts
      const preVerificationOpts: PreVerificationOpts | undefined = sidecarItem
        ? sidecarItem.kind === "hook"
          ? { skipSettleDelay: true, skipDoctor: true, skipStateRebuild: true, skipWorktreeSync: true }
          : { skipSettleDelay: true, skipStateRebuild: true }
        : undefined;
      const preResult = await deps.postUnitPreVerification(postUnitCtx, preVerificationOpts);
      if (preResult === "dispatched") {
        debugLog("autoLoop", {
          phase: "exit",
          reason: "pre-verification-dispatched",
        });
        break;
      }

      if (pauseAfterUatDispatch) {
        ctx.ui.notify(
          "UAT requires human execution. Auto-mode will pause after this unit writes the result file.",
          "info",
        );
        await deps.pauseAuto(ctx, pi);
        debugLog("autoLoop", { phase: "exit", reason: "uat-pause" });
        break;
      }

      // Verification gate
      // Hook sidecar items skip verification entirely.
      // Non-hook sidecar items run verification but skip retries (just continue).
      const skipVerification = sidecarItem?.kind === "hook";
      if (!skipVerification) {
        const verificationResult = await deps.runPostUnitVerification(
          { s, ctx, pi },
          deps.pauseAuto,
        );

        if (verificationResult === "pause") {
          debugLog("autoLoop", { phase: "exit", reason: "verification-pause" });
          break;
        }

        if (verificationResult === "retry") {
          if (sidecarItem) {
            // Sidecar verification retries are skipped — just continue
            debugLog("autoLoop", { phase: "sidecar-verification-retry-skipped", iteration });
          } else {
            // s.pendingVerificationRetry was set by runPostUnitVerification.
            // Continue the loop — next iteration will inject the retry context into the prompt.
            debugLog("autoLoop", { phase: "verification-retry", iteration });
            continue;
          }
        }
      }

      // Post-verification processing (DB dual-write, hooks, triage, quick-tasks)
      const postResult = await deps.postUnitPostVerification(postUnitCtx);

      if (postResult === "stopped") {
        debugLog("autoLoop", {
          phase: "exit",
          reason: "post-verification-stopped",
        });
        break;
      }

      if (postResult === "step-wizard") {
        // Step mode — exit the loop (caller handles wizard)
        debugLog("autoLoop", { phase: "exit", reason: "step-wizard" });
        break;
      }

      consecutiveErrors = 0; // Iteration completed successfully
      debugLog("autoLoop", { phase: "iteration-complete", iteration });
    } catch (loopErr) {
      // ── Blanket catch: absorb unexpected exceptions, apply graduated recovery ──
      consecutiveErrors++;
      const msg = loopErr instanceof Error ? loopErr.message : String(loopErr);
      debugLog("autoLoop", {
        phase: "iteration-error",
        iteration,
        consecutiveErrors,
        error: msg,
      });

      if (consecutiveErrors >= 3) {
        // 3+ consecutive: hard stop — something is fundamentally broken
        ctx.ui.notify(
          `Auto-mode stopped: ${consecutiveErrors} consecutive iteration failures. Last: ${msg}`,
          "error",
        );
        await deps.stopAuto(
          ctx,
          pi,
          `${consecutiveErrors} consecutive iteration failures`,
        );
        break;
      } else if (consecutiveErrors === 2) {
        // 2nd consecutive: try invalidating caches + re-deriving state
        ctx.ui.notify(
          `Iteration error (attempt ${consecutiveErrors}): ${msg}. Invalidating caches and retrying.`,
          "warning",
        );
        deps.invalidateAllCaches();
      } else {
        // 1st error: log and retry — transient failures happen
        ctx.ui.notify(`Iteration error: ${msg}. Retrying.`, "warning");
      }
    }
  }

  _currentResolve = null;
  debugLog("autoLoop", { phase: "exit", totalIterations: iteration });
}
