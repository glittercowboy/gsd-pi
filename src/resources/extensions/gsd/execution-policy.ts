/**
 * ExecutionPolicy interface — the contract for pluggable execution behaviors.
 *
 * While WorkflowEngine drives *what* happens (state → dispatch → reconcile),
 * ExecutionPolicy drives *how* it happens: workspace setup, model selection,
 * verification, recovery, and closeout.
 *
 * The dev policy (S02) wraps the existing GSD auto-mode functions behind this
 * interface. Custom policies implement it from scratch.
 *
 * Imports only from engine-types.ts — no existing GSD module dependencies.
 */

import type { RecoveryAction, CloseoutResult } from "./engine-types.js";

/**
 * An execution policy controls the operational aspects of running a workflow:
 * workspace preparation, model routing, verification, failure recovery, and
 * unit closeout.
 */
export interface ExecutionPolicy {
  /**
   * Prepare the workspace for a milestone (worktree setup, branch creation, etc.).
   *
   * For the dev policy, this wraps worktree setup from `auto-worktree.ts`
   * and milestone initialization from `auto-start.ts`.
   *
   * @param basePath — project root
   * @param milestoneId — milestone being started (e.g. "M001")
   */
  prepareWorkspace(basePath: string, milestoneId: string): Promise<void>;

  /**
   * Select the appropriate model for a unit dispatch.
   *
   * For the dev policy, this wraps `selectAndApplyModel()` from
   * `auto-model-selection.ts`, handling complexity routing and fallback chains.
   *
   * @param unitType — type of unit being dispatched (e.g. "execute-task")
   * @param unitId — identifier of the unit
   * @param context — context with basePath and any policy-specific data
   * @returns Routing metadata, or null if no model override was applied
   */
  selectModel(
    unitType: string,
    unitId: string,
    context: { basePath: string },
  ): Promise<{ tier: string; modelDowngraded: boolean } | null>;

  /**
   * Run post-unit verification (typecheck, lint, tests, etc.).
   *
   * For the dev policy, this wraps `runPostUnitVerification()` from
   * `auto-verification.ts`.
   *
   * @param unitType — type of unit that just completed
   * @param unitId — identifier of the completed unit
   * @param context — context with basePath
   * @returns Verification outcome: continue, retry, or pause
   */
  verify(
    unitType: string,
    unitId: string,
    context: { basePath: string },
  ): Promise<"continue" | "retry" | "pause">;

  /**
   * Determine recovery action after a unit failure.
   *
   * For the dev policy, this wraps recovery logic from `auto-recovery.ts`
   * and stuck detection from `auto-stuck-detection.ts`.
   *
   * @param unitType — type of the failed unit
   * @param unitId — identifier of the failed unit
   * @param context — context with basePath
   * @returns Recommended recovery action
   */
  recover(
    unitType: string,
    unitId: string,
    context: { basePath: string },
  ): Promise<RecoveryAction>;

  /**
   * Close out a completed unit — commit artifacts, write logs, snapshot metrics.
   *
   * For the dev policy, this wraps `closeoutUnit()` from `auto-unit-closeout.ts`
   * and post-unit hooks.
   *
   * @param unitType — type of the completed unit
   * @param unitId — identifier of the completed unit
   * @param context — context with basePath and timing data
   * @returns Closeout result with commit status and artifact paths
   */
  closeout(
    unitType: string,
    unitId: string,
    context: { basePath: string; startedAt: number },
  ): Promise<CloseoutResult>;
}
