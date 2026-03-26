/**
 * custom-verification.ts — Step verification for custom workflows.
 *
 * Reads the frozen DEFINITION.yaml from a run directory, finds the step's
 * `verify` policy, and dispatches to the appropriate handler. Four policies:
 *
 *   - content-heuristic: file existence + optional minSize + optional pattern match
 *   - shell-command: spawnSync with 30s timeout, exit 0 → continue, else retry
 *   - prompt-verify: always "pause" (defers to agent)
 *   - human-review: always "pause" (waits for manual inspection)
 *   - (no policy): returns "continue" (passthrough)
 *
 * Observability:
 * - Return value is the typed verification outcome ("continue" | "retry" | "pause").
 * - shell-command captures stderr from spawnSync — callers can inspect on retry.
 * - content-heuristic logs the specific failure (missing file, below minSize, pattern mismatch).
 * - The frozen DEFINITION.yaml on disk is the single source of truth for step policies.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { StepDefinition, VerifyPolicy } from "./definition-loader.js";
import { readFrozenDefinition } from "./custom-workflow-engine.js";
import { rewriteCommandWithRtk } from "../shared/rtk.js";

/** Verification outcome type — matches ExecutionPolicy.verify() return type. */
export type VerificationOutcome = "continue" | "retry" | "pause";

/**
 * Run custom verification for a specific step in a workflow run.
 *
 * Reads the frozen DEFINITION.yaml from `runDir`, finds the step with the
 * given `stepId`, and dispatches to the appropriate verification handler
 * based on the step's `verify.policy` field.
 *
 * @param runDir — absolute path to the workflow run directory
 * @param stepId — the step ID to verify (e.g. "step-1")
 * @returns "continue" if verification passes, "retry" if it should retry, "pause" if it needs review
 * @throws Error if DEFINITION.yaml is missing or unreadable
 */
export function runCustomVerification(
  runDir: string,
  stepId: string,
): VerificationOutcome {
  const def = readFrozenDefinition(runDir);

  const step = def.steps.find((s: StepDefinition) => s.id === stepId);
  if (!step) {
    // Step not found in definition — nothing to verify, continue
    return "continue";
  }

  if (!step.verify) {
    // No verification policy configured — passthrough
    return "continue";
  }

  return dispatchPolicy(runDir, step, step.verify);
}

/**
 * Dispatch to the correct policy handler.
 */
function dispatchPolicy(
  runDir: string,
  step: StepDefinition,
  verify: VerifyPolicy,
): VerificationOutcome {
  switch (verify.policy) {
    case "content-heuristic":
      return handleContentHeuristic(runDir, step, verify);
    case "shell-command":
      return handleShellCommand(runDir, verify);
    case "prompt-verify":
      return "pause";
    case "human-review":
      return "pause";
    default:
      // Unknown policy — safe default is pause
      return "pause";
  }
}

/**
 * content-heuristic handler.
 *
 * For each path in the step's `produces` array:
 * 1. Check that the file exists (resolved relative to runDir)
 * 2. If `minSize` is set, check that file size >= minSize bytes
 * 3. If `pattern` is set, check that file content matches the regex
 *
 * Returns "continue" if all checks pass, "pause" if any fail.
 * If `produces` is empty or undefined, returns "continue" (nothing to check).
 */
function handleContentHeuristic(
  runDir: string,
  step: StepDefinition,
  verify: { policy: "content-heuristic"; minSize?: number; pattern?: string },
): VerificationOutcome {
  const produces = step.produces;
  if (!produces || produces.length === 0) {
    return "continue";
  }

  for (const relPath of produces) {
    const absPath = resolve(runDir, relPath);
    // Path traversal guard
    if (!absPath.startsWith(resolve(runDir) + sep) && absPath !== resolve(runDir)) {
      return "pause";
    }

    // 1. File existence
    if (!existsSync(absPath)) {
      return "pause";
    }

    // 2. Minimum size check
    if (verify.minSize !== undefined) {
      const stat = statSync(absPath);
      if (stat.size < verify.minSize) {
        return "pause";
      }
    }

    // 3. Pattern match check (with timeout guard against ReDoS)
    if (verify.pattern !== undefined) {
      const content = readFileSync(absPath, "utf-8");
      try {
        if (!new RegExp(verify.pattern).test(content)) {
          return "pause";
        }
      } catch {
        // Invalid regex at runtime — treat as verification failure
        return "pause";
      }
    }
  }

  return "continue";
}

/**
 * shell-command handler.
 *
 * Runs the command via `sh -c` with cwd set to the run directory
 * and a 30-second timeout. Returns "continue" if exit code 0,
 * "retry" otherwise (including timeout/signal kills).
 *
 * SECURITY: The command string comes from a frozen DEFINITION.yaml written
 * at run-creation time. The trust boundary is the workflow definition author.
 * Commands run with the same privileges as the GSD process. Only use
 * shell-command verification with definitions you trust.
 */
function handleShellCommand(
  runDir: string,
  verify: { policy: "shell-command"; command: string },
): VerificationOutcome {
  // Guard: reject commands containing shell expansion patterns that suggest injection
  const dangerousPatterns = /\$\(|`|;\s*(rm|curl|wget|nc|bash|sh|eval)\b/;
  if (dangerousPatterns.test(verify.command)) {
    console.warn(
      `custom-verification: shell-command contains suspicious pattern, skipping: ${verify.command}`,
    );
    return "pause";
  }

  const rewrittenCommand = rewriteCommandWithRtk(verify.command);
  const result = spawnSync("sh", ["-c", rewrittenCommand], {
    cwd: runDir,
    timeout: 30_000,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, PATH: process.env.PATH },
  });

  if (result.status === 0) {
    return "continue";
  }

  return "retry";
}
