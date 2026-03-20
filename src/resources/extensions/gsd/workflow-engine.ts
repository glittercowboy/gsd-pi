/**
 * WorkflowEngine interface — the contract for pluggable workflow implementations.
 *
 * Each engine drives the auto-loop by answering four questions:
 * 1. What is the current state? (deriveState)
 * 2. What should we do next? (resolveDispatch)
 * 3. What happened after a step? (reconcile)
 * 4. What should the dashboard show? (getDisplayMetadata)
 *
 * The dev engine (S02) wraps the existing GSD auto-mode functions behind this
 * interface. Custom engines implement it from scratch.
 *
 * Imports only from engine-types.ts — no existing GSD module dependencies.
 */

import type {
  EngineState,
  EngineDispatchAction,
  CompletedStep,
  ReconcileResult,
  DisplayMetadata,
} from "./engine-types.js";

/**
 * A workflow engine drives the auto-loop by providing state derivation,
 * dispatch resolution, post-step reconciliation, and display metadata.
 */
export interface WorkflowEngine {
  /**
   * Unique engine identifier (e.g. "dev", "custom").
   * Used for logging, metrics, and engine resolution.
   */
  readonly engineId: string;

  /**
   * Derive the current engine state from disk/external sources.
   *
   * For the dev engine, this wraps `deriveState(basePath)` from `state.ts`,
   * mapping the full `GSDState` into the generic `EngineState` shape.
   *
   * @param basePath — project root (the .gsd/ parent directory)
   * @returns Engine-polymorphic state snapshot
   */
  deriveState(basePath: string): Promise<EngineState>;

  /**
   * Determine the next dispatch action given the current state.
   *
   * For the dev engine, this wraps `resolveDispatch()` from `auto-dispatch.ts`,
   * translating the `DispatchAction` into an `EngineDispatchAction`.
   *
   * @param state — current engine state (from deriveState)
   * @param context — dispatch context with basePath and any engine-specific data
   * @returns What the auto-loop should do next
   */
  resolveDispatch(
    state: EngineState,
    context: { basePath: string },
  ): Promise<EngineDispatchAction>;

  /**
   * Reconcile state after a step completes — determine the next loop action.
   *
   * For the dev engine, this wraps the post-unit state transitions in
   * `auto-post-unit.ts` (milestone completion, slice advancement, etc.).
   *
   * @param state — current engine state (re-derived after step completion)
   * @param completedStep — metadata about the step that just finished
   * @returns Whether to continue, pause, stop, or mark milestone complete
   */
  reconcile(
    state: EngineState,
    completedStep: CompletedStep,
  ): Promise<ReconcileResult>;

  /**
   * Produce display metadata for the TUI dashboard.
   *
   * For the dev engine, this wraps the dashboard widget data assembly
   * from `auto-dashboard.ts`.
   *
   * @param state — current engine state
   * @returns Display data for the dashboard renderer
   */
  getDisplayMetadata(state: EngineState): DisplayMetadata;
}
