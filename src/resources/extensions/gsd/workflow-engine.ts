/**
 * workflow-engine.ts — WorkflowEngine interface.
 *
 * Defines the contract every engine implementation must satisfy.
 * Imports only from the leaf-node engine-types.
 */

import type {
  EngineState,
  EngineDispatchAction,
  CompletedStep,
  ReconcileResult,
  DisplayMetadata,
} from "./engine-types.js";

/** A pluggable workflow engine that drives the auto-loop. */
export interface WorkflowEngine {
  /** Unique identifier for this engine (e.g. "dev", "custom"). */
  readonly engineId: string;

  /** Derive the current engine state from the project on disk. */
  deriveState(basePath: string): Promise<EngineState>;

  /** Decide what the loop should do next given current state. */
  resolveDispatch(
    state: EngineState,
    context: { basePath: string },
  ): Promise<EngineDispatchAction>;

  /** Reconcile state after a step has been executed. */
  reconcile(
    state: EngineState,
    completedStep: CompletedStep,
  ): Promise<ReconcileResult>;

  /** Return UI-facing metadata for progress display. */
  getDisplayMetadata(state: EngineState): DisplayMetadata;
}
