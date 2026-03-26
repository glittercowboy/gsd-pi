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
import { resolveSliceFile, resolveSlicePath } from "./paths.js";
import { parseUnitId } from "./unit-id.js";
import { isDbAvailable, getTask } from "./gsd-db.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import {
  runVerificationGate,
  formatFailureContext,
  captureRuntimeErrors,
  runDependencyAudit,
} from "./verification-gate.js";
import { writeVerificationJSON } from "./verification-evidence.js";
import type { AutoSession } from "./auto/session.js";
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
        process.stderr.write(
          `verification-evidence: write error — ${(evidenceErr as Error).message}\n`,
        );
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

    // ── Auto-fix retry logic ──
    if (result.passed) {
      s.verificationRetryCount.delete(s.currentUnit.id);
      s.pendingVerificationRetry = null;
      return "continue";
    } else if (autoFixEnabled && attempt + 1 <= maxRetries) {
      const nextAttempt = attempt + 1;
      s.verificationRetryCount.set(s.currentUnit.id, nextAttempt);
      s.pendingVerificationRetry = {
        unitId: s.currentUnit.id,
        failureContext: formatFailureContext(result),
        attempt: nextAttempt,
      };
      ctx.ui.notify(
        `Verification failed — auto-fix attempt ${nextAttempt}/${maxRetries}`,
        "warning",
      );
      // Return "retry" — the autoLoop while loop will re-iterate with the retry context
      return "retry";
    } else {
      // Gate failed, retries exhausted
      const exhaustedAttempt = attempt + 1;
      s.verificationRetryCount.delete(s.currentUnit.id);
      s.pendingVerificationRetry = null;
      ctx.ui.notify(
        `Verification gate FAILED after ${exhaustedAttempt > maxRetries ? exhaustedAttempt - 1 : exhaustedAttempt} retries — pausing for human review`,
        "error",
      );
      await pauseAuto(ctx, pi);
      return "pause";
    }
  } catch (err) {
    // Gate errors are non-fatal
    process.stderr.write(
      `verification-gate: error — ${(err as Error).message}\n`,
    );
    return "continue";
  }
}
