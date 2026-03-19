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
import { loadFile, parsePlan } from "./files.js";
import { resolveSliceFile, resolveSlicePath } from "./paths.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import {
  runVerificationGate,
  formatFailureContext,
  captureRuntimeErrors,
  runDependencyAudit,
} from "./verification-gate.js";
import { writeVerificationJSON } from "./verification-evidence.js";
import { removePersistedKey } from "./auto-recovery.js";
import type { AutoSession, PendingVerificationRetry } from "./auto/session.js";
import { join } from "node:path";
import { getErrorMessage } from "./error-utils.js";
import { parseUnitId } from "./unit-id.js";

export interface VerificationContext {
  s: AutoSession;
  ctx: ExtensionContext;
  pi: ExtensionAPI;
}

export type VerificationResult = "continue" | "retry" | "pause";

/**
 * Run the verification gate for the current execute-task unit.
 * Returns:
 * - "continue" — gate passed (or no checks configured), proceed normally
 * - "retry" — gate failed with retries remaining, dispatchNextUnit already called
 * - "pause" — gate failed with retries exhausted, pauseAuto already called
 */
export async function runPostUnitVerification(
  vctx: VerificationContext,
  dispatchNextUnit: (ctx: ExtensionContext, pi: ExtensionAPI) => Promise<void>,
  startDispatchGapWatchdog: (ctx: ExtensionContext, pi: ExtensionAPI) => void,
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
      const planFile = resolveSliceFile(s.basePath, mid, sid, "PLAN");
      if (planFile) {
        const planContent = await loadFile(planFile);
        if (planContent) {
          const slicePlan = parsePlan(planContent);
          const taskEntry = slicePlan?.tasks?.find(t => t.id === tid);
          taskPlanVerify = taskEntry?.verify;
        }
      }
    }

    const result = runVerificationGate({
      basePath: s.basePath,
      unitId: s.currentUnit.id,
      cwd: s.basePath,
      preferenceCommands: prefs?.verification_commands,
      taskPlanVerify,
    });

    // Capture runtime errors
    const runtimeErrors = await captureRuntimeErrors();
    if (runtimeErrors.length > 0) {
      result.runtimeErrors = runtimeErrors;
      if (runtimeErrors.some(e => e.blocking)) {
        result.passed = false;
      }
    }

    // Dependency audit
    const auditWarnings = runDependencyAudit(s.basePath);
    if (auditWarnings.length > 0) {
      result.auditWarnings = auditWarnings;
      process.stderr.write(`verification-gate: ${auditWarnings.length} audit warning(s)\n`);
      for (const w of auditWarnings) {
        process.stderr.write(`  [${w.severity}] ${w.name}: ${w.title}\n`);
      }
    }

    // Auto-fix retry preferences
    const autoFixEnabled = prefs?.verification_auto_fix !== false;
    const maxRetries = typeof prefs?.verification_max_retries === "number" ? prefs.verification_max_retries : 2;
    const completionKey = `${s.currentUnit.type}/${s.currentUnit.id}`;

    if (result.checks.length > 0) {
      const blockingChecks = result.checks.filter(c => c.blocking);
      const advisoryChecks = result.checks.filter(c => !c.blocking);
      const blockingPassCount = blockingChecks.filter(c => c.exitCode === 0).length;
      const advisoryFailCount = advisoryChecks.filter(c => c.exitCode !== 0).length;

      if (result.passed) {
        let msg = blockingChecks.length > 0
          ? `Verification gate: ${blockingPassCount}/${blockingChecks.length} blocking checks passed`
          : `Verification gate: passed (no blocking checks)`;
        if (advisoryFailCount > 0) {
          msg += ` (${advisoryFailCount} advisory warning${advisoryFailCount > 1 ? "s" : ""})`;
        }
        ctx.ui.notify(msg);
        // Log advisory warnings to stderr for visibility
        if (advisoryFailCount > 0) {
          const advisoryFailures = advisoryChecks.filter(c => c.exitCode !== 0);
          process.stderr.write(`verification-gate: ${advisoryFailCount} advisory (non-blocking) failure(s)\n`);
          for (const f of advisoryFailures) {
            process.stderr.write(`  [advisory] ${f.command} exited ${f.exitCode}\n`);
          }
        }
      } else {
        const blockingFailures = blockingChecks.filter(c => c.exitCode !== 0);
        const failNames = blockingFailures.map(f => f.command).join(", ");
        ctx.ui.notify(`Verification gate: FAILED — ${failNames}`);
        process.stderr.write(`verification-gate: ${blockingFailures.length}/${blockingChecks.length} blocking checks failed\n`);
        for (const f of blockingFailures) {
          process.stderr.write(`  ${f.command} exited ${f.exitCode}\n`);
          if (f.stderr) process.stderr.write(`  stderr: ${f.stderr.slice(0, 500)}\n`);
        }
        if (advisoryFailCount > 0) {
          process.stderr.write(`verification-gate: ${advisoryFailCount} additional advisory (non-blocking) failure(s)\n`);
        }
      }
    }

    // Log blocking runtime errors
    if (result.runtimeErrors?.some(e => e.blocking)) {
      const blockingErrors = result.runtimeErrors.filter(e => e.blocking);
      process.stderr.write(`verification-gate: ${blockingErrors.length} blocking runtime error(s) detected\n`);
      for (const err of blockingErrors) {
        process.stderr.write(`  [${err.source}] ${err.severity}: ${err.message.slice(0, 200)}\n`);
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
            writeVerificationJSON(result, tasksDir, tid, s.currentUnit.id, nextAttempt, maxRetries);
          }
        }
      } catch (evidenceErr) {
        process.stderr.write(`verification-evidence: write error — ${(evidenceErr as Error).message}\n`);
      }
    }

    // ── Auto-fix retry logic ──
    if (result.passed) {
      s.verificationRetryCount.delete(s.currentUnit.id);
      s.pendingVerificationRetry = null;
      return "continue";
    }

    // Check if all failures are infra errors (ETIMEDOUT, ENOENT, etc.).
    // Infra errors are transient OS-level problems the agent cannot fix —
    // retrying the entire task is wasteful and creates phantom failures.
    const failedChecks = result.checks.filter(c => c.exitCode !== 0);
    const allInfraErrors = failedChecks.length > 0 && failedChecks.every(c => c.infraError === true);
    if (allInfraErrors) {
      const infraNames = failedChecks.map(f => f.command).join(", ");
      ctx.ui.notify(`Verification gate: infra error (${infraNames}) — skipping retry, not a code issue`, "warning");
      process.stderr.write(`verification-gate: all ${failedChecks.length} failure(s) are infra errors — treating as transient, no retry\n`);
      s.verificationRetryCount.delete(s.currentUnit.id);
      s.pendingVerificationRetry = null;
      return "continue";
    }

    if (result.discoverySource === "package-json") {
      // Auto-discovered checks from package.json may fail on pre-existing errors
      // that the current task didn't introduce. Don't trigger the retry loop —
      // log a warning and let the task proceed (#1186).
      process.stderr.write(
        `verification-gate: auto-discovered checks failed (source: package-json) — treating as advisory, not blocking\n`,
      );
      ctx.ui.notify(
        `Verification: auto-discovered checks failed (pre-existing errors likely). Continuing without retry.`,
        "warning",
      );
      s.verificationRetryCount.delete(s.currentUnit.id);
      s.pendingVerificationRetry = null;
      return "continue";
    }

    if (autoFixEnabled && attempt + 1 <= maxRetries) {
      const nextAttempt = attempt + 1;
      s.verificationRetryCount.set(s.currentUnit.id, nextAttempt);
      s.pendingVerificationRetry = {
        unitId: s.currentUnit.id,
        failureContext: formatFailureContext(result),
        attempt: nextAttempt,
      };
      ctx.ui.notify(`Verification failed — auto-fix attempt ${nextAttempt}/${maxRetries}`, "warning");
      s.completedKeySet.delete(completionKey);
      removePersistedKey(s.basePath, completionKey);
      // Dispatch retry immediately
      try {
        await dispatchNextUnit(ctx, pi);
      } catch (retryDispatchErr) {
        const msg = getErrorMessage(retryDispatchErr);
        ctx.ui.notify(`Verification retry dispatch error: ${msg}`, "error");
        startDispatchGapWatchdog(ctx, pi);
      }
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
    process.stderr.write(`verification-gate: error — ${(err as Error).message}\n`);
    return "continue";
  }
}
