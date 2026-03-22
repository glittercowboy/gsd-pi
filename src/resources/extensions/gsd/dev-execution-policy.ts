/**
 * dev-execution-policy.ts — DevExecutionPolicy implementation.
 *
 * Stub policy for the dev engine. All methods return safe defaults.
 * Real verification/closeout continues running through phases.ts via LoopDeps.
 * Wiring this policy into the loop is S04's responsibility.
 */

import type { ExecutionPolicy } from "./execution-policy.js";
import type { RecoveryAction, CloseoutResult } from "./engine-types.js";

export class DevExecutionPolicy implements ExecutionPolicy {
  async prepareWorkspace(
    _basePath: string,
    _milestoneId: string,
  ): Promise<void> {
    // no-op — workspace preparation handled by existing GSD logic
  }

  async selectModel(
    _unitType: string,
    _unitId: string,
    _context: { basePath: string },
  ): Promise<{ tier: string; modelDowngraded: boolean } | null> {
    return null; // use default model selection
  }

  async verify(
    _unitType: string,
    _unitId: string,
    _context: { basePath: string },
  ): Promise<"continue" | "retry" | "pause"> {
    return "continue";
  }

  async recover(
    _unitType: string,
    _unitId: string,
    _context: { basePath: string },
  ): Promise<RecoveryAction> {
    return { outcome: "retry" };
  }

  async closeout(
    _unitType: string,
    _unitId: string,
    _context: { basePath: string; startedAt: number },
  ): Promise<CloseoutResult> {
    return { committed: false, artifacts: [] };
  }
}
