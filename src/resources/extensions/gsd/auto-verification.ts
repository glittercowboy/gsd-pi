/**
 * Post-unit verification gate for auto-mode.
 *
 * Runs typecheck/lint/test checks, captures runtime errors, performs
 * dependency audits, handles auto-fix retry logic, and writes
 * verification evidence JSON.
 *
 * Extracted from handleAgentEnd() in auto.ts. Returns a sentinel
 * value instead of calling return/pauseAuto directly — the caller
 * checks the result and handles control flow.
 */

import type { ExtensionContext, ExtensionAPI } from "@gsd/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolveSliceFile, resolveSlicePath } from "./paths.js";
import { parseUnitId } from "./unit-id.js";
import { isDbAvailable, getTask, getSliceTasks, type TaskRow } from "./gsd-db.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import {
  runVerificationGate,
  formatFailureContext,
  captureRuntimeErrors,
  runDependencyAudit,
} from "./verification-gate.js";
import { writeVerificationJSON, type PostExecutionCheckJSON, type EvidenceJSON } from "./verification-evidence.js";
import { logWarning } from "./workflow-logger.js";
import { runPostExecutionChecks, type PostExecutionResult } from "./post-execution-checks.js";
import type { AutoSession } from "./auto/session.js";
import type { VerificationResult as VerificationGateResult } from "./types.js";
import { join } from "node:path";

export interface VerificationContext {
  s: AutoSession;
  ctx: ExtensionContext;
  pi: ExtensionAPI;
}

export type VerificationResult = "continue" | "retry" | "pause";

function isInfraVerificationFailure(stderr: string): boolean {
  return /\b(ENOENT|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|spawn\s+\S+\s+ENOENT|command not found)\b/i.test(
    stderr,
  );
}

/**
 * Run the verification gate for the current execute-task unit.
 * Returns:
 * - "continue" — gate passed (or no checks configured), proceed normally
 * - "retry" — gate failed with retries remaining, s.pendingVerificationRetry set for loop re-iteration
 * - "pause" — gate failed with retries exhausted, pauseAuto already called
 */
export async function runPostUnitVerification(
  vctx: VerificationContext,
  pauseAuto: (ctx?: ExtensionContext, pi?: ExtensionAPI) => Promise<void>,
): Promise<VerificationResult> {
  const { s, ctx, pi } = vctx;

  if (!s.currentUnit || s.currentUnit.type !== "execute-task") {
    return "continue";
  }

  try {
    const effectivePrefs = loadEffectiveGSDPreferences();
    const prefs = effectivePrefs?.preferences;

    // Read task plan verify field
    const { milestone: mid, slice: sid, task: tid } = parseUnitId(s.currentUnit.id);
    let taskPlanVerify: string | undefined;
    if (mid && sid && tid) {
      if (isDbAvailable()) {
        taskPlanVerify = getTask(mid, sid, tid)?.verify;
      }
      // When DB unavailable, taskPlanVerify stays undefined — gate runs without task-specific checks
    }

    const result = runVerificationGate({
      cwd: s.basePath,
      preferenceCommands: prefs?.verification_commands,
      taskPlanVerify,
    });

    // Capture runtime errors
    const runtimeErrors = await captureRuntimeErrors();
    if (runtimeErrors.length > 0) {
      result.runtimeErrors = runtimeErrors;
      if (runtimeErrors.some((e) => e.blocking)) {
        result.passed = false;
      }
    }

    // Dependency audit
    const auditWarnings = runDependencyAudit(s.basePath);
    if (auditWarnings.length > 0) {
      result.auditWarnings = auditWarnings;
      process.stderr.write(
        `verification-gate: ${auditWarnings.length} audit warning(s)\n`,
      );
      for (const w of auditWarnings) {
        process.stderr.write(`  [${w.severity}] ${w.name}: ${w.title}\n`);
      }
    }

    // Auto-fix retry preferences
    const autoFixEnabled = prefs?.verification_auto_fix !== false;
    const maxRetries =
      typeof prefs?.verification_max_retries === "number"
        ? prefs.verification_max_retries
        : 2;

    if (result.checks.length > 0) {
      const passCount = result.checks.filter((c) => c.exitCode === 0).length;
      const total = result.checks.length;
      if (result.passed) {
        ctx.ui.notify(`Verification gate: ${passCount}/${total} checks passed`);
      } else {
        const failures = result.checks.filter((c) => c.exitCode !== 0);
        const failNames = failures.map((f) => f.command).join(", ");
        ctx.ui.notify(`Verification gate: FAILED — ${failNames}`);
        process.stderr.write(
          `verification-gate: ${total - passCount}/${total} checks failed\n`,
        );
        for (const f of failures) {
          process.stderr.write(`  ${f.command} exited ${f.exitCode}\n`);
          if (f.stderr)
            process.stderr.write(`  stderr: ${f.stderr.slice(0, 500)}\n`);
        }
      }
    }

    // Log blocking runtime errors
    if (result.runtimeErrors?.some((e) => e.blocking)) {
      const blockingErrors = result.runtimeErrors.filter((e) => e.blocking);
      process.stderr.write(
        `verification-gate: ${blockingErrors.length} blocking runtime error(s) detected\n`,
      );
      for (const err of blockingErrors) {
        process.stderr.write(
          `  [${err.source}] ${err.severity}: ${err.message.slice(0, 200)}\n`,
        );
      }
    }

    // Write verification evidence JSON
    const attempt = s.verificationRetryCount.get(s.currentUnit.id) ?? 0;
    if (mid && sid && tid) {
      try {
        const sDir = resolveSlicePath(s.basePath, mid, sid);
        if (sDir) {
          const tasksDir = join(sDir, "tasks");
          if (result.passed) {
            writeVerificationJSON(result, tasksDir, tid, s.currentUnit.id);
          } else {
            const nextAttempt = attempt + 1;
            writeVerificationJSON(
              result,
              tasksDir,
              tid,
              s.currentUnit.id,
              nextAttempt,
              maxRetries,
            );
          }
        }
      } catch (evidenceErr) {
        logWarning("engine", `verification-evidence write error: ${(evidenceErr as Error).message}`);
      }
    }

    const advisoryFailure =
      !result.passed &&
      (result.discoverySource === "package-json" ||
        result.checks.some((check) =>
          isInfraVerificationFailure(check.stderr),
        ));

    if (advisoryFailure) {
      s.verificationRetryCount.delete(s.currentUnit.id);
      s.pendingVerificationRetry = null;
      ctx.ui.notify(
        result.discoverySource === "package-json"
          ? "Verification failed in auto-discovered package.json checks — treating as advisory."
          : "Verification failed due to infrastructure/runtime environment issues — treating as advisory.",
        "warning",
      );
      return "continue";
    }

    // ── Post-execution checks (run after main verification passes for execute-task units) ──
    let postExecChecks: PostExecutionCheckJSON[] | undefined;
    let postExecBlockingFailure = false;

    if (result.passed && mid && sid && tid) {
      // Check preferences — respect enhanced_verification and enhanced_verification_post
      const enhancedEnabled = prefs?.enhanced_verification !== false; // default true
      const postEnabled = prefs?.enhanced_verification_post !== false; // default true

      if (enhancedEnabled && postEnabled && isDbAvailable()) {
        try {
          // Get the completed task from DB
          const taskRow = getTask(mid, sid, tid);
          if (taskRow && taskRow.key_files && taskRow.key_files.length > 0) {
            // Get all tasks in the slice
            const allTasks = getSliceTasks(mid, sid);
            // Filter to prior completed tasks (status = 'complete' or 'done', before current task)
            const priorTasks = allTasks.filter(
              (t: TaskRow) =>
                (t.status === "complete" || t.status === "done") &&
                t.id !== tid &&
                t.sequence < taskRow.sequence
            );

            // Run post-execution checks
            const postExecResult: PostExecutionResult = runPostExecutionChecks(
              taskRow,
              priorTasks,
              s.basePath
            );

            // Store checks for evidence JSON
            postExecChecks = postExecResult.checks;

            // Log summary to stderr with gsd-post-exec: prefix
            const emoji =
              postExecResult.status === "pass"
                ? "✅"
                : postExecResult.status === "warn"
                  ? "⚠️"
                  : "❌";
            process.stderr.write(
              `gsd-post-exec: ${emoji} Post-execution checks ${postExecResult.status} for ${mid}/${sid}/${tid} (${postExecResult.durationMs}ms)\n`
            );

            // Log individual check results
            for (const check of postExecResult.checks) {
              const checkEmoji = check.passed
                ? "✓"
                : check.blocking
                  ? "✗"
                  : "⚠";
              process.stderr.write(
                `gsd-post-exec:   ${checkEmoji} [${check.category}] ${check.target}: ${check.message}\n`
              );
            }

            // Check for blocking failures
            if (postExecResult.status === "fail") {
              postExecBlockingFailure = true;
              const blockingCount = postExecResult.checks.filter(
                (c) => !c.passed && c.blocking
              ).length;
              ctx.ui.notify(
                `Post-execution checks failed: ${blockingCount} blocking issue${blockingCount === 1 ? "" : "s"} found`,
                "error"
              );
            } else if (postExecResult.status === "warn") {
              ctx.ui.notify(
                `Post-execution checks passed with warnings`,
                "warning"
              );
              // Strict mode: treat warnings as blocking
              if (prefs?.enhanced_verification_strict === true) {
                postExecBlockingFailure = true;
              }
            }
          }
        } catch (postExecErr) {
          // Post-execution check errors are non-fatal — log and continue
          logWarning("engine", `gsd-post-exec: error — ${(postExecErr as Error).message}`);
        }
      }
    }

    // Re-write verification evidence JSON with post-execution checks
    if (postExecChecks && postExecChecks.length > 0 && mid && sid && tid) {
      try {
        const sDir = resolveSlicePath(s.basePath, mid, sid);
        if (sDir) {
          const tasksDir = join(sDir, "tasks");
          // Add postExecutionChecks to the result for the JSON write
          const resultWithPostExec = {
            ...result,
            // Mark as failed if there was a blocking post-exec failure
            passed: result.passed && !postExecBlockingFailure,
          };
          // Manually write with postExecutionChecks field
          writeVerificationJSONWithPostExec(
            resultWithPostExec,
            tasksDir,
            tid,
            s.currentUnit.id,
            postExecChecks,
            postExecBlockingFailure ? attempt + 1 : undefined,
            postExecBlockingFailure ? maxRetries : undefined
          );
        }
      } catch (evidenceErr) {
        logWarning("engine", `verification-evidence: post-exec write error — ${(evidenceErr as Error).message}`);
      }
    }

    // Update result.passed based on post-execution checks
    if (postExecBlockingFailure) {
      result.passed = false;
    }

    // ── Auto-fix retry logic ──
    if (result.passed) {
      s.verificationRetryCount.delete(s.currentUnit.id);
      s.pendingVerificationRetry = null;
      return "continue";
    } else if (postExecBlockingFailure) {
      // Post-execution failures are cross-task consistency issues — retrying the same task won't fix them.
      // Skip retry and pause immediately for human review.
      s.verificationRetryCount.delete(s.currentUnit.id);
      s.pendingVerificationRetry = null;
      ctx.ui.notify(
        `Post-execution checks failed — cross-task consistency issue detected, pausing for human review`,
        "error",
      );
      await pauseAuto(ctx, pi);
      return "pause";
    } else if (autoFixEnabled && attempt + 1 <= maxRetries) {
      const nextAttempt = attempt + 1;
      s.verificationRetryCount.set(s.currentUnit.id, nextAttempt);
      s.pendingVerificationRetry = {
        unitId: s.currentUnit.id,
        failureContext: formatFailureContext(result),
        attempt: nextAttempt,
      };
      const failedCmds = result.checks
        .filter((c) => c.exitCode !== 0)
        .map((c) => c.command);
      const cmdSummary = failedCmds.length <= 3
        ? failedCmds.join(", ")
        : `${failedCmds.slice(0, 3).join(", ")}... and ${failedCmds.length - 3} more`;
      ctx.ui.notify(
        `Verification failed (${cmdSummary}) — auto-fix attempt ${nextAttempt}/${maxRetries}`,
        "warning",
      );
      // Return "retry" — the autoLoop while loop will re-iterate with the retry context
      return "retry";
    } else {
      // Gate failed, retries exhausted
      s.verificationRetryCount.delete(s.currentUnit.id);
      s.pendingVerificationRetry = null;
      const exhaustedFails = result.checks
        .filter((c) => c.exitCode !== 0)
        .map((c) => c.command);
      const exhaustedSummary = exhaustedFails.length <= 3
        ? exhaustedFails.join(", ")
        : `${exhaustedFails.slice(0, 3).join(", ")}... and ${exhaustedFails.length - 3} more`;
      ctx.ui.notify(
        `Verification gate FAILED after ${attempt} ${attempt === 1 ? "retry" : "retries"} (${exhaustedSummary}) — pausing for human review`,
        "error",
      );
      await pauseAuto(ctx, pi);
      return "pause";
    }
  } catch (err) {
    // Gate errors are non-fatal
    logWarning("engine", `verification-gate error: ${(err as Error).message}`);
    return "continue";
  }
}

/**
 * Write verification evidence JSON with post-execution checks included.
 * This is a variant of writeVerificationJSON that adds the postExecutionChecks field.
 */
function writeVerificationJSONWithPostExec(
  result: VerificationGateResult,
  tasksDir: string,
  taskId: string,
  unitId: string,
  postExecutionChecks: PostExecutionCheckJSON[],
  retryAttempt?: number,
  maxRetries?: number,
): void {
  mkdirSync(tasksDir, { recursive: true });

  const evidence: EvidenceJSON = {
    schemaVersion: 1,
    taskId,
    unitId: unitId ?? taskId,
    timestamp: result.timestamp,
    passed: result.passed,
    discoverySource: result.discoverySource,
    checks: result.checks.map((check) => ({
      command: check.command,
      exitCode: check.exitCode,
      durationMs: check.durationMs,
      verdict: check.exitCode === 0 ? "pass" : "fail",
    })),
    ...(retryAttempt !== undefined ? { retryAttempt } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    postExecutionChecks,
  };

  if (result.runtimeErrors && result.runtimeErrors.length > 0) {
    evidence.runtimeErrors = result.runtimeErrors.map(e => ({
      source: e.source,
      severity: e.severity,
      message: e.message,
      blocking: e.blocking,
    }));
  }

  if (result.auditWarnings && result.auditWarnings.length > 0) {
    evidence.auditWarnings = result.auditWarnings.map(w => ({
      name: w.name,
      severity: w.severity,
      title: w.title,
      url: w.url,
      fixAvailable: w.fixAvailable,
    }));
  }

  const filePath = join(tasksDir, `${taskId}-VERIFY.json`);
  writeFileSync(filePath, JSON.stringify(evidence, null, 2) + "\n", "utf-8");
}
