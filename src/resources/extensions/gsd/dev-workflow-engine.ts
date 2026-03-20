/**
 * DevWorkflowEngine — wraps existing GSD auto-mode functions behind the
 * WorkflowEngine interface. This is the "dev" engine that delegates to
 * state.ts, auto-dispatch.ts, and friends.
 *
 * Created in S02. Only deriveState/resolveDispatch are wired into the loop
 * during S02; reconcile is a simple pass-through until S03+.
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
import { deriveState as deriveGSDState } from "./state.js";
import { resolveDispatch as resolveGSDDispatch } from "./auto-dispatch.js";
import type { DispatchAction } from "./auto-dispatch.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function mapGSDStateToEngineState(gsdState: GSDState): EngineState {
  return {
    phase: gsdState.phase,
    currentMilestoneId: gsdState.activeMilestone?.id ?? null,
    activeSliceId: gsdState.activeSlice?.id ?? null,
    activeTaskId: gsdState.activeTask?.id ?? null,
    isComplete: gsdState.phase === "complete",
    raw: gsdState,
  };
}

/**
 * Bridge a GSD DispatchAction into an EngineDispatchAction.
 * The two types have the same discriminants but different shapes for "dispatch".
 * Exported for contract testing.
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
      return { action: "stop", reason: da.reason, level: da.level };
    case "skip":
      return { action: "skip" };
  }
}

function buildProgressSummary(gsdState: GSDState): string {
  const parts: string[] = [];
  if (gsdState.activeMilestone) parts.push(gsdState.activeMilestone.id);
  if (gsdState.activeSlice) parts.push(gsdState.activeSlice.id);
  if (gsdState.activeTask) parts.push(gsdState.activeTask.id);
  return parts.length > 0 ? parts.join(" → ") : "No active milestone";
}

function buildStepCount(gsdState: GSDState): { completed: number; total: number } | null {
  if (gsdState.progress?.tasks) {
    return { completed: gsdState.progress.tasks.done, total: gsdState.progress.tasks.total };
  }
  return null;
}

// ─── DevWorkflowEngine ───────────────────────────────────────────────────

export class DevWorkflowEngine implements WorkflowEngine {
  readonly engineId = "dev" as const;

  async deriveState(basePath: string): Promise<EngineState> {
    const gsdState = await deriveGSDState(basePath);
    return mapGSDStateToEngineState(gsdState);
  }

  async resolveDispatch(
    state: EngineState,
    context: { basePath: string },
  ): Promise<EngineDispatchAction> {
    const gsdState = state.raw as GSDState;

    // No active milestone → stop (matches existing behavior in auto.ts)
    if (!gsdState.activeMilestone) {
      return { action: "stop", reason: "No active milestone", level: "info" };
    }

    const loaded = loadEffectiveGSDPreferences();
    const prefs = loaded?.preferences;

    const dispatchAction = await resolveGSDDispatch({
      basePath: context.basePath,
      mid: gsdState.activeMilestone.id,
      midTitle: gsdState.activeMilestone.title,
      state: gsdState,
      prefs,
    });

    return bridgeDispatchAction(dispatchAction);
  }

  async reconcile(
    state: EngineState,
    _completedStep: CompletedStep,
  ): Promise<ReconcileResult> {
    // Simple pass-through for S02; full delegation is S03+
    return {
      outcome: state.isComplete ? "milestone-complete" : "continue",
    };
  }

  getDisplayMetadata(state: EngineState): DisplayMetadata {
    const gsdState = state.raw as GSDState;
    return {
      engineLabel: "GSD Dev",
      currentPhase: gsdState.phase,
      progressSummary: buildProgressSummary(gsdState),
      stepCount: buildStepCount(gsdState),
    };
  }
}
