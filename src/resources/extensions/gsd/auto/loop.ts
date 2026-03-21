/**
 * auto/loop.ts — Main auto-mode execution loop.
 *
 * Iterates: derive → dispatch → guards → runUnit → finalize → repeat.
 * Exits when s.active becomes false or a terminal condition is reached.
 *
 * Imports from: auto/types, auto/resolve, auto/phases
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

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
import { isInfrastructureError } from "./infra-errors.js";

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
  const loopState: LoopState = { recentUnits: [], stuckRecoveryAttempts: 0 };
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

      const ic: IterationContext = { ctx, pi, s, deps, prefs, iteration };
      let iterData: IterationData;

      if (!sidecarItem) {
        // ── Phase 1: Pre-dispatch ─────────────────────────────────────────
        const preDispatchResult = await runPreDispatch(ic, loopState);
        if (preDispatchResult.action === "break") break;
        if (preDispatchResult.action === "continue") continue;

        const preData = preDispatchResult.data;

        // ── Phase 2: Guards ───────────────────────────────────────────────
        const guardsResult = await runGuards(ic, preData.mid);
        if (guardsResult.action === "break") break;

        // ── Phase 3: Dispatch ─────────────────────────────────────────────
        const dispatchResult = await runDispatch(ic, preData, loopState);
        if (dispatchResult.action === "break") break;
        if (dispatchResult.action === "continue") continue;
        iterData = dispatchResult.data;
      } else {
        // ── Sidecar path: use values from the sidecar item directly ──
        const sidecarState = await deps.deriveState(s.basePath);
        iterData = {
          unitType: sidecarItem.unitType,
          unitId: sidecarItem.unitId,
          prompt: sidecarItem.prompt,
          finalPrompt: sidecarItem.prompt,
          pauseAfterUatDispatch: false,
          observabilityIssues: [],
          state: sidecarState,
          mid: sidecarState.activeMilestone?.id,
          midTitle: sidecarState.activeMilestone?.title,
          isRetry: false, previousTier: undefined,
        };
      }

      const unitPhaseResult = await runUnitPhase(ic, iterData, loopState, sidecarItem);
      if (unitPhaseResult.action === "break") break;

      // ── Phase 5: Finalize ───────────────────────────────────────────────

      const finalizeResult = await runFinalize(ic, iterData, sidecarItem);
      if (finalizeResult.action === "break") break;
      if (finalizeResult.action === "continue") continue;

      consecutiveErrors = 0; // Iteration completed successfully
      debugLog("autoLoop", { phase: "iteration-complete", iteration });
    } catch (loopErr) {
      // ── Blanket catch: absorb unexpected exceptions, apply graduated recovery ──
      const msg = loopErr instanceof Error ? loopErr.message : String(loopErr);

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
        break;
      }

      consecutiveErrors++;
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

  _clearCurrentResolve();
  debugLog("autoLoop", { phase: "exit", totalIterations: iteration });
}
