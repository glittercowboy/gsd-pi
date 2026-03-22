/**
 * auto/phases.ts — Pipeline phases for the auto-loop.
 *
 * Contains: runPreDispatch, runDispatch, runGuards, runUnitPhase, runFinalize,
 * plus internal helpers generateMilestoneReport and closeoutAndStop.
 *
 * Imports from: auto/types, auto/detect-stuck, auto/run-unit, auto/loop-deps
 */

import { importExtensionModule, type ExtensionAPI, type ExtensionContext } from "@gsd/pi-coding-agent";

import type { AutoSession, SidecarItem } from "./session.js";
import type { LoopDeps } from "./loop-deps.js";
import type { PostUnitContext, PreVerificationOpts } from "../auto-post-unit.js";
import {
  MAX_RECOVERY_CHARS,
  BUDGET_THRESHOLDS,
  type PhaseResult,
  type IterationContext,
  type LoopState,
  type PreDispatchData,
  type IterationData,
} from "./types.js";
import { detectStuck } from "./detect-stuck.js";
import { runUnit } from "./run-unit.js";
import { debugLog } from "../debug-logger.js";
import { gsdRoot } from "../paths.js";
import { atomicWriteSync } from "../atomic-write.js";
import { PROJECT_FILES } from "../detection.js";
import { join } from "node:path";

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
  const { loadVisualizerData } = await importExtensionModule<typeof import("../visualizer-data.js")>(import.meta.url, "../visualizer-data.js");
  const { generateHtmlReport } = await importExtensionModule<typeof import("../export-html.js")>(import.meta.url, "../export-html.js");
  const { writeReportSnapshot } = await importExtensionModule<typeof import("../reports.js")>(import.meta.url, "../reports.js");
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

// ─── runPreDispatch ───────────────────────────────────────────────────────────

/**
 * Phase 1: Pre-dispatch — resource guard, health gate, state derivation,
 * milestone transition, terminal conditions.
 * Returns break to exit the loop, or next with PreDispatchData on success.
 */
export async function runPreDispatch(
  ic: IterationContext,
  loopState: LoopState,
): Promise<PhaseResult<PreDispatchData>> {
  const { ctx, pi, s, deps, prefs } = ic;

  // Resource version guard
  const staleMsg = deps.checkResourcesStale(s.resourceVersionOnStart);
  if (staleMsg) {
    await deps.stopAuto(ctx, pi, staleMsg);
    debugLog("autoLoop", { phase: "exit", reason: "resources-stale" });
    return { action: "break", reason: "resources-stale" };
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
      return { action: "break", reason: "health-gate-failed" };
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
  deps.syncCmuxSidebar(prefs, state);
  let mid = state.activeMilestone?.id;
  let midTitle = state.activeMilestone?.title;
  debugLog("autoLoop", {
    phase: "state-derived",
    iteration: ic.iteration,
    mid,
    statePhase: state.phase,
  });

  // ── Milestone transition ────────────────────────────────────────────
  if (mid && s.currentMilestoneId && mid !== s.currentMilestoneId) {
    deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "milestone-transition", data: { from: s.currentMilestoneId, to: mid } });
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
    loopState.recentUnits.length = 0;
    loopState.stuckRecoveryAttempts = 0;

    // Worktree lifecycle on milestone transition — merge current, enter next
    deps.resolver.mergeAndExit(s.currentMilestoneId!, ctx.ui);

    // Opt-in: create draft PR on milestone completion
    if (prefs?.git?.auto_pr) {
      try {
        const { createDraftPR } = await import("../git-service.js");
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

    // Reset completed-units tracking for the new milestone — stale entries
    // from the previous milestone cause the dispatch loop to skip units
    // that haven't actually been completed in the new milestone's context.
    s.completedUnits = [];
    try {
      const completedKeysPath = join(gsdRoot(s.basePath), "completed-units.json");
      atomicWriteSync(completedKeysPath, JSON.stringify([], null, 2));
    } catch { /* non-fatal */ }

    // Rebuild STATE.md immediately so it reflects the new active milestone.
    // This bypasses the 30-second throttle in the normal rebuild path —
    // milestone transitions are rare and important enough to warrant an
    // immediate write.
    try {
      await deps.rebuildState(s.basePath);
    } catch {
      // Non-fatal — STATE.md will be rebuilt on the next regular cycle
    }
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
            const { createDraftPR } = await import("../git-service.js");
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
    deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "terminal", data: { reason: "no-active-milestone" } });
    return { action: "break", reason: "no-active-milestone" };
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
    return { action: "break", reason: "no-milestone-after-reconciliation" };
  }

  // Terminal: complete
  if (state.phase === "complete") {
    // Milestone merge on complete (before closeout so branch state is clean)
    if (s.currentMilestoneId) {
      deps.resolver.mergeAndExit(s.currentMilestoneId, ctx.ui);

      // Opt-in: create draft PR on milestone completion
      if (prefs?.git?.auto_pr) {
        try {
          const { createDraftPR } = await import("../git-service.js");
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
    deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "terminal", data: { reason: "milestone-complete", milestoneId: mid } });
    return { action: "break", reason: "milestone-complete" };
  }

  // Terminal: blocked
  if (state.phase === "blocked") {
    const blockerMsg = `Blocked: ${state.blockers.join(", ")}`;
    await closeoutAndStop(ctx, pi, s, deps, blockerMsg);
    ctx.ui.notify(`${blockerMsg}. Fix and run /gsd auto.`, "warning");
    deps.sendDesktopNotification("GSD", blockerMsg, "error", "attention");
    deps.logCmuxEvent(prefs, blockerMsg, "error");
    debugLog("autoLoop", { phase: "exit", reason: "blocked" });
    deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "terminal", data: { reason: "blocked", blockers: state.blockers } });
    return { action: "break", reason: "blocked" };
  }

  return { action: "next", data: { state, mid, midTitle } };
}

// ─── runDispatch ──────────────────────────────────────────────────────────────

/**
 * Phase 3: Dispatch resolution — resolve next unit, stuck detection, pre-dispatch hooks.
 * Returns break/continue to control the loop, or next with IterationData on success.
 */
export async function runDispatch(
  ic: IterationContext,
  preData: PreDispatchData,
  loopState: LoopState,
): Promise<PhaseResult<IterationData>> {
  const { ctx, pi, s, deps, prefs } = ic;
  const { state, mid, midTitle } = preData;
  const STUCK_WINDOW_SIZE = 6;

  debugLog("autoLoop", { phase: "dispatch-resolve", iteration: ic.iteration });
  const dispatchResult = await deps.resolveDispatch({
    basePath: s.basePath,
    mid,
    midTitle,
    state,
    prefs,
    session: s,
  });

  if (dispatchResult.action === "stop") {
    deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "dispatch-stop", rule: dispatchResult.matchedRule, data: { reason: dispatchResult.reason } });
    await closeoutAndStop(ctx, pi, s, deps, dispatchResult.reason);
    debugLog("autoLoop", { phase: "exit", reason: "dispatch-stop" });
    return { action: "break", reason: "dispatch-stop" };
  }

  if (dispatchResult.action !== "dispatch") {
    // Non-dispatch action (e.g. "skip") — re-derive state
    await new Promise((r) => setImmediate(r));
    return { action: "continue" };
  }

  deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "dispatch-match", rule: dispatchResult.matchedRule, data: { unitType: dispatchResult.unitType, unitId: dispatchResult.unitId } });

  let unitType = dispatchResult.unitType;
  let unitId = dispatchResult.unitId;
  let prompt = dispatchResult.prompt;
  const pauseAfterUatDispatch = dispatchResult.pauseAfterDispatch ?? false;

  // ── Sliding-window stuck detection with graduated recovery ──
  const derivedKey = `${unitType}/${unitId}`;

  if (!s.pendingVerificationRetry) {
    loopState.recentUnits.push({ key: derivedKey });
    if (loopState.recentUnits.length > STUCK_WINDOW_SIZE) loopState.recentUnits.shift();

    const stuckSignal = detectStuck(loopState.recentUnits);
    if (stuckSignal) {
      debugLog("autoLoop", {
        phase: "stuck-check",
        unitType,
        unitId,
        reason: stuckSignal.reason,
        recoveryAttempts: loopState.stuckRecoveryAttempts,
      });

      if (loopState.stuckRecoveryAttempts === 0) {
        // Level 1: try verifying the artifact, then cache invalidation + retry
        loopState.stuckRecoveryAttempts++;
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
          return { action: "continue" };
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
        return { action: "break", reason: "stuck-detected" };
      }
    } else {
      // Progress detected — reset recovery counter
      if (loopState.stuckRecoveryAttempts > 0) {
        debugLog("autoLoop", {
          phase: "stuck-counter-reset",
          from: loopState.recentUnits[loopState.recentUnits.length - 2]?.key ?? "",
          to: derivedKey,
        });
        loopState.stuckRecoveryAttempts = 0;
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
    deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "pre-dispatch-hook", data: { firedHooks: preDispatchResult.firedHooks, action: preDispatchResult.action } });
  }
  if (preDispatchResult.action === "skip") {
    ctx.ui.notify(
      `Skipping ${unitType} ${unitId} (pre-dispatch hook).`,
      "info",
    );
    await new Promise((r) => setImmediate(r));
    return { action: "continue" };
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
    return { action: "break", reason: "prior-slice-blocker" };
  }

  const observabilityIssues = await deps.collectObservabilityWarnings(
    ctx,
    s.basePath,
    unitType,
    unitId,
  );

  return {
    action: "next",
    data: {
      unitType, unitId, prompt, finalPrompt: prompt,
      pauseAfterUatDispatch, observabilityIssues,
      state, mid, midTitle,
      isRetry: false, previousTier: undefined,
      hookModelOverride: preDispatchResult.model,
    },
  };
}

// ─── runGuards ────────────────────────────────────────────────────────────────

/**
 * Phase 2: Guards — budget ceiling, context window, secrets re-check.
 * Returns break to exit the loop, or next to proceed to dispatch.
 */
export async function runGuards(
  ic: IterationContext,
  mid: string,
): Promise<PhaseResult> {
  const { ctx, pi, s, deps, prefs } = ic;

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
          return { action: "break", reason: "budget-halt" };
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
          return { action: "break", reason: "budget-pause" };
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
      return { action: "break", reason: "context-window" };
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

  return { action: "next", data: undefined as void };
}

// ─── runUnitPhase ─────────────────────────────────────────────────────────────

/**
 * Phase 4: Unit execution — dispatch prompt, await agent_end, closeout, artifact verify.
 * Returns break or next with unitStartedAt for downstream phases.
 */
export async function runUnitPhase(
  ic: IterationContext,
  iterData: IterationData,
  loopState: LoopState,
  sidecarItem?: SidecarItem,
): Promise<PhaseResult<{ unitStartedAt: number }>> {
  const { ctx, pi, s, deps, prefs } = ic;
  const { unitType, unitId, prompt, observabilityIssues, state, mid } = iterData;

  debugLog("autoLoop", {
    phase: "unit-execution",
    iteration: ic.iteration,
    unitType,
    unitId,
  });

  // ── Worktree health check (#1833, #1843) ────────────────────────────
  // Verify the working directory is a valid git checkout with project
  // files before dispatching work. A broken worktree causes agents to
  // hallucinate summaries since they cannot read or write any files.
  // Uses the shared PROJECT_FILES list from detection.ts to support all
  // ecosystems (Rust, Go, Python, Java, etc.), not just JS.
  if (s.basePath && unitType === "execute-task") {
    const gitMarker = join(s.basePath, ".git");
    const hasGit = deps.existsSync(gitMarker);
    if (!hasGit) {
      const msg = `Worktree health check failed: ${s.basePath} has no .git — refusing to dispatch ${unitType} ${unitId}`;
      debugLog("runUnitPhase", { phase: "worktree-health-fail", basePath: s.basePath, hasGit });
      ctx.ui.notify(msg, "error");
      await deps.stopAuto(ctx, pi, msg);
      return { action: "break", reason: "worktree-invalid" };
    }
    const hasProjectFile = PROJECT_FILES.some((f) => deps.existsSync(join(s.basePath, f)));
    const hasSrcDir = deps.existsSync(join(s.basePath, "src"));
    if (!hasProjectFile && !hasSrcDir) {
      const msg = `Worktree health check failed: ${s.basePath} has no recognized project files — refusing to dispatch ${unitType} ${unitId}`;
      debugLog("runUnitPhase", { phase: "worktree-health-fail", basePath: s.basePath, hasProjectFile, hasSrcDir });
      ctx.ui.notify(msg, "error");
      await deps.stopAuto(ctx, pi, msg);
      return { action: "break", reason: "worktree-invalid" };
    }
  }

  // Detect retry and capture previous tier for escalation
  const isRetry = !!(
    s.currentUnit &&
    s.currentUnit.type === unitType &&
    s.currentUnit.id === unitId
  );
  const previousTier = s.currentUnitRouting?.tier;

  s.currentUnit = { type: unitType, id: unitId, startedAt: Date.now() };
  const unitStartSeq = ic.nextSeq();
  deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: unitStartSeq, eventType: "unit-start", data: { unitType, unitId } });
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
      const { inlineGsdRootFile } = await importExtensionModule<typeof import("../auto-prompts.js")>(import.meta.url, "../auto-prompts.js");
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

  // Apply sidecar/pre-dispatch hook model override (takes priority over standard model selection)
  const hookModelOverride = sidecarItem?.model ?? iterData.hookModelOverride;
  if (hookModelOverride) {
    const availableModels = ctx.modelRegistry.getAvailable();
    const match = deps.resolveModelId(hookModelOverride, availableModels, ctx.model?.provider);
    if (match) {
      const ok = await pi.setModel(match, { persist: false });
      if (ok) {
        ctx.ui.notify(`Hook model override: ${match.provider}/${match.id}`, "info");
      } else {
        ctx.ui.notify(
          `Hook model "${hookModelOverride}" found but setModel failed. Using default.`,
          "warning",
        );
      }
    } else {
      ctx.ui.notify(
        `Hook model "${hookModelOverride}" not found in available models. Falling back to current session model. ` +
        `Ensure the model is defined in models.json and has auth configured.`,
        "warning",
      );
    }
  }

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
    buildRecoveryContext: () => ({
      basePath: s.basePath,
      verbose: s.verbose,
      currentUnitStartedAt: s.currentUnit?.startedAt ?? Date.now(),
      unitRecoveryCount: s.unitRecoveryCount,
    }),
    pauseAuto: deps.pauseAuto,
  });

  // Write preliminary lock (no session path yet — runUnit creates a new session).
  // Crash recovery can still identify the in-flight unit from this lock.
  deps.writeLock(
    deps.lockBase(),
    unitType,
    unitId,
    s.completedUnits.length,
  );

  debugLog("autoLoop", {
    phase: "runUnit-start",
    iteration: ic.iteration,
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
    iteration: ic.iteration,
    unitType,
    unitId,
    status: unitResult.status,
  });

  // Now that runUnit has called newSession(), the session file path is correct.
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

  // Tag the most recent window entry with error info for stuck detection
  if (unitResult.status === "error" || unitResult.status === "cancelled") {
    const lastEntry = loopState.recentUnits[loopState.recentUnits.length - 1];
    if (lastEntry) {
      lastEntry.error = `${unitResult.status}:${unitType}/${unitId}`;
    }
  } else if (unitResult.event?.messages?.length) {
    const lastMsg = unitResult.event.messages[unitResult.event.messages.length - 1];
    const msgStr = typeof lastMsg === "string" ? lastMsg : JSON.stringify(lastMsg);
    if (/error|fail|exception/i.test(msgStr)) {
      const lastEntry = loopState.recentUnits[loopState.recentUnits.length - 1];
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
    return { action: "break", reason: "session-failed" };
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

  // ── Zero tool-call guard (#1833) ──────────────────────────────────
  // An execute-task agent that completes with 0 tool calls made no
  // real changes — its summary is hallucinated. Treat as failed so
  // the task is retried instead of silently marked complete.
  if (unitType === "execute-task") {
    const currentLedger = deps.getLedger() as { units: Array<{ type: string; id: string; startedAt: number; toolCalls: number }> } | null;
    if (currentLedger?.units) {
      const lastUnit = [...currentLedger.units].reverse().find(
        (u: { type: string; id: string; startedAt: number; toolCalls: number }) => u.type === unitType && u.id === unitId && u.startedAt === s.currentUnit!.startedAt,
      );
      if (lastUnit && lastUnit.toolCalls === 0) {
        debugLog("runUnitPhase", {
          phase: "zero-tool-calls",
          unitType,
          unitId,
          warning: "Task completed with 0 tool calls — likely hallucinated, marking as failed",
        });
        ctx.ui.notify(
          `${unitType} ${unitId} completed with 0 tool calls — hallucinated summary, will retry`,
          "warning",
        );
        // Do NOT add to completedUnits — fall through to next iteration
        // where dispatch will re-derive and re-dispatch this task.
        return { action: "next", data: { unitStartedAt: s.currentUnit.startedAt } };
      }
    }
  }

  if (s.currentUnitRouting) {
    deps.recordOutcome(
      unitType,
      s.currentUnitRouting.tier as "light" | "standard" | "heavy",
      true, // success assumed; dispatch will re-dispatch if artifact missing
    );
  }

  const skipArtifactVerification = unitType.startsWith("hook/") || unitType === "custom-step";
  const artifactVerified =
    skipArtifactVerification ||
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

  deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "unit-end", data: { unitType, unitId, status: unitResult.status, artifactVerified }, causedBy: { flowId: ic.flowId, seq: unitStartSeq } });

  return { action: "next", data: { unitStartedAt: s.currentUnit.startedAt } };
}

// ─── runFinalize ──────────────────────────────────────────────────────────────

/**
 * Phase 5: Post-unit finalize — pre/post verification, UAT pause, step-wizard.
 * Returns break/continue/next to control the outer loop.
 */
export async function runFinalize(
  ic: IterationContext,
  iterData: IterationData,
  sidecarItem?: SidecarItem,
): Promise<PhaseResult> {
  const { ctx, pi, s, deps } = ic;
  const { pauseAfterUatDispatch } = iterData;

  debugLog("autoLoop", { phase: "finalize", iteration: ic.iteration });

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
    return { action: "break", reason: "pre-verification-dispatched" };
  }
  if (preResult === "retry") {
    if (sidecarItem) {
      // Sidecar artifact retries are skipped — just continue
      debugLog("autoLoop", { phase: "sidecar-artifact-retry-skipped", iteration: ic.iteration });
    } else {
      // s.pendingVerificationRetry was set by postUnitPreVerification.
      // Continue the loop — next iteration will inject the retry context into the prompt.
      debugLog("autoLoop", { phase: "artifact-verification-retry", iteration: ic.iteration });
      return { action: "continue" };
    }
  }

  if (pauseAfterUatDispatch) {
    ctx.ui.notify(
      "UAT requires human execution. Auto-mode will pause after this unit writes the result file.",
      "info",
    );
    await deps.pauseAuto(ctx, pi);
    debugLog("autoLoop", { phase: "exit", reason: "uat-pause" });
    return { action: "break", reason: "uat-pause" };
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
      return { action: "break", reason: "verification-pause" };
    }

    if (verificationResult === "retry") {
      if (sidecarItem) {
        // Sidecar verification retries are skipped — just continue
        debugLog("autoLoop", { phase: "sidecar-verification-retry-skipped", iteration: ic.iteration });
      } else {
        // s.pendingVerificationRetry was set by runPostUnitVerification.
        // Continue the loop — next iteration will inject the retry context into the prompt.
        debugLog("autoLoop", { phase: "verification-retry", iteration: ic.iteration });
        return { action: "continue" };
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
    return { action: "break", reason: "post-verification-stopped" };
  }

  if (postResult === "step-wizard") {
    // Step mode — exit the loop (caller handles wizard)
    debugLog("autoLoop", { phase: "exit", reason: "step-wizard" });
    return { action: "break", reason: "step-wizard" };
  }

  return { action: "next", data: undefined as void };
}
