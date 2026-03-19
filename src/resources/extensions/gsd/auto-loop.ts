/**
 * auto-loop.ts — Linear loop execution backbone for auto-mode.
 *
 * Replaces the recursive dispatchNextUnit → handleAgentEnd → dispatchNextUnit
 * pattern with a while loop. The agent_end event resolves a promise instead
 * of recursing.
 *
 * MAINTENANCE RULE: Module-level mutable state is allowed here (pendingResolve)
 * because auto-loop.ts is a separate module from auto.ts. The encapsulation
 * invariant in auto-session-encapsulation.test.ts applies only to auto.ts.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@gsd/pi-coding-agent";

import type { AutoSession } from "./auto/session.js";
import { NEW_SESSION_TIMEOUT_MS, MAX_SKIP_DEPTH } from "./auto/session.js";
import type { GSDPreferences } from "./preferences.js";
import type { GSDState } from "./types.js";
import type { CloseoutOptions } from "./auto-unit-closeout.js";
import type { PostUnitContext } from "./auto-post-unit.js";
import type { VerificationContext, VerificationResult } from "./auto-verification.js";
import type { DispatchAction } from "./auto-dispatch.js";
import { debugLog } from "./debug-logger.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Minimal shape of the event parameter from pi.on("agent_end", ...).
 * The full event has more fields, but the loop only needs messages.
 */
export interface AgentEndEvent {
  messages: unknown[];
}

/**
 * Describes deferred work discovered during a unit that should be
 * queued for the sidecar (hooks, triage, quick-tasks).
 */
export interface SidecarWork {
  kind: "hook" | "triage" | "quick-task";
  payload: unknown;
}

/**
 * Result of a single unit execution (one iteration of the loop).
 */
export interface UnitResult {
  status: "completed" | "cancelled" | "error";
  event?: AgentEndEvent;
  sidecarWork?: SidecarWork[];
}

// ─── Module-level promise state ──────────────────────────────────────────────

/**
 * One-shot resolver for the current unit's agent_end promise.
 * Non-null only while a unit is in-flight (between sendMessage and agent_end).
 */
let pendingResolve: ((result: UnitResult) => void) | null = null;

// ─── resolveAgentEnd ─────────────────────────────────────────────────────────

/**
 * Called from the agent_end event handler in index.ts to resolve the
 * in-flight unit promise. One-shot: the resolver is nulled before calling
 * to prevent double-resolution from model fallback retries.
 */
export function resolveAgentEnd(event: AgentEndEvent): void {
  if (pendingResolve) {
    debugLog("resolveAgentEnd", { status: "resolving", hasEvent: true });
    const r = pendingResolve;
    pendingResolve = null;
    r({ status: "completed", event });
  } else {
    debugLog("resolveAgentEnd", {
      status: "no-pending-promise",
      warning: "orphan or double-resolution — agent_end arrived with no in-flight unit",
    });
  }
}

// ─── resetPendingResolve (test helper) ───────────────────────────────────────

/**
 * Reset module-level state. Only exported for test cleanup — production code
 * should never call this.
 */
export function _resetPendingResolve(): void {
  pendingResolve = null;
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

  // ── Create the agent_end promise ──
  const unitPromise = new Promise<UnitResult>((resolve) => {
    pendingResolve = resolve;
  });

  // ── Session creation with timeout ──
  debugLog("runUnit", { phase: "session-create", unitType, unitId });

  let sessionResult: { cancelled: boolean };
  let sessionTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const sessionPromise = s.cmdCtx!.newSession();
    const timeoutPromise = new Promise<{ cancelled: true }>((resolve) => {
      sessionTimeoutHandle = setTimeout(() => resolve({ cancelled: true }), NEW_SESSION_TIMEOUT_MS);
    });
    sessionResult = await Promise.race([sessionPromise, timeoutPromise]);
  } catch (sessionErr) {
    if (sessionTimeoutHandle) clearTimeout(sessionTimeoutHandle);
    const msg = sessionErr instanceof Error ? sessionErr.message : String(sessionErr);
    debugLog("runUnit", { phase: "session-error", unitType, unitId, error: msg });
    // Clean up the pending promise — nobody will resolve it
    pendingResolve = null;
    return { status: "cancelled" };
  }
  if (sessionTimeoutHandle) clearTimeout(sessionTimeoutHandle);

  if (sessionResult.cancelled) {
    debugLog("runUnit-session-timeout", { unitType, unitId });
    // Clean up the pending promise — nobody will resolve it
    pendingResolve = null;
    return { status: "cancelled" };
  }

  // ── Send the prompt ──
  debugLog("runUnit", { phase: "send-message", unitType, unitId });

  if (!s.active) {
    pendingResolve = null;
    return { status: "cancelled" };
  }

  pi.sendMessage(
    { customType: "gsd-auto", content: prompt, display: s.verbose },
    { triggerTurn: true },
  );

  // ── Await agent_end ──
  debugLog("runUnit", { phase: "awaiting-agent-end", unitType, unitId });
  const result = await unitPromise;
  debugLog("runUnit", { phase: "agent-end-received", unitType, unitId, status: result.status });

  return result;
}

// ─── LoopDeps ────────────────────────────────────────────────────────────────

/**
 * Dependencies injected by the caller (auto.ts startAuto) so autoLoop
 * can access private functions from auto.ts without exporting them.
 */
export interface LoopDeps {
  lockBase: () => string;
  buildSnapshotOpts: (unitType: string, unitId: string) => CloseoutOptions & Record<string, unknown>;
  stopAuto: (ctx?: ExtensionContext, pi?: ExtensionAPI, reason?: string) => Promise<void>;
  pauseAuto: (ctx?: ExtensionContext, pi?: ExtensionAPI) => Promise<void>;
  clearUnitTimeout: () => void;
  updateProgressWidget: (ctx: ExtensionContext, unitType: string, unitId: string, state: GSDState) => void;
  startDispatchGapWatchdog: (ctx: ExtensionContext, pi: ExtensionAPI) => void;

  // State and cache functions
  invalidateAllCaches: () => void;
  deriveState: (basePath: string) => Promise<GSDState>;
  loadEffectiveGSDPreferences: () => { preferences?: GSDPreferences } | undefined;

  // Pre-dispatch health gate
  preDispatchHealthGate: (basePath: string) => Promise<{ proceed: boolean; reason?: string; fixesApplied: string[] }>;

  // Worktree sync
  syncProjectRootToWorktree: (originalBase: string, basePath: string, milestoneId: string | null) => void;

  // Resource version guard
  checkResourcesStale: (version: string | null) => string | null;

  // Milestone transition functions
  sendDesktopNotification: (title: string, body: string, kind: string, category: string) => void;
  setActiveMilestoneId: (basePath: string, mid: string) => void;
  pruneQueueOrder: (basePath: string, pendingIds: string[]) => void;
  isInAutoWorktree: (basePath: string) => boolean;
  shouldUseWorktreeIsolation: () => boolean;
  mergeMilestoneToMain: (basePath: string, milestoneId: string, roadmapContent: string) => { pushed: boolean };
  teardownAutoWorktree: (basePath: string, milestoneId: string) => void;
  createAutoWorktree: (basePath: string, milestoneId: string) => string;
  captureIntegrationBranch: (basePath: string, mid: string | undefined, opts?: { commitDocs?: boolean }) => void;
  getIsolationMode: () => string;
  getCurrentBranch: (basePath: string) => string;
  autoWorktreeBranch: (milestoneId: string) => string;
  resolveMilestoneFile: (basePath: string, milestoneId: string, fileType: string) => string | null;
  completedKeysPath: (basePath: string) => string;
  reconcileMergeState: (basePath: string, ctx: ExtensionContext) => boolean;

  // Budget/context/secrets
  getLedger: () => unknown;
  getProjectTotals: (units: unknown) => { cost: number };
  formatCost: (cost: number) => string;
  getBudgetAlertLevel: (pct: number) => number;
  getNewBudgetAlertLevel: (lastLevel: number, pct: number) => number;
  getBudgetEnforcementAction: (enforcement: string, pct: number) => string;
  getManifestStatus: (basePath: string, mid: string | undefined) => Promise<{ pending: unknown[] } | null>;
  collectSecretsFromManifest: (basePath: string, mid: string | undefined, ctx: ExtensionContext) => Promise<{ applied: unknown[]; skipped: unknown[]; existingSkipped: unknown[] } | null>;

  // Dispatch
  resolveDispatch: (dctx: { basePath: string; mid: string; midTitle: string; state: GSDState; prefs: GSDPreferences | undefined }) => Promise<DispatchAction>;
  runPreDispatchHooks: (unitType: string, unitId: string, prompt: string, basePath: string) => { firedHooks: string[]; action: string; prompt?: string; unitType?: string };
  getPriorSliceCompletionBlocker: (basePath: string, mainBranch: string, unitType: string, unitId: string) => string | null;
  getMainBranch: (basePath: string) => string;
  collectObservabilityWarnings: (ctx: ExtensionContext, basePath: string, unitType: string, unitId: string) => Promise<unknown[]>;
  buildObservabilityRepairBlock: (issues: unknown[]) => string | null;

  // Idempotency + stuck detection
  checkIdempotency: (ictx: { s: AutoSession; unitType: string; unitId: string; basePath: string; notify: (msg: string, level: string) => void }) => { action: string; reason?: string };
  checkStuckAndRecover: (sctx: { s: AutoSession; ctx: ExtensionContext; unitType: string; unitId: string; basePath: string; buildSnapshotOpts: () => CloseoutOptions & Record<string, unknown> }) => Promise<{ action: string; reason?: string; notifyMessage?: string; dispatchAgain?: boolean }>;

  // Unit closeout + runtime records
  closeoutUnit: (ctx: ExtensionContext, basePath: string, unitType: string, unitId: string, startedAt: number, opts?: CloseoutOptions & Record<string, unknown>) => Promise<void>;
  verifyExpectedArtifact: (unitType: string, unitId: string, basePath: string) => boolean;
  persistCompletedKey: (basePath: string, key: string) => void;
  clearUnitRuntimeRecord: (basePath: string, unitType: string, unitId: string) => void;
  writeUnitRuntimeRecord: (basePath: string, unitType: string, unitId: string, startedAt: number, record: Record<string, unknown>) => void;
  recordOutcome: (unitType: string, tier: string, success: boolean) => void;
  writeLock: (lockBase: string, unitType: string, unitId: string, completedCount: number, sessionFile?: string) => void;
  captureAvailableSkills: () => void;
  ensurePreconditions: (unitType: string, unitId: string, basePath: string, state: GSDState) => void;
  updateSliceProgressCache: (basePath: string, mid: string, sliceId?: string) => void;

  // Model selection + supervision
  selectAndApplyModel: (ctx: ExtensionContext, pi: ExtensionAPI, unitType: string, unitId: string, basePath: string, prefs: GSDPreferences | undefined, verbose: boolean, startModel: { provider: string; id: string } | null) => Promise<{ routing: { tier: string; modelDowngraded: boolean } | null }>;
  startUnitSupervision: (sctx: { s: AutoSession; ctx: ExtensionContext; pi: ExtensionAPI; unitType: string; unitId: string; prefs: GSDPreferences | undefined; buildSnapshotOpts: () => CloseoutOptions & Record<string, unknown>; buildRecoveryContext: () => unknown; pauseAuto: (ctx?: ExtensionContext, pi?: ExtensionAPI) => Promise<void> }) => void;

  // Prompt helpers
  getDeepDiagnostic: (basePath: string) => string | null;
  isDbAvailable: () => boolean;
  reorderForCaching: (prompt: string) => string;

  // Filesystem
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: string) => string;
  atomicWriteSync: (path: string, content: string) => void;

  // Git
  GitServiceImpl: new (basePath: string, gitConfig: Record<string, unknown>) => unknown;

  // Post-unit processing
  postUnitPreVerification: (pctx: PostUnitContext) => Promise<"dispatched" | "continue">;
  runPostUnitVerification: (vctx: VerificationContext, dispatchNextUnit: (ctx: ExtensionContext, pi: ExtensionAPI) => Promise<void>, startDispatchGapWatchdog: (ctx: ExtensionContext, pi: ExtensionAPI) => void, pauseAuto: (ctx?: ExtensionContext, pi?: ExtensionAPI) => Promise<void>) => Promise<VerificationResult>;
  postUnitPostVerification: (pctx: PostUnitContext) => Promise<"dispatched" | "continue" | "step-wizard" | "stopped">;

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
  let iteration = 0;

  while (s.active) {
    iteration++;
    debugLog("autoLoop", { phase: "loop-top", iteration });

    if (!s.cmdCtx) {
      debugLog("autoLoop", { phase: "exit", reason: "no-cmdCtx" });
      break;
    }

    // ── Phase 1: Pre-dispatch ───────────────────────────────────────────

    // Reentrancy guard (skip depth)
    if (s.skipDepth > MAX_SKIP_DEPTH) {
      s.skipDepth = 0;
      ctx.ui.notify(`Skipped ${MAX_SKIP_DEPTH}+ completed units. Yielding to UI before continuing.`, "info");
      await new Promise(r => setTimeout(r, 200));
    }

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
        ctx.ui.notify(`Pre-dispatch: ${healthGate.fixesApplied.join(", ")}`, "info");
      }
      if (!healthGate.proceed) {
        ctx.ui.notify(healthGate.reason ?? "Pre-dispatch health check failed.", "error");
        await deps.pauseAuto(ctx, pi);
        debugLog("autoLoop", { phase: "exit", reason: "health-gate-failed" });
        break;
      }
    } catch {
      // Non-fatal
    }

    // Sync project root artifacts into worktree
    if (s.originalBasePath && s.basePath !== s.originalBasePath && s.currentMilestoneId) {
      deps.syncProjectRootToWorktree(s.originalBasePath, s.basePath, s.currentMilestoneId);
    }

    // Derive state
    let state = await deps.deriveState(s.basePath);
    let mid = state.activeMilestone?.id;
    let midTitle = state.activeMilestone?.title;
    debugLog("autoLoop", { phase: "state-derived", iteration, mid, phase: state.phase });

    // ── Milestone transition ────────────────────────────────────────────
    if (mid && s.currentMilestoneId && mid !== s.currentMilestoneId) {
      ctx.ui.notify(
        `Milestone ${s.currentMilestoneId} complete. Advancing to ${mid}: ${midTitle}.`,
        "info",
      );
      deps.sendDesktopNotification("GSD", `Milestone ${s.currentMilestoneId} complete!`, "success", "milestone");

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
          const completedMs = snapData.milestones.find((m: { id: string }) => m.id === s.currentMilestoneId);
          const msTitle = completedMs?.title ?? s.currentMilestoneId;
          const gsdVersion = process.env.GSD_VERSION ?? "0.0.0";
          const projName = basename(s.basePath);
          const doneSlices = snapData.milestones.reduce((acc: number, m: { slices: { done: boolean }[] }) => acc + m.slices.filter((sl: { done: boolean }) => sl.done).length, 0);
          const totalSlices = snapData.milestones.reduce((acc: number, m: { slices: unknown[] }) => acc + m.slices.length, 0);
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
            doneMilestones: snapData.milestones.filter((m: { status: string }) => m.status === "complete").length,
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

      // Reset stuck detection for new milestone
      s.unitDispatchCount.clear();
      s.unitRecoveryCount.clear();
      s.unitConsecutiveSkips.clear();
      s.unitLifetimeDispatches.clear();
      try {
        const file = deps.completedKeysPath(s.basePath);
        if (deps.existsSync(file)) {
          deps.atomicWriteSync(file, JSON.stringify([]));
        }
        s.completedKeySet.clear();
      } catch (e) {
        debugLog("completed-keys-reset-failed", { error: e instanceof Error ? e.message : String(e) });
      }

      // Worktree lifecycle on milestone transition
      if (deps.isInAutoWorktree(s.basePath) && s.originalBasePath && deps.shouldUseWorktreeIsolation()) {
        try {
          const roadmapPath = deps.resolveMilestoneFile(s.originalBasePath, s.currentMilestoneId!, "ROADMAP");
          if (roadmapPath) {
            const roadmapContent = deps.readFileSync(roadmapPath, "utf-8");
            const mergeResult = deps.mergeMilestoneToMain(s.originalBasePath, s.currentMilestoneId!, roadmapContent);
            ctx.ui.notify(
              `Milestone ${s.currentMilestoneId} merged to main.${mergeResult.pushed ? " Pushed to remote." : ""}`,
              "info",
            );
          } else {
            deps.teardownAutoWorktree(s.originalBasePath, s.currentMilestoneId!);
            ctx.ui.notify(`Exited worktree for ${s.currentMilestoneId} (no roadmap for merge).`, "info");
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
        s.gitService = new deps.GitServiceImpl(s.basePath, deps.loadEffectiveGSDPreferences()?.preferences?.git ?? {}) as AutoSession["gitService"];
        deps.invalidateAllCaches();

        state = await deps.deriveState(s.basePath);
        mid = state.activeMilestone?.id;
        midTitle = state.activeMilestone?.title;

        if (mid) {
          deps.captureIntegrationBranch(s.basePath, mid, { commitDocs: deps.loadEffectiveGSDPreferences()?.preferences?.git?.commit_docs });
          try {
            const wtPath = deps.createAutoWorktree(s.basePath, mid);
            s.basePath = wtPath;
            s.gitService = new deps.GitServiceImpl(s.basePath, deps.loadEffectiveGSDPreferences()?.preferences?.git ?? {}) as AutoSession["gitService"];
            ctx.ui.notify(`Created auto-worktree for ${mid} at ${wtPath}`, "info");
          } catch (err) {
            ctx.ui.notify(
              `Auto-worktree creation for ${mid} failed: ${err instanceof Error ? err.message : String(err)}. Continuing in project root.`,
              "warning",
            );
          }
        }
      } else {
        if (deps.getIsolationMode() !== "none") {
          deps.captureIntegrationBranch(s.originalBasePath || s.basePath, mid, { commitDocs: deps.loadEffectiveGSDPreferences()?.preferences?.git?.commit_docs });
        }
      }

      const pendingIds = state.registry
        .filter((m: { status: string }) => m.status !== "complete")
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
        await deps.closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, deps.buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id));
      }

      const incomplete = state.registry.filter((m: { status: string }) => m.status !== "complete");
      if (incomplete.length === 0) {
        // All milestones complete — merge milestone branch before stopping
        if (s.currentMilestoneId && deps.isInAutoWorktree(s.basePath) && s.originalBasePath) {
          try {
            const roadmapPath = deps.resolveMilestoneFile(s.originalBasePath, s.currentMilestoneId, "ROADMAP");
            if (roadmapPath) {
              const roadmapContent = deps.readFileSync(roadmapPath, "utf-8");
              const mergeResult = deps.mergeMilestoneToMain(s.originalBasePath, s.currentMilestoneId, roadmapContent);
              s.basePath = s.originalBasePath;
              s.gitService = new deps.GitServiceImpl(s.basePath, deps.loadEffectiveGSDPreferences()?.preferences?.git ?? {}) as AutoSession["gitService"];
              ctx.ui.notify(
                `Milestone ${s.currentMilestoneId} merged to main.${mergeResult.pushed ? " Pushed to remote." : ""}`,
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
        } else if (s.currentMilestoneId && !deps.isInAutoWorktree(s.basePath) && deps.getIsolationMode() !== "none") {
          try {
            const currentBranch = deps.getCurrentBranch(s.basePath);
            const milestoneBranch = deps.autoWorktreeBranch(s.currentMilestoneId);
            if (currentBranch === milestoneBranch) {
              const roadmapPath = deps.resolveMilestoneFile(s.basePath, s.currentMilestoneId, "ROADMAP");
              if (roadmapPath) {
                const roadmapContent = deps.readFileSync(roadmapPath, "utf-8");
                const mergeResult = deps.mergeMilestoneToMain(s.basePath, s.currentMilestoneId, roadmapContent);
                s.gitService = new deps.GitServiceImpl(s.basePath, deps.loadEffectiveGSDPreferences()?.preferences?.git ?? {}) as AutoSession["gitService"];
                ctx.ui.notify(
                  `Milestone ${s.currentMilestoneId} merged (branch mode).${mergeResult.pushed ? " Pushed to remote." : ""}`,
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
        deps.sendDesktopNotification("GSD", "All milestones complete!", "success", "milestone");
        await deps.stopAuto(ctx, pi, "All milestones complete");
      } else if (state.phase === "blocked") {
        const blockerMsg = `Blocked: ${state.blockers.join(", ")}`;
        await deps.stopAuto(ctx, pi, blockerMsg);
        ctx.ui.notify(`${blockerMsg}. Fix and run /gsd auto.`, "warning");
        deps.sendDesktopNotification("GSD", blockerMsg, "error", "attention");
      } else {
        const ids = incomplete.map((m: { id: string }) => m.id).join(", ");
        const diag = `basePath=${s.basePath}, milestones=[${state.registry.map((m: { id: string; status: string }) => `${m.id}:${m.status}`).join(", ")}], phase=${state.phase}`;
        ctx.ui.notify(`Unexpected: ${incomplete.length} incomplete milestone(s) (${ids}) but no active milestone.\n   Diagnostic: ${diag}`, "error");
        await deps.stopAuto(ctx, pi, `No active milestone — ${incomplete.length} incomplete (${ids}), see diagnostic above`);
      }
      debugLog("autoLoop", { phase: "exit", reason: "no-active-milestone" });
      break;
    }

    if (!midTitle) {
      midTitle = mid;
      ctx.ui.notify(`Milestone ${mid} has no title in roadmap — using ID as fallback.`, "warning");
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
        await deps.closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, deps.buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id));
      }
      const noMilestoneReason = !mid
        ? "No active milestone after merge reconciliation"
        : `Milestone ${mid} has no title after reconciliation`;
      await deps.stopAuto(ctx, pi, noMilestoneReason);
      debugLog("autoLoop", { phase: "exit", reason: "no-milestone-after-reconciliation" });
      break;
    }

    // Terminal: complete
    if (state.phase === "complete") {
      if (s.currentUnit) {
        await deps.closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, deps.buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id));
      }
      try {
        const file = deps.completedKeysPath(s.basePath);
        if (deps.existsSync(file)) {
          deps.atomicWriteSync(file, JSON.stringify([]));
        }
        s.completedKeySet.clear();
      } catch (e) {
        debugLog("completed-keys-reset-failed", { error: e instanceof Error ? e.message : String(e) });
      }
      // Milestone merge on complete
      if (s.currentMilestoneId && deps.isInAutoWorktree(s.basePath) && s.originalBasePath) {
        try {
          const roadmapPath = deps.resolveMilestoneFile(s.originalBasePath, s.currentMilestoneId, "ROADMAP");
          if (!roadmapPath) throw new Error(`Cannot resolve ROADMAP file for milestone ${s.currentMilestoneId}`);
          const roadmapContent = deps.readFileSync(roadmapPath, "utf-8");
          const mergeResult = deps.mergeMilestoneToMain(s.originalBasePath, s.currentMilestoneId, roadmapContent);
          s.basePath = s.originalBasePath;
          s.gitService = new deps.GitServiceImpl(s.basePath, deps.loadEffectiveGSDPreferences()?.preferences?.git ?? {}) as AutoSession["gitService"];
          ctx.ui.notify(
            `Milestone ${s.currentMilestoneId} merged to main.${mergeResult.pushed ? " Pushed to remote." : ""}`,
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
      } else if (s.currentMilestoneId && !deps.isInAutoWorktree(s.basePath) && deps.getIsolationMode() !== "none") {
        try {
          const currentBranch = deps.getCurrentBranch(s.basePath);
          const milestoneBranch = deps.autoWorktreeBranch(s.currentMilestoneId);
          if (currentBranch === milestoneBranch) {
            const roadmapPath = deps.resolveMilestoneFile(s.basePath, s.currentMilestoneId, "ROADMAP");
            if (roadmapPath) {
              const roadmapContent = deps.readFileSync(roadmapPath, "utf-8");
              const mergeResult = deps.mergeMilestoneToMain(s.basePath, s.currentMilestoneId, roadmapContent);
              s.gitService = new deps.GitServiceImpl(s.basePath, deps.loadEffectiveGSDPreferences()?.preferences?.git ?? {}) as AutoSession["gitService"];
              ctx.ui.notify(
                `Milestone ${s.currentMilestoneId} merged (branch mode).${mergeResult.pushed ? " Pushed to remote." : ""}`,
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
      deps.sendDesktopNotification("GSD", `Milestone ${mid} complete!`, "success", "milestone");
      await deps.stopAuto(ctx, pi, `Milestone ${mid} complete`);
      debugLog("autoLoop", { phase: "exit", reason: "milestone-complete" });
      break;
    }

    // Terminal: blocked
    if (state.phase === "blocked") {
      if (s.currentUnit) {
        await deps.closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, deps.buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id));
      }
      const blockerMsg = `Blocked: ${state.blockers.join(", ")}`;
      await deps.stopAuto(ctx, pi, blockerMsg);
      ctx.ui.notify(`${blockerMsg}. Fix and run /gsd auto.`, "warning");
      deps.sendDesktopNotification("GSD", blockerMsg, "error", "attention");
      debugLog("autoLoop", { phase: "exit", reason: "blocked" });
      break;
    }

    // ── Phase 2: Guards ─────────────────────────────────────────────────

    const prefs = deps.loadEffectiveGSDPreferences()?.preferences;

    // Budget ceiling guard
    const budgetCeiling = prefs?.budget_ceiling;
    if (budgetCeiling !== undefined && budgetCeiling > 0) {
      const currentLedger = deps.getLedger() as { units: unknown } | null;
      const totalCost = currentLedger ? deps.getProjectTotals(currentLedger.units).cost : 0;
      const budgetPct = totalCost / budgetCeiling;
      const budgetAlertLevel = deps.getBudgetAlertLevel(budgetPct);
      const newBudgetAlertLevel = deps.getNewBudgetAlertLevel(s.lastBudgetAlertLevel, budgetPct);
      const enforcement = prefs?.budget_enforcement ?? "pause";
      const budgetEnforcementAction = deps.getBudgetEnforcementAction(enforcement, budgetPct);

      if (newBudgetAlertLevel === 100 && budgetEnforcementAction !== "none") {
        const msg = `Budget ceiling ${deps.formatCost(budgetCeiling)} reached (spent ${deps.formatCost(totalCost)}).`;
        s.lastBudgetAlertLevel = newBudgetAlertLevel as AutoSession["lastBudgetAlertLevel"];
        if (budgetEnforcementAction === "halt") {
          deps.sendDesktopNotification("GSD", msg, "error", "budget");
          await deps.stopAuto(ctx, pi, "Budget ceiling reached");
          debugLog("autoLoop", { phase: "exit", reason: "budget-halt" });
          break;
        }
        if (budgetEnforcementAction === "pause") {
          ctx.ui.notify(`${msg} Pausing auto-mode — /gsd auto to override and continue.`, "warning");
          deps.sendDesktopNotification("GSD", msg, "warning", "budget");
          await deps.pauseAuto(ctx, pi);
          debugLog("autoLoop", { phase: "exit", reason: "budget-pause" });
          break;
        }
        ctx.ui.notify(`${msg} Continuing (enforcement: warn).`, "warning");
        deps.sendDesktopNotification("GSD", msg, "warning", "budget");
      } else if (newBudgetAlertLevel === 90) {
        s.lastBudgetAlertLevel = newBudgetAlertLevel as AutoSession["lastBudgetAlertLevel"];
        ctx.ui.notify(`Budget 90%: ${deps.formatCost(totalCost)} / ${deps.formatCost(budgetCeiling)}`, "warning");
        deps.sendDesktopNotification("GSD", `Budget 90%: ${deps.formatCost(totalCost)} / ${deps.formatCost(budgetCeiling)}`, "warning", "budget");
      } else if (newBudgetAlertLevel === 80) {
        s.lastBudgetAlertLevel = newBudgetAlertLevel as AutoSession["lastBudgetAlertLevel"];
        ctx.ui.notify(`Approaching budget ceiling — 80%: ${deps.formatCost(totalCost)} / ${deps.formatCost(budgetCeiling)}`, "warning");
        deps.sendDesktopNotification("GSD", `Approaching budget ceiling — 80%: ${deps.formatCost(totalCost)} / ${deps.formatCost(budgetCeiling)}`, "warning", "budget");
      } else if (newBudgetAlertLevel === 75) {
        s.lastBudgetAlertLevel = newBudgetAlertLevel as AutoSession["lastBudgetAlertLevel"];
        ctx.ui.notify(`Budget 75%: ${deps.formatCost(totalCost)} / ${deps.formatCost(budgetCeiling)}`, "info");
        deps.sendDesktopNotification("GSD", `Budget 75%: ${deps.formatCost(totalCost)} / ${deps.formatCost(budgetCeiling)}`, "info", "budget");
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
      if (contextUsage && contextUsage.percent !== null && contextUsage.percent >= contextThreshold) {
        const msg = `Context window at ${contextUsage.percent}% (threshold: ${contextThreshold}%). Pausing to prevent truncated output.`;
        ctx.ui.notify(`${msg} Run /gsd auto to continue (will start fresh session).`, "warning");
        deps.sendDesktopNotification("GSD", `Context ${contextUsage.percent}% — paused`, "warning", "attention");
        await deps.pauseAuto(ctx, pi);
        debugLog("autoLoop", { phase: "exit", reason: "context-window" });
        break;
      }
    }

    // Secrets re-check gate
    try {
      const manifestStatus = await deps.getManifestStatus(s.basePath, mid);
      if (manifestStatus && manifestStatus.pending.length > 0) {
        const result = await deps.collectSecretsFromManifest(s.basePath, mid, ctx);
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

    // ── Phase 3: Dispatch resolution ────────────────────────────────────

    debugLog("autoLoop", { phase: "dispatch-resolve", iteration });
    const dispatchResult = await deps.resolveDispatch({
      basePath: s.basePath, mid, midTitle: midTitle!, state, prefs,
    });

    if (dispatchResult.action === "stop") {
      if (s.currentUnit) {
        await deps.closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, deps.buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id));
      }
      await deps.stopAuto(ctx, pi, dispatchResult.reason);
      debugLog("autoLoop", { phase: "exit", reason: "dispatch-stop" });
      break;
    }

    if (dispatchResult.action !== "dispatch") {
      // Non-dispatch action (e.g. "skip") — re-derive state
      await new Promise(r => setImmediate(r));
      continue;
    }

    let unitType = dispatchResult.unitType;
    let unitId = dispatchResult.unitId;
    let prompt = dispatchResult.prompt;
    const pauseAfterUatDispatch = dispatchResult.pauseAfterDispatch ?? false;

    // Pre-dispatch hooks
    const preDispatchResult = deps.runPreDispatchHooks(unitType, unitId, prompt, s.basePath);
    if (preDispatchResult.firedHooks.length > 0) {
      ctx.ui.notify(
        `Pre-dispatch hook${preDispatchResult.firedHooks.length > 1 ? "s" : ""}: ${preDispatchResult.firedHooks.join(", ")}`,
        "info",
      );
    }
    if (preDispatchResult.action === "skip") {
      ctx.ui.notify(`Skipping ${unitType} ${unitId} (pre-dispatch hook).`, "info");
      await new Promise(r => setImmediate(r));
      continue;
    }
    if (preDispatchResult.action === "replace") {
      prompt = preDispatchResult.prompt ?? prompt;
      if (preDispatchResult.unitType) unitType = preDispatchResult.unitType;
    } else if (preDispatchResult.prompt) {
      prompt = preDispatchResult.prompt;
    }

    const priorSliceBlocker = deps.getPriorSliceCompletionBlocker(s.basePath, deps.getMainBranch(s.basePath), unitType, unitId);
    if (priorSliceBlocker) {
      await deps.stopAuto(ctx, pi, priorSliceBlocker);
      debugLog("autoLoop", { phase: "exit", reason: "prior-slice-blocker" });
      break;
    }

    const observabilityIssues = await deps.collectObservabilityWarnings(ctx, s.basePath, unitType, unitId);

    // Idempotency check
    const idempotencyResult = deps.checkIdempotency({
      s,
      unitType,
      unitId,
      basePath: s.basePath,
      notify: (msg: string, level: string) => ctx.ui.notify(msg, level as "info" | "warning" | "error"),
    });

    if (idempotencyResult.action === "skip") {
      if (idempotencyResult.reason === "completed" || idempotencyResult.reason === "fallback-persisted" || idempotencyResult.reason === "phantom-loop-cleared" || idempotencyResult.reason === "evicted") {
        if (!s.active) break;
        s.skipDepth++;
        await new Promise(r => setTimeout(r, idempotencyResult.reason === "phantom-loop-cleared" ? 50 : 150));
        continue;
      }
    } else if (idempotencyResult.action === "stop") {
      await deps.stopAuto(ctx, pi, idempotencyResult.reason);
      ctx.ui.notify(
        `Hard loop detected: ${unitType} ${unitId} hit lifetime cap during skip cycle.`,
        "error",
      );
      debugLog("autoLoop", { phase: "exit", reason: "idempotency-stop" });
      break;
    }
    // "rerun" and "proceed" fall through to stuck detection

    // Stuck detection
    const stuckResult = await deps.checkStuckAndRecover({
      s,
      ctx,
      unitType,
      unitId,
      basePath: s.basePath,
      buildSnapshotOpts: () => deps.buildSnapshotOpts(unitType, unitId),
    });

    if (stuckResult.action === "stop") {
      await deps.stopAuto(ctx, pi, stuckResult.reason);
      if (stuckResult.notifyMessage) {
        ctx.ui.notify(stuckResult.notifyMessage, "error");
      }
      debugLog("autoLoop", { phase: "exit", reason: "stuck-stop" });
      break;
    }
    if (stuckResult.action === "recovered" && stuckResult.dispatchAgain) {
      await new Promise(r => setImmediate(r));
      continue;
    }

    // ── Phase 4: Unit execution ─────────────────────────────────────────

    debugLog("autoLoop", { phase: "unit-execution", iteration, unitType, unitId });

    // Closeout previous unit
    if (s.currentUnit) {
      await deps.closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, deps.buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id));

      if (s.currentUnitRouting) {
        const isRetry = s.currentUnit.type === unitType && s.currentUnit.id === unitId;
        deps.recordOutcome(
          s.currentUnit.type,
          s.currentUnitRouting.tier as "light" | "standard" | "heavy",
          !isRetry,
        );
      }

      const closeoutKey = `${s.currentUnit.type}/${s.currentUnit.id}`;
      const incomingKey = `${unitType}/${unitId}`;
      const isHookUnit = s.currentUnit.type.startsWith("hook/");
      const artifactVerified = isHookUnit || deps.verifyExpectedArtifact(s.currentUnit.type, s.currentUnit.id, s.basePath);
      if (closeoutKey !== incomingKey && artifactVerified) {
        if (!isHookUnit) {
          deps.persistCompletedKey(s.basePath, closeoutKey);
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
        deps.clearUnitRuntimeRecord(s.basePath, s.currentUnit.type, s.currentUnit.id);
        s.unitDispatchCount.delete(`${s.currentUnit.type}/${s.currentUnit.id}`);
        s.unitRecoveryCount.delete(`${s.currentUnit.type}/${s.currentUnit.id}`);
      }
    }

    s.currentUnit = { type: unitType, id: unitId, startedAt: Date.now() };
    deps.captureAvailableSkills();
    deps.writeUnitRuntimeRecord(s.basePath, unitType, unitId, s.currentUnit.startedAt, {
      phase: "dispatched",
      wrapupWarningSent: false,
      timeoutAt: null,
      lastProgressAt: s.currentUnit.startedAt,
      progressCount: 0,
      lastProgressKind: "dispatch",
    });

    // Status bar + progress widget
    ctx.ui.setStatus("gsd-auto", "auto");
    if (mid) deps.updateSliceProgressCache(s.basePath, mid, state.activeSlice?.id);
    deps.updateProgressWidget(ctx, unitType, unitId, state);

    deps.ensurePreconditions(unitType, unitId, s.basePath, state);

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
      const diagnostic = deps.getDeepDiagnostic(s.basePath);
      if (diagnostic) {
        const cappedDiag = diagnostic.length > MAX_RECOVERY_CHARS
          ? diagnostic.slice(0, MAX_RECOVERY_CHARS) + "\n\n[...diagnostic truncated to prevent memory exhaustion]"
          : diagnostic;
        finalPrompt = `**RETRY — your previous attempt did not produce the required artifact.**\n\nDiagnostic from previous attempt:\n${cappedDiag}\n\nFix whatever went wrong and make sure you write the required file this time.\n\n---\n\n${finalPrompt}`;
      }
    }

    const repairBlock = deps.buildObservabilityRepairBlock(observabilityIssues);
    if (repairBlock) {
      finalPrompt = `${finalPrompt}${repairBlock}`;
    }

    // Prompt char measurement
    s.lastPromptCharCount = finalPrompt.length;
    s.lastBaselineCharCount = undefined;
    if (deps.isDbAvailable()) {
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

    // Cache-optimize prompt section ordering
    try {
      finalPrompt = deps.reorderForCaching(finalPrompt);
    } catch (reorderErr) {
      const msg = reorderErr instanceof Error ? reorderErr.message : String(reorderErr);
      process.stderr.write(`[gsd] prompt reorder failed (non-fatal): ${msg}\n`);
    }

    // Select and apply model
    const modelResult = await deps.selectAndApplyModel(ctx, pi, unitType, unitId, s.basePath, prefs, s.verbose, s.autoModeStartModel);
    s.currentUnitRouting = modelResult.routing as AutoSession["currentUnitRouting"];

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
    deps.writeLock(deps.lockBase(), unitType, unitId, s.completedUnits.length, sessionFile);

    debugLog("autoLoop", { phase: "runUnit-start", iteration, unitType, unitId });
    const unitResult = await runUnit(ctx, pi, s, unitType, unitId, finalPrompt, prefs);
    debugLog("autoLoop", { phase: "runUnit-end", iteration, unitType, unitId, status: unitResult.status });

    if (unitResult.status === "cancelled") {
      ctx.ui.notify(
        `Session creation timed out or was cancelled for ${unitType} ${unitId}. Will retry.`,
        "warning",
      );
      await deps.stopAuto(ctx, pi, "Session creation failed");
      debugLog("autoLoop", { phase: "exit", reason: "session-failed" });
      break;
    }

    // Handle UAT pause
    if (pauseAfterUatDispatch) {
      ctx.ui.notify(
        "UAT requires human execution. Auto-mode will pause after this unit writes the result file.",
        "info",
      );
      await deps.pauseAuto(ctx, pi);
      debugLog("autoLoop", { phase: "exit", reason: "uat-pause" });
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
      debugLog("autoLoop", { phase: "exit", reason: "pre-verification-dispatched" });
      break;
    }

    // Verification gate — pass a no-op dispatchNextUnit (the loop handles retries)
    const noopDispatch = async () => {};
    const verificationResult = await deps.runPostUnitVerification(
      { s, ctx, pi },
      noopDispatch,
      deps.startDispatchGapWatchdog,
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
      debugLog("autoLoop", { phase: "exit", reason: "post-verification-stopped" });
      break;
    }

    if (postResult === "step-wizard") {
      // Step mode — exit the loop (caller handles wizard)
      debugLog("autoLoop", { phase: "exit", reason: "step-wizard" });
      break;
    }

    if (postResult === "dispatched") {
      // An inline unit (hook/triage/quick-task) was dispatched via pi.sendMessage
      // inside postUnitPostVerification. We must await its completion before continuing.
      debugLog("autoLoop", { phase: "await-inline-dispatch", iteration });

      let inlineResult = postResult;
      while (inlineResult === "dispatched") {
        // Create a new promise for the inline unit's agent_end
        const inlinePromise = new Promise<UnitResult>((resolve) => {
          pendingResolve = resolve;
        });
        const inlineUnitResult = await inlinePromise;
        debugLog("autoLoop", {
          phase: "inline-unit-complete",
          iteration,
          status: inlineUnitResult.status,
        });

        // Clear timeout for the inline unit
        deps.clearUnitTimeout();

        // Run pre-verification for the inline unit
        const inlinePreResult = await deps.postUnitPreVerification(postUnitCtx);
        if (inlinePreResult === "dispatched") {
          // Pre-verification caused stop/pause
          debugLog("autoLoop", { phase: "exit", reason: "inline-pre-verification-dispatched" });
          break;
        }

        // Run post-verification for the inline unit
        inlineResult = await deps.postUnitPostVerification(postUnitCtx);
        if (inlineResult === "stopped") {
          debugLog("autoLoop", { phase: "exit", reason: "inline-stopped" });
          break;
        }
        if (inlineResult === "step-wizard") {
          debugLog("autoLoop", { phase: "exit", reason: "inline-step-wizard" });
          break;
        }
        // If "dispatched", loop again to await the next inline unit
        // If "continue", fall through to the outer loop's next iteration
      }

      if (inlineResult === "stopped" || inlineResult === "step-wizard") {
        break;
      }
      // "continue" from inline chain — fall through to next outer loop iteration
    }

    debugLog("autoLoop", { phase: "iteration-complete", iteration });
  }

  debugLog("autoLoop", { phase: "exit", totalIterations: iteration });
}
