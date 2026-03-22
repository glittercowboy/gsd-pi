/**
 * custom-execution-policy.ts — ExecutionPolicy for custom workflows.
 *
 * Delegates verification to the step-level verification module which reads
 * the frozen DEFINITION.yaml and dispatches to the appropriate policy handler.
 *
 * Observability:
 * - verify() returns the outcome from runCustomVerification() — four policies
 *   are supported: content-heuristic, shell-command, prompt-verify, human-review.
 * - selectModel() returns null — defers to loop defaults.
 * - recover() returns retry — simple default recovery strategy.
 */

import type { ExecutionPolicy } from "./execution-policy.js";
import type { RecoveryAction, CloseoutResult } from "./engine-types.js";
import { runCustomVerification } from "./custom-verification.js";

export class CustomExecutionPolicy implements ExecutionPolicy {
  private readonly runDir: string;

  constructor(runDir: string) {
    this.runDir = runDir;
  }

  /** No workspace preparation needed for custom workflows. */
  async prepareWorkspace(_basePath: string, _milestoneId: string): Promise<void> {
    // No-op — custom workflows don't need worktree setup
  }

  /** Defer model selection to loop defaults. */
  async selectModel(
    _unitType: string,
    _unitId: string,
    _context: { basePath: string },
  ): Promise<{ tier: string; modelDowngraded: boolean } | null> {
    return null;
  }

  /**
   * Verify step output by dispatching to the step's configured verification policy.
   *
   * Extracts the step ID from unitId (format: "<workflowName>/<stepId>")
   * and calls runCustomVerification() which reads the frozen DEFINITION.yaml
   * to determine which policy to apply.
   */
  async verify(
    _unitType: string,
    unitId: string,
    _context: { basePath: string },
  ): Promise<"continue" | "retry" | "pause"> {
    const parts = unitId.split("/");
    const stepId = parts[parts.length - 1];
    return runCustomVerification(this.runDir, stepId);
  }

  /** Default recovery: retry the step. */
  async recover(
    _unitType: string,
    _unitId: string,
    _context: { basePath: string },
  ): Promise<RecoveryAction> {
    return { outcome: "retry", reason: "Default retry" };
  }

  /** No-op closeout — no commits or artifact capture. */
  async closeout(
    _unitType: string,
    _unitId: string,
    _context: { basePath: string; startedAt: number },
  ): Promise<CloseoutResult> {
    return { committed: false, artifacts: [] };
  }
}
