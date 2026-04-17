/**
 * auto/loop.ts — Main auto-mode execution loop.
 *
 * Iterates: derive → dispatch → guards → runUnit → finalize → repeat.
 * Exits when s.active becomes false or a terminal condition is reached.
 *
 * Imports from: auto/types, auto/resolve, auto/phases
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

import { randomUUID } from "node:crypto";
import type { AutoSession, SidecarItem } from "./session.js";
import type { LoopDeps } from "./loop-deps.js";
import {
  MAX_LOOP_ITERATIONS,
  type LoopState,
  type IterationContext,
  type IterationData,
} from "./types.js";
import { _clearCurrentResolve } from "./resolve.js";
import {
  runPreDispatch,
  runDispatch,
  runGuards,
  runUnitPhase,
  runFinalize,
} from "./phases.js";
import { debugLog } from "../debug-logger.js";
import { isInfrastructureError, isTransientCooldownError, getCooldownRetryAfterMs, COOLDOWN_FALLBACK_WAIT_MS, MAX_COOLDOWN_RETRIES } from "./infra-errors.js";
import { resolveEngine } from "../engine-resolver.js";
import { logWarning } from "../workflow-logger.js";
import { gsdRoot } from "../paths.js";
import { resolveUokFlags } from "../uok/flags.js";
import { scheduleSidecarQueue } from "../uok/execution-graph.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ── Stuck detection persistence (#3704) ──────────────────────────────────
// Persist stuck detection state to disk so it survives session restarts.
// Without this, restarting auto-mode resets all counters, allowing the
// same blocked unit to burn a full retry budget each session.
function stuckStatePath(basePath: string): string {
  return join(gsdRoot(basePath), "runtime", "stuck-state.json");
}

function loadStuckState(basePath: string): { recentUnits: Array<{ key: string }>; stuckRecoveryAttempts: number } {
  try {
    const data = JSON.parse(readFileSync(stuckStatePath(basePath), "utf-8"));
    return {
      recentUnits: Array.isArray(data.recentUnits) ? data.recentUnits : [],
      stuckRecoveryAttempts: typeof data.stuckRecoveryAttempts === "number" ? data.stuckRecoveryAttempts : 0,
    };
  } catch (err) {
    debugLog("autoLoop", { phase: "load-stuck-state-failed", error: err instanceof Error ? err.message : String(err) });
    return { recentUnits: [], stuckRecoveryAttempts: 0 };
  }
}

function saveStuckState(basePath: string, state: LoopState): void {
  try {
    const filePath = stuckStatePath(basePath);
    mkdirSync(join(gsdRoot(basePath), "runtime"), { recursive: true });
    writeFileSync(filePath, JSON.stringify({
      recentUnits: state.recentUnits.slice(-20), // keep last 20 entries
      stuckRecoveryAttempts: state.stuckRecoveryAttempts,
      updatedAt: new Date().toISOString(),
    }) + "\n");
  } catch (err) {
    debugLog("autoLoop", { phase: "save-stuck-state-failed", error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Memory pressure monitoring (#3331) ──────────────────────────────────
// Check heap usage every N iterations and trigger graceful shutdown before
// the OS OOM killer sends SIGKILL. The threshold is 90% of the V8 heap
// limit (--max-old-space-size or default ~1.5-4GB depending on platform).
const MEMORY_CHECK_INTERVAL = 5; // check every 5 iterations
const MEMORY_PRESSURE_THRESHOLD = 0.85; // 85% of heap limit

function checkMemoryPressure(): { pressured: boolean; heapMB: number; limitMB: number; pct: number } {
  const mem = process.memoryUsage();
  // v8.getHeapStatistics() gives heap_size_limit but requires import
  // Use a conservative estimate: RSS > 3GB is danger zone on most systems
  const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  // Try to get the actual V8 heap limit
  let limitMB = 4096; // conservative default
  try {
    const v8 = require("node:v8");
    const stats = v8.getHeapStatistics();
    limitMB = Math.round(stats.heap_size_limit / 1024 / 1024);
  } catch { limitMB = 4096; /* v8 stats unavailable — use conservative default */ }
  const pct = heapMB / limitMB;
  return { pressured: pct > MEMORY_PRESSURE_THRESHOLD, heapMB, limitMB, pct };
}

/**
 * Main auto-mode execution loop. Iterates: derive → dispatch → guards →
 * runUnit → finalize → repeat. Exits when s.active becomes false or a
 * terminal condition is reached.
 *
 * This is the linear replacement for the recursive
 * dispatchNextUnit → resolveAgentEnd → dispatchNextUnit chain.
 */
export async function autoLoop(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  s: AutoSession,
  deps: LoopDeps,
): Promise<void> {
  debugLog("autoLoop", { phase: "enter" });
  let iteration = 0;
  // Load persisted stuck state so counters survive session restarts (#3704)
  const persisted = loadStuckState(s.basePath);
  const loopState: LoopState = {
    recentUnits: persisted.recentUnits,
    stuckRecoveryAttempts: persisted.stuckRecoveryAttempts,
    consecutiveFinalizeTimeouts: 0,
  };
  let consecutiveErrors = 0;
  let consecutiveCooldowns = 0;
  const recentErrorMessages: string[] = [];

  while (s.active) {
    iteration++;
    debugLog("autoLoop", { phase: "loop-top", iteration });

    // ── Journal: per-iteration flow grouping ──
    const flowId = randomUUID();
    let seqCounter = 0;
    const nextSeq = () => ++seqCounter;
    const turnId = randomUUID();
    s.currentTraceId = flowId;
    s.currentTurnId = turnId;
    const turnStartedAt = new Date().toISOString();
    let observedUnitType: string | undefined;
    let observedUnitId: string | undefined;
    let turnFinished = false;
    const finishTurn = (
      status: "completed" | "failed" | "paused" | "stopped" | "skipped" | "retry",
      failureClass: "none" | "unknown" | "manual-attention" | "timeout" | "execution" | "closeout" | "git" = "none",
      error?: string,
    ): void => {
      if (turnFinished) return;
      turnFinished = true;
      deps.uokObserver?.onTurnResult({
        traceId: flowId,
        turnId,
        iteration,
        unitType: observedUnitType,
        unitId: observedUnitId,
        status,
        failureClass,
        phaseResults: [],
        error,
        startedAt: turnStartedAt,
        finishedAt: new Date().toISOString(),
      });
      s.currentTraceId = null;
      s.currentTurnId = null;
    };
    deps.uokObserver?.onTurnStart({
      traceId: flowId,
      turnId,
      iteration,
      basePath: s.basePath,
      startedAt: turnStartedAt,
    });

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
      finishTurn("stopped", "manual-attention", "max-iterations");
      break;
    }

    // ── Memory pressure check (#3331) ──
    // Graceful shutdown before OOM killer sends SIGKILL.
    if (iteration % MEMORY_CHECK_INTERVAL === 0) {
      const mem = checkMemoryPressure();
      debugLog("autoLoop", { phase: "memory-check", ...mem });
      if (mem.pressured) {
        logWarning("dispatch", `Memory pressure: ${mem.heapMB}MB / ${mem.limitMB}MB (${Math.round(mem.pct * 100)}%) — stopping auto-mode to prevent OOM kill`);
        await deps.stopAuto(
          ctx,
          pi,
          `Memory pressure: heap at ${mem.heapMB}MB / ${mem.limitMB}MB (${Math.round(mem.pct * 100)}%). ` +
          `Stopping gracefully to prevent OOM kill after ${iteration} iterations. ` +
          `Resume with /gsd auto to continue from where you left off.`,
        );
        finishTurn("stopped", "timeout", "memory-pressure");
        break;
      }
    }

    if (!s.cmdCtx) {
      debugLog("autoLoop", { phase: "exit", reason: "no-cmdCtx" });
      finishTurn("stopped", "manual-attention", "missing-command-context");
      break;
    }

    try {
      // ── Blanket try/catch: one bad iteration must not kill the session
      const prefs = deps.loadEffectiveGSDPreferences()?.preferences;
      const uokFlags = resolveUokFlags(prefs);

      // ── Check sidecar queue before deriveState ──
      let sidecarItem: SidecarItem | undefined;
      if (s.sidecarQueue.length > 0) {
        if (uokFlags.executionGraph && s.sidecarQueue.length > 1) {
          try {
            s.sidecarQueue = await scheduleSidecarQueue(s.sidecarQueue);
          } catch (err) {
            logWarning("dispatch", `sidecar queue scheduling failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        sidecarItem = s.sidecarQueue.shift()!;
        debugLog("autoLoop", {
          phase: "sidecar-dequeue",
          kind: sidecarItem.kind,
          unitType: sidecarItem.unitType,
          unitId: sidecarItem.unitId,
        });
        deps.emitJournalEvent({ ts: new Date().toISOString(), flowId, seq: nextSeq(), eventType: "sidecar-dequeue", data: { kind: sidecarItem.kind, unitType: sidecarItem.unitType, unitId: sidecarItem.unitId } });
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

      const ic: IterationContext = { ctx, pi, s, deps, prefs, iteration, flowId, nextSeq };
      deps.emitJournalEvent({ ts: new Date().toISOString(), flowId, seq: nextSeq(), eventType: "iteration-start", data: { iteration } });
      let iterData: IterationData;

      // ── Custom engine path ──────────────────────────────────────────────
      // When activeEngineId is a non-dev value, bypass runPreDispatch and
      // runDispatch entirely — the custom engine drives its own state via
      // GRAPH.yaml. Shares runGuards and runUnitPhase with the dev path.
      // After unit execution, verifies then reconciles via the engine layer.
      //
      // GSD_ENGINE_BYPASS=1 skips the engine layer entirely — falls through
      // to the dev path below.
      if (s.activeEngineId != null && s.activeEngineId !== "dev" && !sidecarItem && process.env.GSD_ENGINE_BYPASS !== "1") {
        debugLog("autoLoop", { phase: "custom-engine-derive", iteration, engineId: s.activeEngineId });

        const { engine, policy } = resolveEngine({
          activeEngineId: s.activeEngineId,
          activeRunDir: s.activeRunDir,
        });

        const engineState = await engine.deriveState(s.basePath);
        if (engineState.isComplete) {
          await deps.stopAuto(ctx, pi, "Workflow complete");
          break;
        }

        debugLog("autoLoop", { phase: "custom-engine-dispatch", iteration });
        const dispatch = await engine.resolveDispatch(engineState, { basePath: s.basePath });

        if (dispatch.action === "stop") {
          await deps.stopAuto(ctx, pi, dispatch.reason ?? "Engine stopped");
          break;
        }
        if (dispatch.action === "skip") {
          continue;
        }

        // dispatch.action === "dispatch"
        const step = dispatch.step!;
        const gsdState = await deps.deriveState(s.basePath);

        iterData = {
          unitType: step.unitType,
          unitId: step.unitId,
          prompt: step.prompt,
          finalPrompt: step.prompt,
          pauseAfterUatDispatch: false,
          state: gsdState,
          mid: s.currentMilestoneId ?? "workflow",
          midTitle: "Workflow",
          isRetry: false,
          previousTier: undefined,
        };
        observedUnitType = iterData.unitType;
        observedUnitId = iterData.unitId;

        // ── Progress widget (mirrors dev path in runDispatch) ──
        deps.updateProgressWidget(ctx, iterData.unitType, iterData.unitId, iterData.state);

        // ── Guards (shared with dev path) ──
        const guardsResult = await runGuards(ic, s.currentMilestoneId ?? "workflow");
        deps.uokObserver?.onPhaseResult("guard", guardsResult.action, {
          unitType: iterData.unitType,
          unitId: iterData.unitId,
        });
        if (guardsResult.action === "break") {
          finishTurn("stopped", "manual-attention", "guard-break");
          break;
        }

        // ── Unit execution (shared with dev path) ──
        const unitPhaseResult = await runUnitPhase(ic, iterData, loopState);
        deps.uokObserver?.onPhaseResult("unit", unitPhaseResult.action, {
          unitType: iterData.unitType,
          unitId: iterData.unitId,
        });
        if (unitPhaseResult.action === "break") {
          finishTurn("stopped", "execution", "unit-break");
          break;
        }

        // ── Verify first, then reconcile (only mark complete on pass) ──
        debugLog("autoLoop", { phase: "custom-engine-verify", iteration, unitId: iterData.unitId });
        const verifyResult = await policy.verify(iterData.unitType, iterData.unitId, { basePath: s.basePath });
        if (verifyResult === "pause") {
          await deps.pauseAuto(ctx, pi);
          deps.uokObserver?.onPhaseResult("custom-engine", "pause", {
            unitType: iterData.unitType,
            unitId: iterData.unitId,
          });
          finishTurn("paused", "manual-attention", "custom-engine-verify-pause");
          break;
        }
        if (verifyResult === "retry") {
          debugLog("autoLoop", { phase: "custom-engine-verify-retry", iteration, unitId: iterData.unitId });
          deps.uokObserver?.onPhaseResult("custom-engine", "retry", {
            unitType: iterData.unitType,
            unitId: iterData.unitId,
          });
          finishTurn("retry");
          continue;
        }

        // Verification passed — mark step complete
        debugLog("autoLoop", { phase: "custom-engine-reconcile", iteration, unitId: iterData.unitId });
        const reconcileResult = await engine.reconcile(engineState, {
          unitType: iterData.unitType,
          unitId: iterData.unitId,
          startedAt: s.currentUnit?.startedAt ?? Date.now(),
          finishedAt: Date.now(),
        });

        deps.clearUnitTimeout();
        consecutiveErrors = 0;
        consecutiveCooldowns = 0;
        recentErrorMessages.length = 0;
        deps.emitJournalEvent({ ts: new Date().toISOString(), flowId, seq: nextSeq(), eventType: "iteration-end", data: { iteration } });
        saveStuckState(s.basePath, loopState); // persist across session restarts (#3704)
        debugLog("autoLoop", { phase: "iteration-complete", iteration });

        if (reconcileResult.outcome === "milestone-complete") {
          await deps.stopAuto(ctx, pi, "Workflow complete");
          deps.uokObserver?.onPhaseResult("custom-engine", "milestone-complete", {
            unitType: iterData.unitType,
            unitId: iterData.unitId,
          });
          finishTurn("completed");
          break;
        }
        if (reconcileResult.outcome === "pause") {
          await deps.pauseAuto(ctx, pi);
          deps.uokObserver?.onPhaseResult("custom-engine", "pause", {
            unitType: iterData.unitType,
            unitId: iterData.unitId,
          });
          finishTurn("paused", "manual-attention");
          break;
        }
        if (reconcileResult.outcome === "stop") {
          await deps.stopAuto(ctx, pi, reconcileResult.reason ?? "Engine stopped");
          deps.uokObserver?.onPhaseResult("custom-engine", "stop", {
            unitType: iterData.unitType,
            unitId: iterData.unitId,
            reason: reconcileResult.reason,
          });
          finishTurn("stopped", "manual-attention", reconcileResult.reason);
          break;
        }
        deps.uokObserver?.onPhaseResult("custom-engine", "continue", {
          unitType: iterData.unitType,
          unitId: iterData.unitId,
        });
        finishTurn("completed");
        continue;
      }

      if (!sidecarItem) {
        // ── Phase 1: Pre-dispatch ─────────────────────────────────────────
        const preDispatchResult = await runPreDispatch(ic, loopState);
        deps.uokObserver?.onPhaseResult("pre-dispatch", preDispatchResult.action);
        if (preDispatchResult.action === "break") {
          finishTurn("stopped", "manual-attention", "pre-dispatch-break");
          break;
        }
        if (preDispatchResult.action === "continue") {
          finishTurn("skipped");
          continue;
        }

        const preData = preDispatchResult.data;

        // ── Phase 2: Guards ───────────────────────────────────────────────
        const guardsResult = await runGuards(ic, preData.mid);
        deps.uokObserver?.onPhaseResult("guard", guardsResult.action);
        if (guardsResult.action === "break") {
          finishTurn("stopped", "manual-attention", "guard-break");
          break;
        }

        // ── Phase 3: Dispatch ─────────────────────────────────────────────
        const dispatchResult = await runDispatch(ic, preData, loopState);
        deps.uokObserver?.onPhaseResult("dispatch", dispatchResult.action);
        if (dispatchResult.action === "break") {
          finishTurn("stopped", "manual-attention", "dispatch-break");
          break;
        }
        if (dispatchResult.action === "continue") {
          finishTurn("skipped");
          continue;
        }
        iterData = dispatchResult.data;
        observedUnitType = iterData.unitType;
        observedUnitId = iterData.unitId;
      } else {
        // ── Sidecar path: use values from the sidecar item directly ──
        const sidecarState = await deps.deriveState(s.basePath);
        iterData = {
          unitType: sidecarItem.unitType,
          unitId: sidecarItem.unitId,
          prompt: sidecarItem.prompt,
          finalPrompt: sidecarItem.prompt,
          pauseAfterUatDispatch: false,
          state: sidecarState,
          mid: sidecarState.activeMilestone?.id,
          midTitle: sidecarState.activeMilestone?.title,
          isRetry: false, previousTier: undefined,
        };
        observedUnitType = iterData.unitType;
        observedUnitId = iterData.unitId;
        deps.uokObserver?.onPhaseResult("dispatch", "sidecar", {
          unitType: iterData.unitType,
          unitId: iterData.unitId,
          sidecarKind: sidecarItem.kind,
        });
      }

      const unitPhaseResult = await runUnitPhase(ic, iterData, loopState, sidecarItem);
      deps.uokObserver?.onPhaseResult("unit", unitPhaseResult.action, {
        unitType: iterData.unitType,
        unitId: iterData.unitId,
      });
      if (unitPhaseResult.action === "break") {
        finishTurn("stopped", "execution", "unit-break");
        break;
      }

      // ── Phase 5: Finalize ───────────────────────────────────────────────

      const finalizeResult = await runFinalize(ic, iterData, loopState, sidecarItem);
      deps.uokObserver?.onPhaseResult("finalize", finalizeResult.action, {
        unitType: iterData.unitType,
        unitId: iterData.unitId,
      });
      if (finalizeResult.action === "break") {
        const finalizeFailureClass = finalizeResult.reason === "git-closeout-failure"
          ? "git"
          : "closeout";
        finishTurn("stopped", finalizeFailureClass, "finalize-break");
        break;
      }
      if (finalizeResult.action === "continue") {
        finishTurn("retry");
        continue;
      }

      consecutiveErrors = 0; // Iteration completed successfully
      consecutiveCooldowns = 0;
      recentErrorMessages.length = 0;
      deps.emitJournalEvent({ ts: new Date().toISOString(), flowId, seq: nextSeq(), eventType: "iteration-end", data: { iteration } });
      debugLog("autoLoop", { phase: "iteration-complete", iteration });
      finishTurn("completed");
    } catch (loopErr) {
      // ── Blanket catch: absorb unexpected exceptions, apply graduated recovery ──
      const msg = loopErr instanceof Error ? loopErr.message : String(loopErr);

      // Always emit iteration-end on error so the journal records iteration
      // completion even on failure (#2344). Without this, errors in
      // runFinalize leave the journal incomplete, making diagnosis harder.
      deps.emitJournalEvent({ ts: new Date().toISOString(), flowId, seq: nextSeq(), eventType: "iteration-end", data: { iteration, error: msg } });

      // ── Infrastructure errors: immediate stop, no retry ──
      // These are unrecoverable (disk full, OOM, etc.). Retrying just burns
      // LLM budget on guaranteed failures.
      const infraCode = isInfrastructureError(loopErr);
      if (infraCode) {
        debugLog("autoLoop", {
          phase: "infrastructure-error",
          iteration,
          code: infraCode,
          error: msg,
        });
        ctx.ui.notify(
          `Auto-mode stopped: infrastructure error ${infraCode} — ${msg}`,
          "error",
        );
        await deps.stopAuto(
          ctx,
          pi,
          `Infrastructure error (${infraCode}): not recoverable by retry`,
        );
        finishTurn("failed", "execution", msg);
        break;
      }

      // ── Credential cooldown: wait and retry with bounded budget ──
      // A 429 triggers a 30s credential backoff in AuthStorage. If the SDK's
      // getApiKey() retries couldn't outlast the window, the error surfaces
      // here. Wait for the cooldown to clear rather than counting it as a
      // consecutive failure — but cap retries so we don't spin for hours
      // on persistent quota exhaustion.
      if (isTransientCooldownError(loopErr)) {
        consecutiveCooldowns++;
        const retryAfterMs = getCooldownRetryAfterMs(loopErr);
        debugLog("autoLoop", {
          phase: "cooldown-wait",
          iteration,
          consecutiveCooldowns,
          retryAfterMs,
          error: msg,
        });

        if (consecutiveCooldowns > MAX_COOLDOWN_RETRIES) {
          ctx.ui.notify(
            `Auto-mode stopped: ${consecutiveCooldowns} consecutive credential cooldowns — rate limit or quota may be persistently exhausted.`,
            "error",
          );
          await deps.stopAuto(
            ctx,
            pi,
            `${consecutiveCooldowns} consecutive credential cooldowns exceeded retry budget`,
          );
          break;
        }

        const waitMs = (retryAfterMs !== undefined && retryAfterMs > 0 && retryAfterMs <= 60_000)
          ? retryAfterMs + 500 // Use structured hint + small buffer
          : COOLDOWN_FALLBACK_WAIT_MS;
        ctx.ui.notify(
          `Credentials in cooldown (${consecutiveCooldowns}/${MAX_COOLDOWN_RETRIES}) — waiting ${Math.round(waitMs / 1000)}s before retrying.`,
          "warning",
        );
        await new Promise(resolve => setTimeout(resolve, waitMs));
        finishTurn("retry", "timeout", msg);
        continue; // Retry iteration without incrementing consecutiveErrors
      }

      consecutiveErrors++;
      recentErrorMessages.push(msg.length > 120 ? msg.slice(0, 120) + "..." : msg);
      debugLog("autoLoop", {
        phase: "iteration-error",
        iteration,
        consecutiveErrors,
        error: msg,
      });

      if (consecutiveErrors >= 3) {
        // 3+ consecutive: hard stop — something is fundamentally broken
        const errorHistory = recentErrorMessages
          .map((m, i) => `  ${i + 1}. ${m}`)
          .join("\n");
        ctx.ui.notify(
          `Auto-mode stopped: ${consecutiveErrors} consecutive iteration failures:\n${errorHistory}`,
          "error",
        );
        await deps.stopAuto(
          ctx,
          pi,
          `${consecutiveErrors} consecutive iteration failures`,
        );
        finishTurn("failed", "execution", msg);
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
      finishTurn("retry", "execution", msg);
    }
  }

  _clearCurrentResolve();
  debugLog("autoLoop", { phase: "exit", totalIterations: iteration });
}
