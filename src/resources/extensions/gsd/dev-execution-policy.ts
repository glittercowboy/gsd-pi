/**
 * DevExecutionPolicy — wraps existing GSD auto-mode operational functions
 * behind the ExecutionPolicy interface.
 *
 * For S02, all methods are stubs that satisfy the interface contract.
 * Real delegation to the existing functions happens in S03+ when
 * handleAgentEnd is refactored to use the policy.
 */

import type { ExecutionPolicy } from "./execution-policy.js";
import type { RecoveryAction, CloseoutResult } from "./engine-types.js";

export class DevExecutionPolicy implements ExecutionPolicy {
  async prepareWorkspace(
    _basePath: string,
    _milestoneId: string,
  ): Promise<void> {
    // Stub: actual workspace prep is deeply entangled with auto.ts session state.
    // Full delegation is S03+.
  }

  async selectModel(
    _unitType: string,
    _unitId: string,
    _context: { basePath: string },
  ): Promise<{ tier: string; modelDowngraded: boolean } | null> {
    // Stub: model selection is session-entangled.
    // Actual delegation happens when the loop is fully refactored.
    return null;
  }

  async verify(
    _unitType: string,
    _unitId: string,
    _context: { basePath: string },
  ): Promise<"continue" | "retry" | "pause"> {
    // Stub: verification pipeline stays in handleAgentEnd for S02.
    return "continue";
  }

  async recover(
    _unitType: string,
    _unitId: string,
    _context: { basePath: string },
  ): Promise<RecoveryAction> {
    // Stub: recovery stays in existing code paths for S02.
    return { outcome: "retry" };
  }

  async closeout(
    _unitType: string,
    _unitId: string,
    _context: { basePath: string; startedAt: number },
  ): Promise<CloseoutResult> {
    // Stub: closeout stays in existing code paths for S02.
    return { committed: false, artifacts: [] };
  }
}
