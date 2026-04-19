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
import type { Phase } from "../types.js";
import {
  MAX_RECOVERY_CHARS,
  BUDGET_THRESHOLDS,
  MAX_FINALIZE_TIMEOUTS,
  type PhaseResult,
  type IterationContext,
  type LoopState,
  type PreDispatchData,
  type IterationData,
} from "./types.js";
import { detectStuck } from "./detect-stuck.js";
import { runUnit } from "./run-unit.js";
import { debugLog } from "../debug-logger.js";
import { PROJECT_FILES } from "../detection.js";
import { MergeConflictError } from "../git-service.js";
import { setCurrentPhase, clearCurrentPhase } from "../../shared/gsd-phase-state.js";
import { pauseAutoForProviderError } from "../provider-error-pause.js";
import { resumeAutoAfterProviderDelay } from "../bootstrap/provider-error-resume.js";
import { join, basename, dirname, parse as parsePath } from "node:path";
import { existsSync, cpSync, readdirSync } from "node:fs";
import {
  logWarning,
  logError,
  _resetLogs,
  drainLogs,
  drainAndSummarize,
  formatForNotification,
  hasAnyIssues,
} from "../workflow-logger.js";
import { gsdRoot } from "../paths.js";
import { atomicWriteSync } from "../atomic-write.js";
import { verifyExpectedArtifact, diagnoseExpectedArtifact, buildLoopRemediationSteps } from "../auto-recovery.js";
import { writeUnitRuntimeRecord } from "../unit-runtime.js";
import { withTimeout, FINALIZE_PRE_TIMEOUT_MS, FINALIZE_POST_TIMEOUT_MS } from "./finalize-timeout.js";
import { getEligibleSlices } from "../slice-parallel-eligibility.js";
import { startSliceParallel } from "../slice-parallel-orchestrator.js";
import { isDbAvailable, getMilestoneSlices } from "../gsd-db.js";
import type { MinimalModelRegistry } from "../context-budget.js";
import { ensurePlanV2Graph } from "../uok/plan-v2.js";
import { resolveUokFlags } from "../uok/flags.js";
import { UokGateRunner } from "../uok/gate-runner.js";
import { resetEvidence } from "../safety/evidence-collector.js";
import { createCheckpoint, cleanupCheckpoint, rollbackToCheckpoint } from "../safety/git-checkpoint.js";
import { resolveSafetyHarnessConfig } from "../safety/safety-harness.js";
import {
  getWorkflowTransportSupportError,
  getRequiredWorkflowToolsForAutoUnit,
  supportsStructuredQuestions,
} from "../workflow-mcp.js";

// ─── Session timeout auto-resume state ────────────────────────────────────────

let consecutiveSessionTimeouts = 0;
const MAX_SESSION_TIMEOUT_AUTO_RESUMES = 3;

export function resetSessionTimeoutState(): void {
  consecutiveSessionTimeouts = 0;
}

// ─── generateMilestoneReport ──────────────────────────────────────────────────

/**
 * Resolve the base path for milestone reports.
 * Prefers originalBasePath (project root) over basePath (which may be a worktree).
 * Exported for testing as _resolveReportBasePath.
 */
export function _resolveReportBasePath(s: Pick<AutoSession, "originalBasePath" | "basePath">): string {
  return s.originalBasePath || s.basePath;
}

/**
 * Resolve the authoritative project base for dispatch guards.
 * Prior-milestone completion lives at the project root, even when the active
 * unit is running inside an auto worktree.
 */
export function _resolveDispatchGuardBasePath(
  s: Pick<AutoSession, "originalBasePath" | "basePath">,
): string {
  return s.originalBasePath || s.basePath;
}

const PLAN_V2_GATE_PHASES: ReadonlySet<Phase> = new Set([
  "executing",
  "summarizing",
  "validating-milestone",
  "completing-milestone",
]);

function shouldRunPlanV2Gate(phase: Phase): boolean {
  return PLAN_V2_GATE_PHASES.has(phase);
}

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

  const reportBasePath = _resolveReportBasePath(s);

  const snapData = await loadVisualizerData(reportBasePath);
  const completedMs = snapData.milestones.find(
    (m: { id: string }) => m.id === milestoneId,
  );
  const msTitle = completedMs?.title ?? milestoneId;
  const gsdVersion = process.env.GSD_VERSION ?? "0.0.0";
  const projName = basename(reportBasePath);
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
    basePath: reportBasePath,
    html: generateHtmlReport(snapData, {
      projectName: projName,
      projectPath: reportBasePath,
      gsdVersion,
      milestoneId,
      indexRelPath: "index.html",
    }),
    milestoneId,
    milestoneTitle: msTitle,
    kind: "milestone",
    projectName: projName,
    projectPath: reportBasePath,
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

async function emitCancelledUnitEnd(
  ic: IterationContext,
  unitType: string,
  unitId: string,
  unitStartSeq: number,
  errorContext?: { message: string; category: string; stopReason?: string; isTransient?: boolean; retryAfterMs?: number },
): Promise<void> {
  ic.deps.emitJournalEvent({
    ts: new Date().toISOString(),
    flowId: ic.flowId,
    seq: ic.nextSeq(),
    eventType: "unit-end",
    data: {
      unitType,
      unitId,
      status: "cancelled",
      artifactVerified: false,
      ...(errorContext ? { errorContext } : {}),
    },
    causedBy: { flowId: ic.flowId, seq: unitStartSeq },
  });
}

async function failClosedOnFinalizeTimeout(
  ic: IterationContext,
  iterData: IterationData,
  loopState: LoopState,
  stage: "pre" | "post",
  startedAt: number,
): Promise<PhaseResult> {
  const { ctx, pi, s, deps } = ic;
  const now = Date.now();
  const unitType = iterData.unitType;
  const unitId = iterData.unitId;
  const timeoutMs = stage === "pre" ? FINALIZE_PRE_TIMEOUT_MS : FINALIZE_POST_TIMEOUT_MS;
  const progressKind = stage === "pre" ? "finalize-pre-timeout" : "finalize-post-timeout";

  writeUnitRuntimeRecord(s.basePath, unitType, unitId, startedAt, {
    phase: "finalize-timeout",
    timeoutAt: now,
    lastProgressAt: now,
    lastProgressKind: progressKind,
  });

  deps.emitJournalEvent({
    ts: new Date(now).toISOString(),
    flowId: ic.flowId,
    seq: ic.nextSeq(),
    eventType: "unit-end",
    data: {
      unitType,
      unitId,
      status: "timed-out-finalize",
      artifactVerified: false,
      finalizeStage: stage,
    },
  });

  loopState.consecutiveFinalizeTimeouts++;
  debugLog("autoLoop", {
    phase: progressKind,
    iteration: ic.iteration,
    unitType,
    unitId,
    consecutiveTimeouts: loopState.consecutiveFinalizeTimeouts,
  });

  ctx.ui.notify(
    `${stage === "pre" ? "postUnitPreVerification" : "postUnitPostVerification"} timed out after ${timeoutMs / 1000}s for ${unitType} ${unitId} (${loopState.consecutiveFinalizeTimeouts}/${MAX_FINALIZE_TIMEOUTS}) — pausing auto-mode for recovery.`,
    "warning",
  );

  await deps.pauseAuto(ctx, pi);
  s.currentUnit = null;
  clearCurrentPhase();
  drainLogs();
  return { action: "break", reason: progressKind };
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
  const uokFlags = resolveUokFlags(prefs);
  const runPreDispatchGate = async (input: {
    gateId: string;
    gateType: string;
    outcome: "pass" | "fail" | "retry" | "manual-attention";
    failureClass: "none" | "policy" | "input" | "execution" | "artifact" | "verification" | "closeout" | "git" | "timeout" | "manual-attention" | "unknown";
    rationale: string;
    findings?: string;
    milestoneId?: string;
  }): Promise<void> => {
    if (!uokFlags.gates) return;
    const gateRunner = new UokGateRunner();
    gateRunner.register({
      id: input.gateId,
      type: input.gateType,
      execute: async () => ({
        outcome: input.outcome,
        failureClass: input.failureClass,
        rationale: input.rationale,
        findings: input.findings ?? "",
      }),
    });
    await gateRunner.run(input.gateId, {
      basePath: s.basePath,
      traceId: `pre-dispatch:${ic.flowId}`,
      turnId: `iter-${ic.iteration}`,
      milestoneId: input.milestoneId ?? s.currentMilestoneId ?? undefined,
      unitType: "pre-dispatch",
      unitId: `iter-${ic.iteration}`,
    });
  };

  // Resource version guard
  const staleMsg = deps.checkResourcesStale(s.resourceVersionOnStart);
  if (staleMsg) {
    await runPreDispatchGate({
      gateId: "resource-version-guard",
      gateType: "policy",
      outcome: "fail",
      failureClass: "policy",
      rationale: "resource version guard blocked dispatch",
      findings: staleMsg,
    });
    await deps.stopAuto(ctx, pi, staleMsg);
    debugLog("autoLoop", { phase: "exit", reason: "resources-stale" });
    return { action: "break", reason: "resources-stale" };
  }
  await runPreDispatchGate({
    gateId: "resource-version-guard",
    gateType: "policy",
    outcome: "pass",
    failureClass: "none",
    rationale: "resource version guard passed",
  });

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
      await runPreDispatchGate({
        gateId: "pre-dispatch-health-gate",
        gateType: "execution",
        outcome: "manual-attention",
        failureClass: "manual-attention",
        rationale: "pre-dispatch health gate blocked dispatch",
        findings: healthGate.reason,
      });
      ctx.ui.notify(
        healthGate.reason || "Pre-dispatch health check failed — run /gsd doctor for details.",
        "error",
      );
      await deps.pauseAuto(ctx, pi);
      debugLog("autoLoop", { phase: "exit", reason: "health-gate-failed" });
      return { action: "break", reason: "health-gate-failed" };
    }
    await runPreDispatchGate({
      gateId: "pre-dispatch-health-gate",
      gateType: "execution",
      outcome: "pass",
      failureClass: "none",
      rationale: "pre-dispatch health gate passed",
      findings: healthGate.fixesApplied.length > 0 ? healthGate.fixesApplied.join(", ") : "",
    });
  } catch (e) {
    await runPreDispatchGate({
      gateId: "pre-dispatch-health-gate",
      gateType: "execution",
      outcome: "manual-attention",
      failureClass: "manual-attention",
      rationale: "pre-dispatch health gate threw unexpectedly",
      findings: String(e),
    });
    logWarning("engine", "Pre-dispatch health gate threw unexpectedly", { error: String(e) });
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
  if (prefs?.uok?.plan_v2?.enabled && shouldRunPlanV2Gate(state.phase)) {
    const compiled = ensurePlanV2Graph(s.basePath, state);
    if (!compiled.ok) {
      const reason = compiled.reason ?? "Plan v2 compilation failed";
      await runPreDispatchGate({
        gateId: "plan-v2-gate",
        gateType: "policy",
        outcome: "manual-attention",
        failureClass: "manual-attention",
        rationale: "plan v2 compile gate failed",
        findings: reason,
        milestoneId: state.activeMilestone?.id ?? undefined,
      });
      ctx.ui.notify(`Plan gate failed-closed: ${reason}`, "error");
      await deps.pauseAuto(ctx, pi);
      return { action: "break", reason: "plan-v2-gate-failed" };
    }
    await runPreDispatchGate({
      gateId: "plan-v2-gate",
      gateType: "policy",
      outcome: "pass",
      failureClass: "none",
      rationale: "plan v2 compile gate passed",
      milestoneId: state.activeMilestone?.id ?? undefined,
    });
  }
  deps.syncCmuxSidebar(prefs, state);
  let mid = state.activeMilestone?.id;
  let midTitle = state.activeMilestone?.title;
  debugLog("autoLoop", {
    phase: "state-derived",
    iteration: ic.iteration,
    mid,
    statePhase: state.phase,
  });

  // ── Slice-level parallelism gate (#2340) ─────────────────────────────
  // When slice_parallel is enabled, check if multiple slices are eligible
  // for parallel execution. If so, dispatch them in parallel and stop the
  // sequential loop. Workers are spawned via slice-parallel-orchestrator.ts.
  if (
    prefs?.slice_parallel?.enabled &&
    mid &&
    !process.env.GSD_PARALLEL_WORKER &&
    isDbAvailable()
  ) {
    try {
      const dbSlices = getMilestoneSlices(mid);
      if (dbSlices.length > 0) {
        const doneIds = new Set(dbSlices.filter(sl => sl.status === "complete" || sl.status === "done").map(sl => sl.id));
        const sliceInputs = dbSlices.map(sl => ({
          id: sl.id,
          done: doneIds.has(sl.id),
          depends: sl.depends ?? [],
        }));
        const eligible = getEligibleSlices(sliceInputs, doneIds);
        if (eligible.length > 1) {
          debugLog("autoLoop", {
            phase: "slice-parallel-dispatch",
            iteration: ic.iteration,
            mid,
            eligibleSlices: eligible.map(e => e.id),
          });
          ctx.ui.notify(
            `Slice-parallel: dispatching ${eligible.length} eligible slices for ${mid}.`,
            "info",
          );
          const result = await startSliceParallel(
            s.basePath,
            mid,
            eligible,
            {
              maxWorkers: prefs.slice_parallel.max_workers ?? 2,
              useExecutionGraph: uokFlags.executionGraph,
            },
          );
          if (result.started.length > 0) {
            ctx.ui.notify(
              `Slice-parallel: started ${result.started.length} worker(s): ${result.started.join(", ")}.`,
              "info",
            );
            await deps.stopAuto(ctx, pi, `Slice-parallel dispatched for ${mid}`);
            return { action: "break", reason: "slice-parallel-dispatched" };
          }
          // Fall through to sequential if no workers started
        }
      }
    } catch (err) {
      debugLog("autoLoop", {
        phase: "slice-parallel-check-error",
        error: err instanceof Error ? err.message : String(err),
      });
      // Non-fatal — fall through to sequential dispatch
    }
  }

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
      basename(s.originalBasePath || s.basePath),
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
    try {
      deps.resolver.mergeAndExit(s.currentMilestoneId!, ctx.ui);
    } catch (mergeErr) {
      if (mergeErr instanceof MergeConflictError) {
        // Real code conflicts — stop the loop instead of retrying forever (#2330)
        ctx.ui.notify(
          `Merge conflict: ${mergeErr.conflictedFiles.join(", ")}. Resolve conflicts manually and run /gsd auto to resume.`,
          "error",
        );
        await deps.stopAuto(ctx, pi, `Merge conflict on milestone ${s.currentMilestoneId}`);
        return { action: "break", reason: "merge-conflict" };
      }
      // Non-conflict merge errors — stop auto to avoid advancing with unmerged work
      logError("engine", "Milestone merge failed with non-conflict error", { milestone: s.currentMilestoneId!, error: String(mergeErr) });
      ctx.ui.notify(
        `Merge failed: ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}. Resolve and run /gsd auto to resume.`,
        "error",
      );
      await deps.stopAuto(ctx, pi, `Merge error on milestone ${s.currentMilestoneId}: ${String(mergeErr)}`);
      return { action: "break", reason: "merge-failed" };
    }

    // PR creation (auto_pr) is handled inside mergeMilestoneToMain (#2302)

    deps.invalidateAllCaches();

    state = await deps.deriveState(s.basePath);
    mid = state.activeMilestone?.id;
    midTitle = state.activeMilestone?.title;

    if (mid) {
      if (deps.getIsolationMode() !== "none") {
        deps.captureIntegrationBranch(s.basePath, mid);
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

    // Archive the old completed-units.json instead of wiping it (#2313).
    try {
      const completedKeysPath = join(gsdRoot(s.basePath), "completed-units.json");
      if (existsSync(completedKeysPath) && s.currentMilestoneId) {
        const archivePath = join(
          gsdRoot(s.basePath),
          `completed-units-${s.currentMilestoneId}.json`,
        );
        cpSync(completedKeysPath, archivePath);
      }
      atomicWriteSync(completedKeysPath, JSON.stringify([], null, 2));
    } catch (e) {
      logWarning("engine", "Failed to archive completed-units on milestone transition", { error: String(e) });
    }

    // Rebuild STATE.md immediately so it reflects the new active milestone.
    // This bypasses the 30-second throttle in the normal rebuild path —
    // milestone transitions are rare and important enough to warrant an
    // immediate write.
    try {
      await deps.rebuildState(s.basePath);
    } catch (e) {
      logWarning("engine", "STATE.md rebuild failed after milestone transition", { error: String(e) });
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
        try {
          deps.resolver.mergeAndExit(s.currentMilestoneId, ctx.ui);
          // Prevent stopAuto from attempting the same merge (#2645)
          s.milestoneMergedInPhases = true;
        } catch (mergeErr) {
          if (mergeErr instanceof MergeConflictError) {
            ctx.ui.notify(
              `Merge conflict: ${mergeErr.conflictedFiles.join(", ")}. Resolve conflicts manually and run /gsd auto to resume.`,
              "error",
            );
            await deps.stopAuto(ctx, pi, `Merge conflict on milestone ${s.currentMilestoneId}`);
            return { action: "break", reason: "merge-conflict" };
          }
          logError("engine", "Milestone merge failed with non-conflict error", { milestone: s.currentMilestoneId!, error: String(mergeErr) });
          ctx.ui.notify(
            `Merge failed: ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}. Resolve and run /gsd auto to resume.`,
            "error",
          );
          await deps.stopAuto(ctx, pi, `Merge error on milestone ${s.currentMilestoneId}: ${String(mergeErr)}`);
          return { action: "break", reason: "merge-failed" };
        }

        // PR creation (auto_pr) is handled inside mergeMilestoneToMain (#2302)
      }
      deps.sendDesktopNotification(
        "GSD",
        "All milestones complete!",
        "success",
        "milestone",
        basename(s.originalBasePath || s.basePath),
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
      // Pause instead of hard-stop so the session is resumable with `/gsd auto`.
      // Hard-stop here was causing premature termination when slice dependencies
      // were temporarily unresolvable (e.g. after reassessment added new slices).
      await deps.pauseAuto(ctx, pi);
      ctx.ui.notify(`${blockerMsg}. Fix and run /gsd auto to resume.`, "warning");
      deps.sendDesktopNotification("GSD", blockerMsg, "warning", "attention", basename(s.originalBasePath || s.basePath));
      deps.logCmuxEvent(prefs, blockerMsg, "warning");
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
  const mergeReconcileResult = deps.reconcileMergeState(s.basePath, ctx);
  if (mergeReconcileResult === "blocked") {
    await deps.pauseAuto(ctx, pi);
    debugLog("autoLoop", { phase: "exit", reason: "merge-reconciliation-blocked" });
    return { action: "break", reason: "merge-reconciliation-blocked" };
  }
  if (mergeReconcileResult === "reconciled") {
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
      try {
        deps.resolver.mergeAndExit(s.currentMilestoneId, ctx.ui);
        // Prevent stopAuto from attempting the same merge (#2645)
        s.milestoneMergedInPhases = true;
      } catch (mergeErr) {
        if (mergeErr instanceof MergeConflictError) {
          ctx.ui.notify(
            `Merge conflict: ${mergeErr.conflictedFiles.join(", ")}. Resolve conflicts manually and run /gsd auto to resume.`,
            "error",
          );
          await deps.stopAuto(ctx, pi, `Merge conflict on milestone ${s.currentMilestoneId}`);
          return { action: "break", reason: "merge-conflict" };
        }
        logError("engine", "Milestone merge failed with non-conflict error", { milestone: s.currentMilestoneId!, error: String(mergeErr) });
        ctx.ui.notify(
          `Merge failed: ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}. Resolve and run /gsd auto to resume.`,
          "error",
        );
        await deps.stopAuto(ctx, pi, `Merge error on milestone ${s.currentMilestoneId}: ${String(mergeErr)}`);
        return { action: "break", reason: "merge-failed" };
      }

      // PR creation (auto_pr) is handled inside mergeMilestoneToMain (#2302)
    }
    deps.sendDesktopNotification(
      "GSD",
      `Milestone ${mid} complete!`,
      "success",
      "milestone",
      basename(s.originalBasePath || s.basePath),
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

  // Terminal: blocked — pause instead of hard-stop so the session is resumable.
  if (state.phase === "blocked") {
    const blockerMsg = `Blocked: ${state.blockers.join(", ")}`;
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
    await deps.pauseAuto(ctx, pi);
    ctx.ui.notify(`${blockerMsg}. Fix and run /gsd auto to resume.`, "warning");
    deps.sendDesktopNotification("GSD", blockerMsg, "warning", "attention", basename(s.originalBasePath || s.basePath));
    deps.logCmuxEvent(prefs, blockerMsg, "warning");
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
  const provider = ctx.model?.provider;
  const authMode = provider && typeof ctx.modelRegistry?.getProviderAuthMode === "function"
    ? ctx.modelRegistry.getProviderAuthMode(provider)
    : undefined;
  const activeTools = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
  const structuredQuestionsAvailable = supportsStructuredQuestions(activeTools, {
    authMode,
    baseUrl: ctx.model?.baseUrl,
  }) ? "true" : "false";

  debugLog("autoLoop", { phase: "dispatch-resolve", iteration: ic.iteration });
  const dispatchResult = await deps.resolveDispatch({
    basePath: s.basePath,
    mid,
    midTitle,
    state,
    prefs,
    session: s,
    structuredQuestionsAvailable,
    sessionContextWindow: ctx.model?.contextWindow,
    modelRegistry: ctx.modelRegistry as MinimalModelRegistry | undefined,
  });

  if (dispatchResult.action === "stop") {
    deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "dispatch-stop", rule: dispatchResult.matchedRule, data: { reason: dispatchResult.reason } });
    // Warning-level stops are recoverable human checkpoints (e.g. UAT verdict
    // gate) — pause instead of hard-stopping so the session is resumable with
    // `/gsd auto`. Error/info-level stops remain hard stops for infrastructure
    // failures and terminal conditions respectively.
    // See: https://github.com/gsd-build/gsd-2/issues/2474
    if (dispatchResult.level === "warning") {
      ctx.ui.notify(dispatchResult.reason, "warning");
      await deps.pauseAuto(ctx, pi);
    } else {
      await closeoutAndStop(ctx, pi, s, deps, dispatchResult.reason);
    }
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
        const artifactExists = verifyExpectedArtifact(
          unitType,
          unitId,
          s.basePath,
        );
        if (artifactExists) {
          if (unitType === "complete-milestone") {
            const stuckDiag = diagnoseExpectedArtifact(unitType, unitId, s.basePath);
            const stuckParts = [
              `Detected ${unitType} ${unitId} output on disk, but the same unit is still being derived.`,
              "This usually means the milestone summary exists while the DB row still does not mark the milestone complete.",
            ];
            if (stuckDiag) stuckParts.push(`Expected: ${stuckDiag}`);
            ctx.ui.notify(stuckParts.join(" "), "warning");
            await deps.pauseAuto(ctx, pi);
            return { action: "break", reason: "complete-milestone-artifact-db-mismatch" };
          }
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
        const stuckDiag = diagnoseExpectedArtifact(unitType, unitId, s.basePath);
        const stuckRemediation = buildLoopRemediationSteps(unitType, unitId, s.basePath);
        const stuckParts = [`Stuck on ${unitType} ${unitId} — ${stuckSignal.reason}.`];
        if (stuckDiag) stuckParts.push(`Expected: ${stuckDiag}`);
        if (stuckRemediation) stuckParts.push(`To recover:\n${stuckRemediation}`);
        ctx.ui.notify(stuckParts.join(" "), "error");
        await deps.stopAuto(
          ctx,
          pi,
          `Stuck: ${stuckSignal.reason}`,
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

  const guardBasePath = _resolveDispatchGuardBasePath(s);
  const priorSliceBlocker = deps.getPriorSliceCompletionBlocker(
    guardBasePath,
    deps.getMainBranch(guardBasePath),
    unitType,
    unitId,
  );
  if (priorSliceBlocker) {
    await deps.stopAuto(ctx, pi, priorSliceBlocker);
    debugLog("autoLoop", { phase: "exit", reason: "prior-slice-blocker" });
    return { action: "break", reason: "prior-slice-blocker" };
  }

  return {
    action: "next",
    data: {
      unitType, unitId, prompt, finalPrompt: prompt,
      pauseAfterUatDispatch,
      state, mid, midTitle,
      isRetry: false, previousTier: undefined,
      hookModelOverride: preDispatchResult.model,
    },
  };
}

// ─── runGuards ────────────────────────────────────────────────────────────────

/**
 * Phase 2: Guards — stop directives, budget ceiling, context window, secrets re-check.
 * Returns break to exit the loop, or next to proceed to dispatch.
 */
export async function runGuards(
  ic: IterationContext,
  mid: string,
): Promise<PhaseResult> {
  const { ctx, pi, s, deps, prefs } = ic;

  // ── Stop/Backtrack directive guard (#3487) ──
  // Check for unexecuted stop or backtrack captures BEFORE dispatching any unit.
  // This ensures user "halt" directives are honored immediately.
  // IMPORTANT: Fail-closed — any exception during stop handling still breaks the loop
  // to ensure user halt intent is never silently dropped.
  try {
    const { loadStopCaptures, markCaptureExecuted } = await import("../captures.js");
    const stopCaptures = loadStopCaptures(s.basePath);
    if (stopCaptures.length > 0) {
      const first = stopCaptures[0];
      const isBacktrack = first.classification === "backtrack";
      const label = isBacktrack
        ? `Backtrack directive: ${first.text}`
        : `Stop directive: ${first.text}`;

      ctx.ui.notify(label, "warning");
      deps.sendDesktopNotification(
        "GSD", label, "warning", "stop-directive",
        basename(s.originalBasePath || s.basePath),
      );

      // Pause first — ensures auto-mode stops even if later steps fail
      await deps.pauseAuto(ctx, pi);

      // For backtrack captures, write the backtrack trigger after pausing
      if (isBacktrack) {
        try {
          const { executeBacktrack } = await import("../triage-resolution.js");
          executeBacktrack(s.basePath, mid, first);
        } catch (e) {
          debugLog("guards", { phase: "backtrack-execution-error", error: String(e) });
        }
      }

      // Mark captures as executed only after successful pause/transition
      for (const cap of stopCaptures) {
        markCaptureExecuted(s.basePath, cap.id);
      }

      debugLog("autoLoop", { phase: "exit", reason: isBacktrack ? "user-backtrack" : "user-stop" });
      return { action: "break", reason: isBacktrack ? "user-backtrack" : "user-stop" };
    }
  } catch (e) {
    // Fail-closed: if anything in the stop guard throws, break the loop
    // rather than silently continuing and dropping user halt intent
    debugLog("guards", { phase: "stop-guard-error", error: String(e) });
    return { action: "break", reason: "stop-guard-error" };
  }

  // Budget ceiling guard
  const budgetCeiling = prefs?.budget_ceiling;
  if (budgetCeiling !== undefined && budgetCeiling > 0) {
    const currentLedger = deps.getLedger() as { units: unknown } | null;
    // In parallel worker mode, only count cost from the current auto-mode session
    // to avoid hitting the ceiling due to historical project-wide spend (#2184).
    let costUnits = currentLedger?.units;
    if (process.env.GSD_PARALLEL_WORKER && s.autoStartTime && Array.isArray(costUnits)) {
      const sessionStartISO = new Date(s.autoStartTime).toISOString();
      costUnits = costUnits.filter(
        (u: { startedAt?: string }) => u.startedAt != null && u.startedAt >= sessionStartISO,
      );
    }
    const totalCost = costUnits
      ? deps.getProjectTotals(costUnits).cost
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

      // Emit Layer 2 budget_threshold event (post-plan hook recommendation).
      // Extensions / Layer 0 shell hooks may return an action override.
      let hookAction: "pause" | "downgrade" | "continue" | undefined;
      try {
        const { emitBudgetThreshold } = await import("../hook-emitter.js");
        const hookResult = await emitBudgetThreshold({
          fraction: budgetPct,
          spent: totalCost,
          limit: budgetCeiling,
        });
        if (hookResult?.action) hookAction = hookResult.action;
      } catch (hookErr) {
        logWarning("engine", `budget_threshold hook emission failed: ${(hookErr as Error).message}`);
      }

      // Apply hook override to enforcement action. "continue" → "none" (no enforcement),
      // "pause" and "downgrade" map to the matching enforcement path below.
      let effectiveAction = budgetEnforcementAction;
      if (hookAction === "continue") {
        effectiveAction = "none";
      } else if (hookAction === "pause") {
        effectiveAction = "pause";
      } else if (hookAction === "downgrade") {
        effectiveAction = "warn";
      }

      if (threshold.pct === 100 && effectiveAction !== "none") {
        // 100% — special enforcement logic (halt/pause/warn)
        const msg = `Budget ceiling ${deps.formatCost(budgetCeiling)} reached (spent ${deps.formatCost(totalCost)}).`;
        if (effectiveAction === "halt") {
          deps.sendDesktopNotification("GSD", msg, "error", "budget", basename(s.originalBasePath || s.basePath));
          await deps.stopAuto(ctx, pi, "Budget ceiling reached");
          debugLog("autoLoop", { phase: "exit", reason: "budget-halt" });
          return { action: "break", reason: "budget-halt" };
        }
        if (effectiveAction === "pause") {
          ctx.ui.notify(
            `${msg} Pausing auto-mode — /gsd auto to override and continue.`,
            "warning",
          );
          deps.sendDesktopNotification("GSD", msg, "warning", "budget", basename(s.originalBasePath || s.basePath));
          deps.logCmuxEvent(prefs, msg, "warning");
          await deps.pauseAuto(ctx, pi);
          debugLog("autoLoop", { phase: "exit", reason: "budget-pause" });
          return { action: "break", reason: "budget-pause" };
        }
        ctx.ui.notify(`${msg} Continuing (enforcement: warn).`, "warning");
        deps.sendDesktopNotification("GSD", msg, "warning", "budget", basename(s.originalBasePath || s.basePath));
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
          basename(s.originalBasePath || s.basePath),
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
        basename(s.originalBasePath || s.basePath),
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
  const { unitType, unitId, prompt, state, mid } = iterData;

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
    // Xcode bundles have project-specific names (*.xcodeproj, *.xcworkspace)
    // that cannot be matched by exact filename — scan the directory by suffix.
    let hasXcodeBundle = false;
    try {
      const entries = deps.existsSync(s.basePath) ? readdirSync(s.basePath) : [];
      hasXcodeBundle = entries.some((e: string) => e.endsWith(".xcodeproj") || e.endsWith(".xcworkspace"));
    } catch (err) {
      debugLog("runUnitPhase", { phase: "xcode-bundle-scan-failed", basePath: s.basePath, error: String(err) });
    }
    // Monorepo support (#2347): if no project files in the worktree directory,
    // walk parent directories up to the filesystem root. In monorepos,
    // package.json / Cargo.toml etc. live in a parent directory.
    let hasProjectFileInParent = false;
    if (!hasProjectFile && !hasSrcDir && !hasXcodeBundle) {
      let checkDir = dirname(s.basePath);
      const { root } = parsePath(checkDir);
      while (checkDir !== root) {
        // Stop at git repository boundary — ancestors above the repo root
        // (e.g. ~ or /usr/local) may contain unrelated project files.
        if (deps.existsSync(join(checkDir, ".git"))) break;
        if (PROJECT_FILES.some((f) => deps.existsSync(join(checkDir, f)))) {
          hasProjectFileInParent = true;
          break;
        }
        checkDir = dirname(checkDir);
      }
    }
    if (!hasProjectFile && !hasSrcDir && !hasXcodeBundle && !hasProjectFileInParent) {
      // Greenfield projects won't have project files yet — the first task creates them.
      // Log a warning but allow execution to proceed. The .git check above is sufficient
      // to ensure we're in a valid working directory.
      debugLog("runUnitPhase", { phase: "worktree-health-warn-greenfield", basePath: s.basePath, hasProjectFile, hasSrcDir, hasXcodeBundle });
      ctx.ui.notify(`Warning: ${s.basePath} has no recognized project files — proceeding as greenfield project`, "warning");
    }
  }

  // Detect retry and capture previous tier for escalation
  const isRetry = !!(
    s.currentUnit &&
    s.currentUnit.type === unitType &&
    s.currentUnit.id === unitId
  );
  const previousTier = s.currentUnitRouting?.tier;

  // Scope workflow-logger buffer to this unit so post-finalize drains are
  // per-unit. Without this, the module-level _buffer accumulates across every
  // unit in the same Node process (see workflow-logger.ts module header).
  _resetLogs();
  const dispatchKey = `${unitType}/${unitId}`;
  s.unitDispatchCount.set(dispatchKey, (s.unitDispatchCount.get(dispatchKey) ?? 0) + 1);
  s.currentUnit = { type: unitType, id: unitId, startedAt: Date.now() };
  s.lastGitActionFailure = null;
  s.lastGitActionStatus = null;
  setCurrentPhase(unitType);
  s.lastToolInvocationError = null; // #2883: clear stale error from previous unit
  const unitStartSeq = ic.nextSeq();
  deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: unitStartSeq, eventType: "unit-start", data: { unitType, unitId } });
  deps.captureAvailableSkills();
  writeUnitRuntimeRecord(
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
      recoveryAttempts: 0, // Reset so re-dispatched units get full recovery budget (#2322)
    },
  );

  // Status bar (widget + preconditions deferred until after model selection — see #2899)
  ctx.ui.setStatus("gsd-auto", "auto");
  if (mid)
    deps.updateSliceProgressCache(s.basePath, mid, state.activeSlice?.id);

  // ── Safety harness: reset evidence + create checkpoint ──
  const safetyConfig = resolveSafetyHarnessConfig(
    prefs?.safety_harness as Record<string, unknown> | undefined,
  );
  if (safetyConfig.enabled && safetyConfig.evidence_collection) {
    resetEvidence();
  }
  // Only checkpoint code-executing units (not lifecycle/planning units)
  if (safetyConfig.enabled && safetyConfig.checkpoints && unitType === "execute-task") {
    s.checkpointSha = createCheckpoint(s.basePath, unitId);
    if (s.checkpointSha) {
      debugLog("runUnitPhase", { phase: "checkpoint-created", unitId, sha: s.checkpointSha.slice(0, 8) });
    }
  }

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
  } else if ((s.unitDispatchCount.get(dispatchKey) ?? 0) > 1) {
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
    } catch (e) {
      logWarning("engine", "Baseline char count measurement failed", { error: String(e) });
    }
  }

  // Cache-optimize prompt section ordering
  try {
    finalPrompt = deps.reorderForCaching(finalPrompt);
  } catch (reorderErr) {
    const msg =
      reorderErr instanceof Error ? reorderErr.message : String(reorderErr);
    logWarning("engine", "Prompt reorder failed", { error: msg });
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
    undefined,
    s.manualSessionModelOverride,
  );
  s.currentUnitRouting =
    modelResult.routing as AutoSession["currentUnitRouting"];
  s.currentUnitModel =
    modelResult.appliedModel as AutoSession["currentUnitModel"];

  // Apply sidecar/pre-dispatch hook model override (takes priority over standard model selection)
  const hookModelOverride = sidecarItem?.model ?? iterData.hookModelOverride;
  if (hookModelOverride) {
    const availableModels = ctx.modelRegistry.getAvailable();
    const match = deps.resolveModelId(hookModelOverride, availableModels, ctx.model?.provider);
    if (match) {
      const ok = await pi.setModel(match, { persist: false });
      if (ok) {
        s.currentUnitModel = match as AutoSession["currentUnitModel"];
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

  // Store the final dispatched model ID so the dashboard can read it (#2899).
  // This accounts for hook model overrides applied after selectAndApplyModel.
  s.currentDispatchedModelId = s.currentUnitModel
    ? `${(s.currentUnitModel as any).provider ?? ""}/${(s.currentUnitModel as any).id ?? ""}`
    : null;

  const compatibilityError = getWorkflowTransportSupportError(
    s.currentUnitModel?.provider ?? ctx.model?.provider,
    getRequiredWorkflowToolsForAutoUnit(unitType),
    {
      projectRoot: s.basePath,
      surface: "auto-mode",
      unitType,
      authMode: s.currentUnitModel?.provider
        ? ctx.modelRegistry.getProviderAuthMode(s.currentUnitModel.provider)
        : ctx.model?.provider
          ? ctx.modelRegistry.getProviderAuthMode(ctx.model.provider)
          : undefined,
      baseUrl: (s.currentUnitModel as any)?.baseUrl ?? ctx.model?.baseUrl,
    },
  );
  if (compatibilityError) {
    ctx.ui.notify(compatibilityError, "error");
    await deps.stopAuto(ctx, pi, compatibilityError);
    return { action: "break", reason: "workflow-capability" };
  }

  // Progress widget + preconditions — deferred to after model selection so the
  // widget's first render tick shows the correct model (#2899).
  deps.updateProgressWidget(ctx, unitType, unitId, state);
  deps.ensurePreconditions(unitType, unitId, s.basePath, state);

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
    sessionFile,
  );
  deps.writeLock(
    deps.lockBase(),
    unitType,
    unitId,
    sessionFile,
  );

  // Tag the most recent window entry with error info for stuck detection
  const lastEntry = loopState.recentUnits[loopState.recentUnits.length - 1];
  if (lastEntry) {
    if (unitResult.errorContext) {
      lastEntry.error = `${unitResult.errorContext.category}:${unitResult.errorContext.message}`.slice(0, 200);
    } else if (unitResult.status === "error" || unitResult.status === "cancelled") {
      lastEntry.error = `${unitResult.status}:${unitType}/${unitId}`;
    } else if (unitResult.event?.messages?.length) {
      const lastMsg = unitResult.event.messages[unitResult.event.messages.length - 1];
      const msgStr = typeof lastMsg === "string" ? lastMsg : JSON.stringify(lastMsg);
      if (/error|fail|exception/i.test(msgStr)) {
        lastEntry.error = msgStr.slice(0, 200);
      }
    }
  }

  if (unitResult.status === "cancelled") {
    // Provider-error pause: pauseAuto already handled cleanup and scheduled
    // recovery. Don't hard-stop — just break out of the loop (#2762).
    if (unitResult.errorContext?.category === "provider") {
      await emitCancelledUnitEnd(ic, unitType, unitId, unitStartSeq, unitResult.errorContext);
      debugLog("autoLoop", { phase: "exit", reason: "provider-pause", isTransient: unitResult.errorContext.isTransient });
      return { action: "break", reason: "provider-pause" };
    }
    // Timeout category covers two distinct scenarios:
    //   1. Session creation timeout (120s) — transient, auto-resume with backoff
    //   2. Unit hard timeout (30min+) — stuck agent, pause for manual review
    // Structural errors (TypeError, is not a function) are NOT transient
    // and must hard-stop to avoid infinite retry loops.
    if (
      unitResult.errorContext?.isTransient &&
      unitResult.errorContext?.category === "timeout"
    ) {
      const isSessionCreationTimeout = unitResult.errorContext.message?.includes("Session creation timed out");

      if (isSessionCreationTimeout) {
        consecutiveSessionTimeouts += 1;
        const baseRetryAfterMs = 30_000;
        const retryAfterMs = baseRetryAfterMs * 2 ** Math.max(0, consecutiveSessionTimeouts - 1);
        const allowAutoResume = consecutiveSessionTimeouts <= MAX_SESSION_TIMEOUT_AUTO_RESUMES;

        if (!allowAutoResume) {
          ctx.ui.notify(
            `Session creation timed out ${consecutiveSessionTimeouts} consecutive times for ${unitType} ${unitId}. Pausing for manual review.`,
            "warning",
          );
        }

        debugLog("autoLoop", {
          phase: "session-timeout-pause",
          unitType, unitId,
          consecutiveSessionTimeouts,
          retryAfterMs,
          allowAutoResume,
        });

        const errorDetail = ` for ${unitType} ${unitId}`;
        await pauseAutoForProviderError(
          ctx.ui,
          errorDetail,
          () => deps.pauseAuto(ctx, pi),
          {
            isRateLimit: false,
            isTransient: allowAutoResume,
            retryAfterMs,
            resume: allowAutoResume
              ? () => {
                  void resumeAutoAfterProviderDelay(pi, ctx).catch((err) => {
                    const message = err instanceof Error ? err.message : String(err);
                    ctx.ui.notify(
                      `Session timeout recovery failed: ${message}`,
                      "error",
                    );
                  });
                }
              : undefined,
          },
        );
        await deps.autoCommitUnit?.(s.basePath, unitType, unitId, ctx);
        await emitCancelledUnitEnd(ic, unitType, unitId, unitStartSeq, unitResult.errorContext);
        return { action: "break", reason: "session-timeout" };
      }

      // Unit hard timeout (30min+): pause without auto-resume — stuck agent
      ctx.ui.notify(
        `Unit timed out for ${unitType} ${unitId} (supervision may have failed). Pausing auto-mode.`,
        "warning",
      );
      debugLog("autoLoop", { phase: "unit-hard-timeout-pause", unitType, unitId });
      await deps.pauseAuto(ctx, pi);
      await deps.autoCommitUnit?.(s.basePath, unitType, unitId, ctx);
      await emitCancelledUnitEnd(ic, unitType, unitId, unitStartSeq, unitResult.errorContext);
      return { action: "break", reason: "unit-hard-timeout" };
    }
    // All other cancelled states (structural errors, non-transient failures): hard stop
    if (s.currentUnit) {
      await deps.closeoutUnit(
        ctx,
        s.basePath,
        unitType,
        unitId,
        s.currentUnit.startedAt,
        deps.buildSnapshotOpts(unitType, unitId),
      );
    }
    await deps.autoCommitUnit?.(s.basePath, unitType, unitId, ctx);
    await emitCancelledUnitEnd(ic, unitType, unitId, unitStartSeq, unitResult.errorContext);
    ctx.ui.notify(
      `Session creation failed for ${unitType} ${unitId}: ${unitResult.errorContext?.message ?? "unknown"}. Stopping auto-mode.`,
      "warning",
    );
    await deps.stopAuto(ctx, pi, `Session creation failed: ${unitResult.errorContext?.message ?? "unknown"}`);
    debugLog("autoLoop", { phase: "exit", reason: "session-failed" });
    return { action: "break", reason: "session-failed" };
  }

  // ── Immediate unit closeout (metrics, activity log, memory) ────────
  // Run right after runUnit() returns so telemetry is never lost to a
  // crash between iterations.
  // Guard: stopAuto() may have nulled s.currentUnit via s.reset() while
  // this coroutine was suspended at `await runUnit(...)` (#2939).
  if (s.currentUnit) {
    // Reset session timeout counter — any successful unit clears the slate
    consecutiveSessionTimeouts = 0;
    await deps.closeoutUnit(
      ctx,
      s.basePath,
      unitType,
      unitId,
      s.currentUnit.startedAt,
      deps.buildSnapshotOpts(unitType, unitId),
    );
  }

  // ── Zero tool-call guard (#1833, #2653) ──────────────────────────
  // Any unit that completes with 0 tool calls made no real progress —
  // likely context exhaustion where all tool calls errored out. Treat
  // as failed so the unit is retried in a fresh context instead of
  // silently passing through to artifact verification (which loops
  // forever when the unit never produced its artifact).
  {
    const currentLedger = deps.getLedger() as { units: Array<{ type: string; id: string; startedAt: number; toolCalls: number }> } | null;
    if (currentLedger?.units) {
      const lastUnit = [...currentLedger.units].reverse().find(
        (u: { type: string; id: string; startedAt: number; toolCalls: number }) => u.type === unitType && u.id === unitId && u.startedAt === s.currentUnit?.startedAt,
      );
      if (lastUnit && lastUnit.toolCalls === 0) {
        debugLog("runUnitPhase", {
          phase: "zero-tool-calls",
          unitType,
          unitId,
          warning: "Unit completed with 0 tool calls — likely context exhaustion, marking as failed",
        });
        ctx.ui.notify(
          `${unitType} ${unitId} completed with 0 tool calls — context exhaustion, will retry`,
          "warning",
        );
        // Fall through to next iteration where dispatch will re-derive
        // and re-dispatch this unit.
        return { action: "next", data: { unitStartedAt: s.currentUnit?.startedAt } };
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
    verifyExpectedArtifact(unitType, unitId, s.basePath);
  if (artifactVerified) {
    s.unitDispatchCount.delete(dispatchKey);
    s.unitRecoveryCount.delete(`${unitType}/${unitId}`);
  }

  // Write phase handoff anchor after successful research/planning completion
  const anchorPhases = new Set(["research-milestone", "research-slice", "plan-milestone", "plan-slice"]);
  if (artifactVerified && mid && anchorPhases.has(unitType)) {
    try {
      const { writePhaseAnchor } = await import("../phase-anchor.js");
      writePhaseAnchor(s.basePath, mid, {
        phase: unitType,
        milestoneId: mid,
        generatedAt: new Date().toISOString(),
        intent: `Completed ${unitType} for ${unitId}`,
        decisions: [],
        blockers: [],
        nextSteps: [],
      });
    } catch (err) { /* non-fatal — anchor is advisory */
      logWarning("engine", `phase anchor failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "unit-end", data: { unitType, unitId, status: unitResult.status, artifactVerified, ...(unitResult.errorContext ? { errorContext: unitResult.errorContext } : {}) }, causedBy: { flowId: ic.flowId, seq: unitStartSeq } });

  // ── Safety harness: checkpoint cleanup or rollback ──
  if (s.checkpointSha) {
    if (unitResult.status === "error" && safetyConfig.auto_rollback) {
      const rolled = rollbackToCheckpoint(s.basePath, unitId, s.checkpointSha);
      if (rolled) {
        ctx.ui.notify(`Rolled back to pre-unit checkpoint for ${unitId}`, "info");
        debugLog("runUnitPhase", { phase: "checkpoint-rollback", unitId });
      }
    } else if (unitResult.status === "error") {
      ctx.ui.notify(
        `Unit ${unitId} failed. Pre-unit checkpoint available at ${s.checkpointSha.slice(0, 8)}`,
        "warning",
      );
    } else {
      // Success — clean up checkpoint ref
      cleanupCheckpoint(s.basePath, unitId);
      debugLog("runUnitPhase", { phase: "checkpoint-cleaned", unitId });
    }
    s.checkpointSha = null;
  }

  return { action: "next", data: { unitStartedAt: s.currentUnit?.startedAt } };
}

// ─── runFinalize ──────────────────────────────────────────────────────────────

/**
 * Phase 5: Post-unit finalize — pre/post verification, UAT pause, step-wizard.
 * Returns break/continue/next to control the outer loop.
 */
export async function runFinalize(
  ic: IterationContext,
  iterData: IterationData,
  loopState: LoopState,
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
  // Timeout guard: if postUnitPreVerification hangs (e.g., safety harness
  // deadlock, browser teardown hang, worktree sync stall), force-continue
  // after timeout so the auto-loop is not permanently frozen (#3757).
  //
  // On timeout, null out s.currentUnit so the timed-out task's late async
  // mutations are harmless — postUnitPreVerification guards all side effects
  // behind `if (s.currentUnit)`. The next iteration sets a fresh currentUnit.
  // Sidecar items use lightweight pre-verification opts
  const preVerificationOpts: PreVerificationOpts | undefined = sidecarItem
    ? sidecarItem.kind === "hook"
      ? { skipSettleDelay: true, skipWorktreeSync: true }
      : { skipSettleDelay: true }
    : undefined;
  const preUnitSnapshot = s.currentUnit
    ? { type: s.currentUnit.type, id: s.currentUnit.id, startedAt: s.currentUnit.startedAt }
    : null;
  const preResultGuard = await withTimeout(
    deps.postUnitPreVerification(postUnitCtx, preVerificationOpts),
    FINALIZE_PRE_TIMEOUT_MS,
    "postUnitPreVerification",
  );

  if (preResultGuard.timedOut) {
    return failClosedOnFinalizeTimeout(
      ic,
      iterData,
      loopState,
      "pre",
      preUnitSnapshot?.startedAt ?? Date.now(),
    );
  }

  const preResult = preResultGuard.value;
  if (preResult === "dispatched") {
    const dispatchedReason = s.lastGitActionFailure
      ? "git-closeout-failure"
      : "pre-verification-dispatched";
    debugLog("autoLoop", {
      phase: "exit",
      reason: dispatchedReason,
      gitError: s.lastGitActionFailure ?? undefined,
    });
    return { action: "break", reason: dispatchedReason };
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
  // Timeout guard: if postUnitPostVerification hangs (e.g., module import
  // deadlock, SQLite transaction hang), force-continue after timeout so the
  // auto-loop is not permanently frozen (#2344).
  const postResultGuard = await withTimeout(
    deps.postUnitPostVerification(postUnitCtx),
    FINALIZE_POST_TIMEOUT_MS,
    "postUnitPostVerification",
  );

  if (postResultGuard.timedOut) {
    return failClosedOnFinalizeTimeout(
      ic,
      iterData,
      loopState,
      "post",
      preUnitSnapshot?.startedAt ?? Date.now(),
    );
  }

  const postResult = postResultGuard.value;

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

  // Both pre and post verification completed without timeout — reset counter
  loopState.consecutiveFinalizeTimeouts = 0;

  // Surface accumulated workflow-logger issues for this unit to the user.
  // Warnings/errors logged during the unit are buffered in the logger and
  // drained here so the user sees a single consolidated post-unit alert.
  if (hasAnyIssues()) {
    const { logs } = drainAndSummarize();
    if (logs.length > 0) {
      const severity = logs.some((e) => e.severity === "error") ? "error" : "warning";
      ctx.ui.notify(formatForNotification(logs), severity);
    }
  }

  return { action: "next", data: undefined as void };
}
