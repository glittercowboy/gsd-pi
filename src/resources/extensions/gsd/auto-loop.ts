/**
 * auto-loop.ts — Linear loop execution backbone for auto-mode.
 *
 * Replaces the recursive dispatchNextUnit → handleAgentEnd → dispatchNextUnit
 * pattern with a while loop. The agent_end event resolves a promise instead
 * of recursing.
 *
 * MAINTENANCE RULE: The only module-level mutable state here is `_activeSession`,
 * used by the agent_end bridge. Promise state itself lives on AutoSession so
 * concurrent auto sessions cannot corrupt each other.
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

import type { AutoSession } from "./auto/session.js";
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
import type { CmuxLogLevel } from "../cmux/index.js";

/**
 * Maximum total loop iterations before forced stop. Prevents runaway loops
 * when units alternate IDs (bypassing the same-unit stuck detector).
 * A milestone with 20 slices × 5 tasks × 3 phases ≈ 300 units. 500 gives
 * generous headroom including retries and sidecar work.
 */
const MAX_LOOP_ITERATIONS = 500;

/** Data-driven budget threshold notifications (75/80/90%). The 100% case is
 *  handled inline because it requires break/pause/stop control flow. */
const BUDGET_THRESHOLDS: Array<{
  pct: number;
  label: string;
  notifyLevel: "info" | "warning";
  cmuxLevel: "progress" | "warning";
}> = [
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

// ─── Session-scoped promise state ───────────────────────────────────────────
//
// pendingResolve and pendingAgentEndQueue live on AutoSession (not module-level)
// so concurrent sessions cannot corrupt each other's promises.

/**
 * The singleton session reference used by resolveAgentEnd. Set by autoLoop
 * on entry so that the agent_end handler in index.ts can resolve the correct
 * session's promise without needing a direct reference to `s`.
 */
let _activeSession: AutoSession | null = null;

// ─── resolveAgentEnd ─────────────────────────────────────────────────────────

/**
 * Called from the agent_end event handler in index.ts to resolve the
 * in-flight unit promise. One-shot: the resolver is nulled before calling
 * to prevent double-resolution from model fallback retries.
 *
 * If no pendingResolve exists (event arrived between loop iterations),
 * the event is queued on the session so the next runUnit can drain it.
 */
export function resolveAgentEnd(event: AgentEndEvent): void {
  const s = _activeSession;
  if (!s) {
    debugLog("resolveAgentEnd", {
      status: "no-active-session",
      warning: "agent_end with no active loop session",
    });
    return;
  }

  if (s.pendingResolve) {
    debugLog("resolveAgentEnd", { status: "resolving", hasEvent: true });
    const r = s.pendingResolve;
    s.pendingResolve = null;
    r({ status: "completed", event });
  } else {
    // Queue the event so the next runUnit picks it up immediately
    debugLog("resolveAgentEnd", {
      status: "queued",
      queueLength: s.pendingAgentEndQueue.length + 1,
      unitId: s.currentUnit?.id,
      warning:
        "agent_end arrived between loop iterations — queued for next runUnit",
    });
    s.pendingAgentEndQueue.push({ ...event, unitId: s.currentUnit?.id });
  }
}

export function isSessionSwitchInFlight(): boolean {
  return _activeSession?.sessionSwitchInFlight ?? false;
}

// ─── resetPendingResolve (test helper) ───────────────────────────────────────

/**
 * Reset session promise state. Only exported for test cleanup — production code
 * should never call this.
 */
export function _resetPendingResolve(): void {
  if (_activeSession) {
    _activeSession.pendingResolve = null;
    _activeSession.pendingAgentEndQueue = [];
  }
  _activeSession = null;
}

/**
 * Set the active session for resolveAgentEnd. Only exported for test setup —
 * production code sets this via autoLoop entry.
 */
export function _setActiveSession(session: AutoSession | null): void {
  _activeSession = session;
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
  _prefs: GSDPreferences | undefined,
): Promise<UnitResult> {
  debugLog("runUnit", { phase: "start", unitType, unitId });

  // ── Drain queued events from error-recovery retries ──
  // If an agent_end arrived between iterations (e.g. from a model fallback
  // sendMessage retry), consume it immediately instead of creating a new promise.
  // Cap queue to 3 entries to prevent unbounded growth from stale events.
  if (s.pendingAgentEndQueue.length > 3) {
    debugLog("runUnit", {
      phase: "queue-overflow",
      dropped: s.pendingAgentEndQueue.length - 1,
      unitType,
      unitId,
    });
    s.pendingAgentEndQueue = [
      s.pendingAgentEndQueue[s.pendingAgentEndQueue.length - 1]!,
    ];
  }
  if (s.pendingAgentEndQueue.length > 0) {
    // Find an event matching this unit; discard stale events from other units
    const matchIdx = s.pendingAgentEndQueue.findIndex(
      (e) => !e.unitId || e.unitId === unitId,
    );
    if (matchIdx >= 0) {
      // Discard any stale events before the match
      if (matchIdx > 0) {
        debugLog("runUnit", {
          phase: "discarded-stale-events",
          count: matchIdx,
          unitType,
          unitId,
        });
      }
      const queued = s.pendingAgentEndQueue.splice(0, matchIdx + 1).pop()!;
      debugLog("runUnit", {
        phase: "drained-queued-event",
        unitType,
        unitId,
        queueRemaining: s.pendingAgentEndQueue.length,
      });
      return { status: "completed", event: queued };
    }
    // No matching event — discard all stale events and proceed to new session
    debugLog("runUnit", {
      phase: "discarded-all-stale-events",
      count: s.pendingAgentEndQueue.length,
      unitType,
      unitId,
    });
    s.pendingAgentEndQueue = [];
  }

  // ── Session creation with timeout ──
  debugLog("runUnit", { phase: "session-create", unitType, unitId });

  let sessionResult: { cancelled: boolean };
  let sessionTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  s.sessionSwitchInFlight = true;
  try {
    const sessionPromise = s.cmdCtx!.newSession().finally(() => {
      s.sessionSwitchInFlight = false;
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

  // ── Create the agent_end promise (session-scoped) ──
  // This happens after newSession completes so session-switch agent_end events
  // from the previous session cannot resolve the new unit.
  const unitPromise = new Promise<UnitResult>((resolve) => {
    s.pendingResolve = resolve;
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
  _activeSession = s;
  let iteration = 0;
  let lastDerivedUnit = "";
  let sameUnitCount = 0;

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
      let state = await deps.deriveState(s.basePath);
      deps.syncCmuxSidebar(deps.loadEffectiveGSDPreferences()?.preferences, state);
      let mid = state.activeMilestone?.id;
      let midTitle = state.activeMilestone?.title;
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
          deps.loadEffectiveGSDPreferences()?.preferences,
          `Milestone ${s.currentMilestoneId} complete. Advancing to ${mid}.`,
          "success",
        );

        const vizPrefs = deps.loadEffectiveGSDPreferences()?.preferences;
        if (vizPrefs?.auto_visualize) {
          ctx.ui.notify("Run /gsd visualize to see progress overview.", "info");
        }
        if (vizPrefs?.auto_report !== false) {
          try {
            const { loadVisualizerData } = await import("./visualizer-data.js");
            const { generateHtmlReport } = await import("./export-html.js");
            const { writeReportSnapshot } = await import("./reports.js");
            const { basename } = await import("node:path");
            const snapData = await loadVisualizerData(s.basePath);
            const completedMs = snapData.milestones.find(
              (m: { id: string }) => m.id === s.currentMilestoneId,
            );
            const msTitle = completedMs?.title ?? s.currentMilestoneId;
            const gsdVersion = process.env.GSD_VERSION ?? "0.0.0";
            const projName = basename(s.basePath);
            const doneSlices = snapData.milestones.reduce(
              (acc: number, m: { slices: { done: boolean }[] }) =>
                acc +
                m.slices.filter((sl: { done: boolean }) => sl.done).length,
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
                milestoneId: s.currentMilestoneId,
                indexRelPath: "index.html",
              }),
              milestoneId: s.currentMilestoneId!,
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
              `Report saved: .gsd/reports/${(await import("node:path")).basename(outPath)} — open index.html to browse progression.`,
              "info",
            );
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
        lastDerivedUnit = "";
        sameUnitCount = 0;

        // Worktree lifecycle on milestone transition — merge current, enter next
        deps.resolver.mergeAndExit(s.currentMilestoneId!, ctx.ui);
        deps.invalidateAllCaches();

        state = await deps.deriveState(s.basePath);
        mid = state.activeMilestone?.id;
        midTitle = state.activeMilestone?.title;

        if (mid) {
          if (deps.getIsolationMode() !== "none") {
            deps.captureIntegrationBranch(s.basePath, mid, {
              commitDocs:
                deps.loadEffectiveGSDPreferences()?.preferences?.git
                  ?.commit_docs,
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
          }
          deps.sendDesktopNotification(
            "GSD",
            "All milestones complete!",
            "success",
            "milestone",
          );
          deps.logCmuxEvent(
            deps.loadEffectiveGSDPreferences()?.preferences,
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
          deps.logCmuxEvent(deps.loadEffectiveGSDPreferences()?.preferences, blockerMsg, "error");
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
        const noMilestoneReason = !mid
          ? "No active milestone after merge reconciliation"
          : `Milestone ${mid} has no title after reconciliation`;
        await deps.stopAuto(ctx, pi, noMilestoneReason);
        debugLog("autoLoop", {
          phase: "exit",
          reason: "no-milestone-after-reconciliation",
        });
        break;
      }

      // Terminal: complete
      if (state.phase === "complete") {
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
        // Milestone merge on complete
        if (s.currentMilestoneId) {
          deps.resolver.mergeAndExit(s.currentMilestoneId, ctx.ui);
        }
        deps.sendDesktopNotification(
          "GSD",
          `Milestone ${mid} complete!`,
          "success",
          "milestone",
        );
        deps.logCmuxEvent(
          deps.loadEffectiveGSDPreferences()?.preferences,
          `Milestone ${mid} complete.`,
          "success",
        );
        await deps.stopAuto(ctx, pi, `Milestone ${mid} complete`);
        debugLog("autoLoop", { phase: "exit", reason: "milestone-complete" });
        break;
      }

      // Terminal: blocked
      if (state.phase === "blocked") {
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
        const blockerMsg = `Blocked: ${state.blockers.join(", ")}`;
        await deps.stopAuto(ctx, pi, blockerMsg);
        ctx.ui.notify(`${blockerMsg}. Fix and run /gsd auto.`, "warning");
        deps.sendDesktopNotification("GSD", blockerMsg, "error", "attention");
        deps.logCmuxEvent(deps.loadEffectiveGSDPreferences()?.preferences, blockerMsg, "error");
        debugLog("autoLoop", { phase: "exit", reason: "blocked" });
        break;
      }

      // ── Phase 2: Guards ─────────────────────────────────────────────────

      const prefs = deps.loadEffectiveGSDPreferences()?.preferences;

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

        if (newBudgetAlertLevel === 100 && budgetEnforcementAction !== "none") {
          const msg = `Budget ceiling ${deps.formatCost(budgetCeiling)} reached (spent ${deps.formatCost(totalCost)}).`;
          s.lastBudgetAlertLevel =
            newBudgetAlertLevel as AutoSession["lastBudgetAlertLevel"];
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
        } else {
          // Data-driven 75/80/90% threshold notifications
          const threshold = BUDGET_THRESHOLDS.find(
            (t) => newBudgetAlertLevel === t.pct,
          );
          if (threshold) {
            s.lastBudgetAlertLevel =
              newBudgetAlertLevel as AutoSession["lastBudgetAlertLevel"];
            const msg = `${threshold.label}: ${deps.formatCost(totalCost)} / ${deps.formatCost(budgetCeiling)}`;
            ctx.ui.notify(msg, threshold.notifyLevel);
            deps.sendDesktopNotification(
              "GSD",
              msg,
              threshold.notifyLevel,
              "budget",
            );
            deps.logCmuxEvent(prefs, msg, threshold.cmuxLevel);
          } else if (budgetAlertLevel === 0) {
            s.lastBudgetAlertLevel = 0;
          }
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
        await deps.stopAuto(ctx, pi, dispatchResult.reason);
        debugLog("autoLoop", { phase: "exit", reason: "dispatch-stop" });
        break;
      }

      if (dispatchResult.action !== "dispatch") {
        // Non-dispatch action (e.g. "skip") — re-derive state
        await new Promise((r) => setImmediate(r));
        continue;
      }

      let unitType = dispatchResult.unitType;
      let unitId = dispatchResult.unitId;
      let prompt = dispatchResult.prompt;
      const pauseAfterUatDispatch = dispatchResult.pauseAfterDispatch ?? false;

      // ── Same-unit stuck counter with graduated recovery ──
      const derivedKey = `${unitType}/${unitId}`;
      if (derivedKey === lastDerivedUnit && !s.pendingVerificationRetry) {
        sameUnitCount++;
        debugLog("autoLoop", {
          phase: "stuck-check",
          unitType,
          unitId,
          sameUnitCount,
        });

        if (sameUnitCount === 3) {
          // Level 1: try verifying the artifact — maybe it was written but not detected
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
            `Stuck on ${unitType} ${unitId} (attempt ${sameUnitCount}). Invalidating caches and retrying.`,
            "warning",
          );
          deps.invalidateAllCaches();
        } else if (sameUnitCount === 5) {
          // Level 2: hard stop — genuinely stuck
          debugLog("autoLoop", {
            phase: "stuck-detected",
            unitType,
            unitId,
            sameUnitCount,
          });
          await deps.stopAuto(
            ctx,
            pi,
            `Stuck: ${unitType} ${unitId} derived ${sameUnitCount} consecutive times without progress`,
          );
          ctx.ui.notify(
            `Stuck on ${unitType} ${unitId} — deriveState returns the same unit after ${sameUnitCount} attempts. The expected artifact was not written.`,
            "error",
          );
          break;
        }
      } else {
        if (derivedKey !== lastDerivedUnit) {
          debugLog("autoLoop", {
            phase: "stuck-counter-reset",
            from: lastDerivedUnit,
            to: derivedKey,
          });
        }
        lastDerivedUnit = derivedKey;
        sameUnitCount = 0;
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

      const observabilityIssues = await deps.collectObservabilityWarnings(
        ctx,
        s.basePath,
        unitType,
        unitId,
      );

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

      // Closeout previous unit
      if (s.currentUnit) {
        await deps.closeoutUnit(
          ctx,
          s.basePath,
          s.currentUnit.type,
          s.currentUnit.id,
          s.currentUnit.startedAt,
          deps.buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id),
        );

        if (s.currentUnitRouting) {
          const isRetry =
            s.currentUnit.type === unitType && s.currentUnit.id === unitId;
          deps.recordOutcome(
            s.currentUnit.type,
            s.currentUnitRouting.tier as "light" | "standard" | "heavy",
            !isRetry,
          );
        }

        const closeoutKey = `${s.currentUnit.type}/${s.currentUnit.id}`;
        const incomingKey = `${unitType}/${unitId}`;
        const isHookUnit = s.currentUnit.type.startsWith("hook/");
        const artifactVerified =
          isHookUnit ||
          deps.verifyExpectedArtifact(
            s.currentUnit.type,
            s.currentUnit.id,
            s.basePath,
          );
        if (closeoutKey !== incomingKey && artifactVerified) {
          s.completedUnits.push({
            type: s.currentUnit.type,
            id: s.currentUnit.id,
            startedAt: s.currentUnit.startedAt,
            finishedAt: Date.now(),
          });
          if (s.completedUnits.length > 200) {
            s.completedUnits = s.completedUnits.slice(-200);
          }
          deps.clearUnitRuntimeRecord(
            s.basePath,
            s.currentUnit.type,
            s.currentUnit.id,
          );
          s.unitDispatchCount.delete(
            `${s.currentUnit.type}/${s.currentUnit.id}`,
          );
          s.unitRecoveryCount.delete(
            `${s.currentUnit.type}/${s.currentUnit.id}`,
          );
        }
      }

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
      const MAX_RECOVERY_CHARS = 50_000;
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
          const { inlineGsdRootFile } = await import("./auto-prompts.js");
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

      // Select and apply model (with tier escalation on retry)
      const modelResult = await deps.selectAndApplyModel(
        ctx,
        pi,
        unitType,
        unitId,
        s.basePath,
        prefs,
        s.verbose,
        s.autoModeStartModel,
        { isRetry, previousTier },
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
        prefs,
      );
      debugLog("autoLoop", {
        phase: "runUnit-end",
        iteration,
        unitType,
        unitId,
        status: unitResult.status,
      });

      if (unitResult.status === "cancelled") {
        ctx.ui.notify(
          `Session creation timed out or was cancelled for ${unitType} ${unitId}. Will retry.`,
          "warning",
        );
        await deps.stopAuto(ctx, pi, "Session creation failed");
        debugLog("autoLoop", { phase: "exit", reason: "session-failed" });
        break;
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
      const preResult = await deps.postUnitPreVerification(postUnitCtx);
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

      // Verification gate — the loop handles retries via s.pendingVerificationRetry
      const verificationResult = await deps.runPostUnitVerification(
        { s, ctx, pi },
        deps.pauseAuto,
      );

      if (verificationResult === "pause") {
        debugLog("autoLoop", { phase: "exit", reason: "verification-pause" });
        break;
      }

      if (verificationResult === "retry") {
        // s.pendingVerificationRetry was set by runPostUnitVerification.
        // Continue the loop — next iteration will inject the retry context into the prompt.
        debugLog("autoLoop", { phase: "verification-retry", iteration });
        continue;
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

      // ── Sidecar drain: dispatch enqueued hooks/triage/quick-tasks ──
      let sidecarBroke = false;
      while (s.sidecarQueue.length > 0 && s.active) {
        const item = s.sidecarQueue.shift()!;
        debugLog("autoLoop", {
          phase: "sidecar-dequeue",
          kind: item.kind,
          unitType: item.unitType,
          unitId: item.unitId,
        });

        // Set up as current unit
        const sidecarStartedAt = Date.now();
        s.currentUnit = {
          type: item.unitType,
          id: item.unitId,
          startedAt: sidecarStartedAt,
        };
        deps.writeUnitRuntimeRecord(
          s.basePath,
          item.unitType,
          item.unitId,
          sidecarStartedAt,
          {
            phase: "dispatched",
            wrapupWarningSent: false,
            timeoutAt: null,
            lastProgressAt: sidecarStartedAt,
            progressCount: 0,
            lastProgressKind: "dispatch",
          },
        );

        // Model selection (handles hook model override)
        await deps.selectAndApplyModel(
          ctx,
          pi,
          item.unitType,
          item.unitId,
          s.basePath,
          prefs,
          s.verbose,
          s.autoModeStartModel,
        );

        // Supervision
        deps.clearUnitTimeout();
        deps.startUnitSupervision({
          s,
          ctx,
          pi,
          unitType: item.unitType,
          unitId: item.unitId,
          prefs,
          buildSnapshotOpts: () =>
            deps.buildSnapshotOpts(item.unitType, item.unitId),
          buildRecoveryContext: () => ({}),
          pauseAuto: deps.pauseAuto,
        });

        // Write lock
        const sidecarSessionFile = deps.getSessionFile(ctx);
        deps.writeLock(
          deps.lockBase(),
          item.unitType,
          item.unitId,
          s.completedUnits.length,
          sidecarSessionFile,
        );

        // Execute via standard runUnit
        const sidecarResult = await runUnit(
          ctx,
          pi,
          s,
          item.unitType,
          item.unitId,
          item.prompt,
          prefs,
        );
        deps.clearUnitTimeout();

        if (sidecarResult.status === "cancelled") {
          ctx.ui.notify(
            `Sidecar unit ${item.unitType} ${item.unitId} session cancelled. Stopping.`,
            "warning",
          );
          await deps.stopAuto(ctx, pi, "Sidecar session creation failed");
          sidecarBroke = true;
          break;
        }

        // Run pre-verification for the sidecar unit (lightweight path)
        const sidecarPreOpts: PreVerificationOpts = item.kind === "hook"
          ? { skipSettleDelay: true, skipDoctor: true, skipStateRebuild: true, skipWorktreeSync: true }
          : { skipSettleDelay: true, skipStateRebuild: true };
        const sidecarPreResult =
          await deps.postUnitPreVerification(postUnitCtx, sidecarPreOpts);
        if (sidecarPreResult === "dispatched") {
          // Pre-verification caused stop/pause
          debugLog("autoLoop", {
            phase: "exit",
            reason: "sidecar-pre-verification-stop",
          });
          sidecarBroke = true;
          break;
        }

        // Verification gate for non-hook sidecar units (triage, quick-tasks)
        // Hook units are lightweight and don't need verification.
        if (item.kind !== "hook") {
          const sidecarVerification = await deps.runPostUnitVerification(
            { s, ctx, pi },
            deps.pauseAuto,
          );
          if (sidecarVerification === "pause") {
            debugLog("autoLoop", {
              phase: "exit",
              reason: "sidecar-verification-pause",
            });
            sidecarBroke = true;
            break;
          }
          // "retry" for sidecars — skip retry, just continue (sidecar retries are not worth the complexity)
        }

        // Post-verification (may enqueue more sidecar items)
        const sidecarPostResult =
          await deps.postUnitPostVerification(postUnitCtx);
        if (sidecarPostResult === "stopped") {
          debugLog("autoLoop", { phase: "exit", reason: "sidecar-stopped" });
          sidecarBroke = true;
          break;
        }
        if (sidecarPostResult === "step-wizard") {
          debugLog("autoLoop", {
            phase: "exit",
            reason: "sidecar-step-wizard",
          });
          sidecarBroke = true;
          break;
        }
        // "continue" — loop checks sidecarQueue again
      }

      if (sidecarBroke) break;

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

  _activeSession = null;
  debugLog("autoLoop", { phase: "exit", totalIterations: iteration });
}
