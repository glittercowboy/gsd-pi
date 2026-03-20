/**
 * CustomExecutionPolicy — execution policy for custom workflows.
 *
 * Implements ExecutionPolicy with real verification dispatch (S05) and
 * neutral stubs for other methods. The `verify()` method loads the frozen
 * DEFINITION.yaml from the run directory, finds the step's verify config,
 * and dispatches to `runVerification()`.
 *
 * Created in S03, verify wired in S05/T03.
 */

import type { ExecutionPolicy } from "./execution-policy.js";
import type { RecoveryAction, CloseoutResult } from "./engine-types.js";
import type { VerifyPolicy } from "./definition-loader.js";
import { runVerification } from "./custom-verification.js";
import { parse } from "yaml";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export class CustomExecutionPolicy implements ExecutionPolicy {
  private readonly runDir: string;

  constructor(runDir: string) {
    this.runDir = runDir;
  }

  async prepareWorkspace(
    _basePath: string,
    _milestoneId: string,
  ): Promise<void> {
    // Stub: custom workflows don't require workspace preparation yet.
  }

  async selectModel(
    _unitType: string,
    _unitId: string,
    _context: { basePath: string },
  ): Promise<{ tier: string; modelDowngraded: boolean } | null> {
    // Stub: no model routing for custom workflows yet.
    return null;
  }

  async verify(
    _unitType: string,
    unitId: string,
    _context: { basePath: string },
  ): Promise<"continue" | "retry" | "pause"> {
    // Load the frozen definition from the run directory
    const defPath = join(this.runDir, "DEFINITION.yaml");
    if (!existsSync(defPath)) {
      return "continue";
    }

    let parsed: Record<string, unknown>;
    try {
      const raw = readFileSync(defPath, "utf-8");
      parsed = parse(raw) as Record<string, unknown>;
    } catch {
      return "continue";
    }

    // Find the step matching unitId
    const yamlSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
    const step = yamlSteps.find(
      (s: Record<string, unknown>) => s.id === unitId,
    ) as Record<string, unknown> | undefined;

    if (!step || !step.verify) {
      return "continue";
    }

    // Build the VerifyPolicy from the YAML verify object
    const policy = step.verify as VerifyPolicy;

    // Get the produces array for content-heuristic checks
    const produces = Array.isArray(step.produces)
      ? (step.produces as string[])
      : [];

    const result = runVerification(policy, this.runDir, produces);
    return result.result;
  }

  async recover(
    _unitType: string,
    _unitId: string,
    _context: { basePath: string },
  ): Promise<RecoveryAction> {
    // Stub: default recovery is retry.
    return { outcome: "retry" };
  }

  async closeout(
    _unitType: string,
    _unitId: string,
    _context: { basePath: string; startedAt: number },
  ): Promise<CloseoutResult> {
    // Stub: no commit/artifact handling for custom workflows yet.
    return { committed: false, artifacts: [] };
  }
}
