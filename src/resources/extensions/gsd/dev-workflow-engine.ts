/**
 * dev-workflow-engine.ts — DevWorkflowEngine implementation.
 *
 * Implements WorkflowEngine by delegating to existing GSD state derivation
 * and dispatch logic. This is the "dev" engine — it wraps the current GSD
 * auto-mode behavior behind the engine-polymorphic interface.
 */

import type { WorkflowEngine } from "./workflow-engine.js";
import type {
  EngineState,
  EngineDispatchAction,
  CompletedStep,
  ReconcileResult,
  DisplayMetadata,
} from "./engine-types.js";
import type { GSDState } from "./types.js";
import type { DispatchAction, DispatchContext } from "./auto-dispatch.js";

import { deriveState } from "./state.js";
import { resolveDispatch } from "./auto-dispatch.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";

// ─── Bridge: DispatchAction → EngineDispatchAction ────────────────────────

/**
 * Map a GSD-specific DispatchAction (which carries `matchedRule`, `unitType`,
 * etc.) to the engine-generic EngineDispatchAction discriminated union.
 *
 * Exported for unit testing.
 */
export function bridgeDispatchAction(da: DispatchAction): EngineDispatchAction {
  switch (da.action) {
    case "dispatch":
      return {
        action: "dispatch",
        step: {
          unitType: da.unitType,
          unitId: da.unitId,
          prompt: da.prompt,
        },
      };
    case "stop":
      return {
        action: "stop",
        reason: da.reason,
        level: da.level,
      };
    case "skip":
      return { action: "skip" };
  }
}

// ─── DevWorkflowEngine ───────────────────────────────────────────────────

export class DevWorkflowEngine implements WorkflowEngine {
  readonly engineId = "dev" as const;

  async deriveState(basePath: string): Promise<EngineState> {
    const gsd: GSDState = await deriveState(basePath);
    return {
      phase: gsd.phase,
      currentMilestoneId: gsd.activeMilestone?.id ?? null,
      activeSliceId: gsd.activeSlice?.id ?? null,
      activeTaskId: gsd.activeTask?.id ?? null,
      isComplete: gsd.phase === "complete",
      raw: gsd,
    };
  }

  async resolveDispatch(
    state: EngineState,
    context: { basePath: string },
  ): Promise<EngineDispatchAction> {
    const gsd = state.raw as GSDState;
    const mid = gsd.activeMilestone?.id ?? "";
    const midTitle = gsd.activeMilestone?.title ?? "";
    const loaded = loadEffectiveGSDPreferences();
    const prefs = loaded?.preferences ?? undefined;

    const dispatchCtx: DispatchContext = {
      basePath: context.basePath,
      mid,
      midTitle,
      state: gsd,
      prefs,
    };

    const result = await resolveDispatch(dispatchCtx);
    return bridgeDispatchAction(result);
  }

  async reconcile(
    state: EngineState,
    _completedStep: CompletedStep,
  ): Promise<ReconcileResult> {
    return {
      outcome: state.isComplete ? "milestone-complete" : "continue",
    };
  }

  getDisplayMetadata(state: EngineState): DisplayMetadata {
    return {
      engineLabel: "GSD Dev",
      currentPhase: state.phase,
      progressSummary: `${state.currentMilestoneId ?? "no milestone"} / ${state.activeSliceId ?? "—"} / ${state.activeTaskId ?? "—"}`,
      stepCount: null,
    };
  }
}
