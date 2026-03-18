/**
 * Stuck detection and loop recovery for auto-mode unit dispatch.
 *
 * Tracks dispatch counts per unit, enforces lifetime caps, and attempts
 * stub/artifact recovery before stopping.
 *
 * Extracted from dispatchNextUnit() in auto.ts. Returns action values
 * instead of calling stopAuto/dispatchNextUnit — the caller handles
 * control flow.
 */

import type { ExtensionContext } from "@gsd/pi-coding-agent";
import {
  inspectExecuteTaskDurability,
} from "./unit-runtime.js";
import {
  verifyExpectedArtifact,
  diagnoseExpectedArtifact,
  skipExecuteTask,
  persistCompletedKey,
  buildLoopRemediationSteps,
} from "./auto-recovery.js";
import { closeoutUnit, type CloseoutOptions } from "./auto-unit-closeout.js";
import { saveActivityLog } from "./activity-log.js";
import { invalidateAllCaches } from "./cache.js";
import { sendDesktopNotification } from "./notifications.js";
import { debugLog } from "./debug-logger.js";
import {
  resolveMilestonePath,
  resolveSlicePath,
  resolveTasksDir,
  buildTaskFileName,
} from "./paths.js";
import {
  MAX_UNIT_DISPATCHES,
  STUB_RECOVERY_THRESHOLD,
  MAX_LIFETIME_DISPATCHES,
} from "./auto/session.js";
import type { AutoSession } from "./auto/session.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface StuckContext {
  s: AutoSession;
  ctx: ExtensionContext;
  unitType: string;
  unitId: string;
  basePath: string;
  buildSnapshotOpts: () => CloseoutOptions & Record<string, unknown>;
}

export type StuckResult =
  | { action: "proceed" }
  | { action: "recovered"; dispatchAgain: true }
  | { action: "stop"; reason: string; notifyMessage?: string };

/**
 * Check dispatch counts, enforce lifetime cap and MAX_UNIT_DISPATCHES,
 * attempt stub/artifact recovery. Returns an action for the caller.
 */
export async function checkStuckAndRecover(sctx: StuckContext): Promise<StuckResult> {
  const { s, ctx, unitType, unitId, basePath, buildSnapshotOpts } = sctx;
  const dispatchKey = `${unitType}/${unitId}`;
  const prevCount = s.unitDispatchCount.get(dispatchKey) ?? 0;

  // Real dispatch reached — clear the consecutive-skip counter for this unit.
  s.unitConsecutiveSkips.delete(dispatchKey);

  debugLog("dispatch-unit", {
    type: unitType,
    id: unitId,
    cycle: prevCount + 1,
    lifetime: (s.unitLifetimeDispatches.get(dispatchKey) ?? 0) + 1,
  });

  // Hard lifetime cap — survives counter resets from loop-recovery/self-repair.
  const lifetimeCount = (s.unitLifetimeDispatches.get(dispatchKey) ?? 0) + 1;
  s.unitLifetimeDispatches.set(dispatchKey, lifetimeCount);
  if (lifetimeCount > MAX_LIFETIME_DISPATCHES) {
    if (s.currentUnit) {
      await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, buildSnapshotOpts());
    } else {
      saveActivityLog(ctx, s.basePath, unitType, unitId);
    }
    const expected = diagnoseExpectedArtifact(unitType, unitId, basePath);
    return {
      action: "stop",
      reason: `Hard loop: ${unitType} ${unitId}`,
      notifyMessage: `Hard loop detected: ${unitType} ${unitId} dispatched ${lifetimeCount} times total (across reconciliation cycles).${expected ? `\n   Expected artifact: ${expected}` : ""}\n   This may indicate deriveState() keeps returning the same unit despite artifacts existing.\n   Check .gsd/completed-units.json and the slice plan checkbox state.`,
    };
  }

  if (prevCount >= MAX_UNIT_DISPATCHES) {
    if (s.currentUnit) {
      await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, buildSnapshotOpts());
    } else {
      saveActivityLog(ctx, s.basePath, unitType, unitId);
    }

    // Final reconciliation pass for execute-task
    if (unitType === "execute-task") {
      const [mid, sid, tid] = unitId.split("/");
      if (mid && sid && tid) {
        const status = await inspectExecuteTaskDurability(basePath, unitId);
        if (status) {
          const reconciled = skipExecuteTask(basePath, mid, sid, tid, status, "loop-recovery", prevCount);
          if (reconciled && verifyExpectedArtifact(unitType, unitId, basePath)) {
            ctx.ui.notify(
              `Loop recovery: ${unitId} reconciled after ${prevCount + 1} dispatches — blocker artifacts written, pipeline advancing.\n   Review ${status.summaryPath} and replace the placeholder with real work.`,
              "warning",
            );
            const reconciledKey = `${unitType}/${unitId}`;
            persistCompletedKey(basePath, reconciledKey);
            s.completedKeySet.add(reconciledKey);
            s.unitDispatchCount.delete(dispatchKey);
            invalidateAllCaches();
            return { action: "recovered", dispatchAgain: true };
          }
        }
      }
    }

    // General reconciliation: artifact appeared on last attempt
    if (verifyExpectedArtifact(unitType, unitId, basePath)) {
      ctx.ui.notify(
        `Loop recovery: ${unitType} ${unitId} — artifact verified after ${prevCount + 1} dispatches. Advancing.`,
        "info",
      );
      persistCompletedKey(basePath, dispatchKey);
      s.completedKeySet.add(dispatchKey);
      s.unitDispatchCount.delete(dispatchKey);
      invalidateAllCaches();
      return { action: "recovered", dispatchAgain: true };
    }

    // Last resort for complete-milestone: generate stub summary
    if (unitType === "complete-milestone") {
      try {
        const mPath = resolveMilestonePath(basePath, unitId);
        if (mPath) {
          const stubPath = join(mPath, `${unitId}-SUMMARY.md`);
          if (!existsSync(stubPath)) {
            writeFileSync(stubPath, `# ${unitId} Summary\n\nAuto-generated stub — milestone tasks completed but summary generation failed after ${prevCount + 1} attempts.\nReview and replace this stub with a proper summary.\n`);
            ctx.ui.notify(`Generated stub summary for ${unitId} to unblock pipeline. Review later.`, "warning");
            persistCompletedKey(basePath, dispatchKey);
            s.completedKeySet.add(dispatchKey);
            s.unitDispatchCount.delete(dispatchKey);
            invalidateAllCaches();
            return { action: "recovered", dispatchAgain: true };
          }
        }
      } catch { /* non-fatal — fall through to normal stop */ }
    }

    const expected = diagnoseExpectedArtifact(unitType, unitId, basePath);
    const remediation = buildLoopRemediationSteps(unitType, unitId, basePath);
    sendDesktopNotification("GSD", `Loop detected: ${unitType} ${unitId}`, "error", "error");
    return {
      action: "stop",
      reason: `Loop: ${unitType} ${unitId}`,
      notifyMessage: `Loop detected: ${unitType} ${unitId} dispatched ${prevCount + 1} times total. Expected artifact not found.${expected ? `\n   Expected: ${expected}` : ""}${remediation ? `\n\n   Remediation steps:\n${remediation}` : "\n   Check branch state and .gsd/ artifacts."}`,
    };
  }

  s.unitDispatchCount.set(dispatchKey, prevCount + 1);

  if (prevCount > 0) {
    // Adaptive self-repair: each retry attempts a different remediation step.
    if (unitType === "execute-task") {
      const status = await inspectExecuteTaskDurability(basePath, unitId);
      const [mid, sid, tid] = unitId.split("/");
      if (status && mid && sid && tid) {
        if (status.summaryExists && !status.taskChecked) {
          const repaired = skipExecuteTask(basePath, mid, sid, tid, status, "self-repair", 0);
          if (repaired && verifyExpectedArtifact(unitType, unitId, basePath)) {
            ctx.ui.notify(
              `Self-repaired ${unitId}: summary existed but checkbox was unmarked. Marked [x] and advancing.`,
              "warning",
            );
            const repairedKey = `${unitType}/${unitId}`;
            persistCompletedKey(basePath, repairedKey);
            s.completedKeySet.add(repairedKey);
            s.unitDispatchCount.delete(dispatchKey);
            invalidateAllCaches();
            return { action: "recovered", dispatchAgain: true };
          }
        } else if (prevCount >= STUB_RECOVERY_THRESHOLD && !status.summaryExists) {
          const tasksDir = resolveTasksDir(basePath, mid, sid);
          const sDir = resolveSlicePath(basePath, mid, sid);
          const targetDir = tasksDir ?? (sDir ? join(sDir, "tasks") : null);
          if (targetDir) {
            if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
            const summaryPath = join(targetDir, buildTaskFileName(tid, "SUMMARY"));
            if (!existsSync(summaryPath)) {
              const stubContent = [
                `# PARTIAL RECOVERY — attempt ${prevCount + 1} of ${MAX_UNIT_DISPATCHES}`,
                ``,
                `Task \`${tid}\` in slice \`${sid}\` (milestone \`${mid}\`) has not yet produced a real summary.`,
                `This placeholder was written by auto-mode after ${prevCount} dispatch attempts.`,
                ``,
                `The next agent session will retry this task. Replace this file with real work when done.`,
              ].join("\n");
              writeFileSync(summaryPath, stubContent, "utf-8");
              ctx.ui.notify(
                `Stub recovery (attempt ${prevCount + 1}/${MAX_UNIT_DISPATCHES}): ${unitId} stub summary placeholder written. Retrying with recovery context.`,
                "warning",
              );
            }
          }
        }
      }
    }
    ctx.ui.notify(
      `${unitType} ${unitId} didn't produce expected artifact. Retrying (${prevCount + 1}/${MAX_UNIT_DISPATCHES}).`,
      "warning",
    );
  }

  return { action: "proceed" };
}
