/**
 * execution-policy.ts — ExecutionPolicy interface.
 *
 * Defines the policy layer that governs model selection, verification,
 * recovery, and closeout for each execution step. Imports only from
 * the leaf-node engine-types.
 */

import type { RecoveryAction, CloseoutResult } from "./engine-types.js";

/** Policy governing how each step is executed, verified, and closed out. */
export interface ExecutionPolicy {
  /** Prepare the workspace before a milestone begins (e.g. worktree setup). */
  prepareWorkspace(basePath: string, milestoneId: string): Promise<void>;

  /** Select the model tier for a given unit. Returns null to use defaults. */
  selectModel(
    unitType: string,
    unitId: string,
    context: { basePath: string },
  ): Promise<{ tier: string; modelDowngraded: boolean } | null>;

  /** Verify unit output. Returns disposition for the loop. */
  verify(
    unitType: string,
    unitId: string,
    context: { basePath: string },
  ): Promise<"continue" | "retry" | "pause">;

  /** Determine recovery action when a unit fails. */
  recover(
    unitType: string,
    unitId: string,
    context: { basePath: string },
  ): Promise<RecoveryAction>;

  /** Close out a completed unit (commit, snapshot, artifact capture). */
  closeout(
    unitType: string,
    unitId: string,
    context: { basePath: string; startedAt: number },
  ): Promise<CloseoutResult>;
}
