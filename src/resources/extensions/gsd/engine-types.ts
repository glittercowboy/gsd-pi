/**
 * engine-types.ts — Engine-polymorphic type contracts.
 *
 * LEAF NODE: This file must have ZERO imports from any GSD module.
 * Only `node:` imports are permitted. All engine/policy interfaces
 * depend on these types; nothing here depends on GSD internals.
 */

/** Snapshot of engine state at a point in time. */
export interface EngineState {
  phase: string;
  currentMilestoneId: string | null;
  activeSliceId: string | null;
  activeTaskId: string | null;
  isComplete: boolean;
  /** Opaque engine-specific state — never narrowed to a GSD-specific type. */
  raw: unknown;
}

/** A unit of work the engine wants the agent to execute. */
export interface StepContract {
  unitType: string;
  unitId: string;
  prompt: string;
}

/** UI-facing metadata for progress display. */
export interface DisplayMetadata {
  engineLabel: string;
  currentPhase: string;
  progressSummary: string;
  stepCount: { completed: number; total: number } | null;
}

/**
 * Discriminated union: what the engine tells the loop to do next.
 *
 * - `dispatch` — execute a step
 * - `stop` — halt the loop with a reason and severity
 * - `skip` — nothing to do right now, advance without executing
 */
export type EngineDispatchAction =
  | { action: "dispatch"; step: StepContract }
  | { action: "stop"; reason: string; level: "info" | "warning" | "error" }
  | { action: "skip" };

/** Outcome of reconciling state after a step completes. */
export interface ReconcileResult {
  outcome: "continue" | "milestone-complete" | "pause" | "stop";
  reason?: string;
}

/** Recovery strategy when a step fails. */
export interface RecoveryAction {
  outcome: "retry" | "skip" | "stop" | "pause";
  reason?: string;
}

/** Result of closing out a completed unit. */
export interface CloseoutResult {
  committed: boolean;
  artifacts: string[];
}

/** Record of a completed execution step. */
export interface CompletedStep {
  unitType: string;
  unitId: string;
  startedAt: number;
  finishedAt: number;
}
