/**
 * Unit supervision timers — soft timeout warning, idle watchdog,
 * hard timeout, and context-pressure monitor.
 *
 * Extracted from dispatchNextUnit() in auto.ts. All timers are set up
 * via startUnitSupervision() and torn down by the caller via clearUnitTimeout().
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import { readUnitRuntimeRecord, writeUnitRuntimeRecord } from "./unit-runtime.js";
import { resolveAutoSupervisorConfig } from "./preferences.js";
import type { GSDPreferences } from "./preferences.js";
import { computeBudgets, resolveExecutorContextWindow } from "./context-budget.js";
import {
  getInFlightToolCount,
  getOldestInFlightToolStart,
} from "./auto-tool-tracking.js";
import { detectWorkingTreeActivity } from "./auto-supervisor.js";
import { closeoutUnit, type CloseoutOptions } from "./auto-unit-closeout.js";
import { saveActivityLog } from "./activity-log.js";
import { recoverTimedOutUnit, type RecoveryContext } from "./auto-timeout-recovery.js";
import type { AutoSession } from "./auto/session.js";

export interface SupervisionContext {
  s: AutoSession;
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  unitType: string;
  unitId: string;
  prefs: GSDPreferences | undefined;
  buildSnapshotOpts: () => CloseoutOptions & Record<string, unknown>;
  buildRecoveryContext: () => RecoveryContext;
  pauseAuto: (ctx?: ExtensionContext, pi?: ExtensionAPI) => Promise<void>;
}

/**
 * Set up all four supervision timers for the current unit:
 * 1. Soft timeout warning (wrapup)
 * 2. Idle watchdog (progress polling, stuck tool detection)
 * 3. Hard timeout (pause + recovery)
 * 4. Context-pressure monitor (continue-here)
 */
export function startUnitSupervision(sctx: SupervisionContext): void {
  const { s, ctx, pi, unitType, unitId, prefs, buildSnapshotOpts, buildRecoveryContext, pauseAuto } = sctx;

  const supervisor = resolveAutoSupervisorConfig();
  const softTimeoutMs = (supervisor.soft_timeout_minutes ?? 0) * 60 * 1000;
  const idleTimeoutMs = (supervisor.idle_timeout_minutes ?? 0) * 60 * 1000;
  const hardTimeoutMs = (supervisor.hard_timeout_minutes ?? 0) * 60 * 1000;

  // ── 1. Soft timeout warning ──
  s.wrapupWarningHandle = setTimeout(() => {
    s.wrapupWarningHandle = null;
    if (!s.active || !s.currentUnit) return;
    writeUnitRuntimeRecord(s.basePath, unitType, unitId, s.currentUnit.startedAt, {
      phase: "wrapup-warning-sent",
      wrapupWarningSent: true,
    });
    pi.sendMessage(
      {
        customType: "gsd-auto-wrapup",
        display: s.verbose,
        content: [
          "**TIME BUDGET WARNING — keep going only if progress is real.**",
          "This unit crossed the soft time budget.",
          "If you are making progress, continue. If not, switch to wrap-up mode now:",
          "1. rerun the minimal required verification",
          "2. write or update the required durable artifacts",
          "3. mark task or slice state on disk correctly",
          "4. leave precise resume notes if anything remains unfinished",
        ].join("\n"),
      },
      { triggerTurn: true },
    );
  }, softTimeoutMs);

  // ── 2. Idle watchdog ──
  s.idleWatchdogHandle = setInterval(async () => {
    try {
      if (!s.active || !s.currentUnit) return;
      const runtime = readUnitRuntimeRecord(s.basePath, unitType, unitId);
      if (!runtime) return;
      if (Date.now() - runtime.lastProgressAt < idleTimeoutMs) return;

      // Agent has tool calls currently executing — not idle, just waiting.
      // But only suppress recovery if the tool started recently.
      if (getInFlightToolCount() > 0) {
        const oldestStart = getOldestInFlightToolStart()!;
        const toolAgeMs = Date.now() - oldestStart;
        if (toolAgeMs < idleTimeoutMs) {
          writeUnitRuntimeRecord(s.basePath, unitType, unitId, s.currentUnit.startedAt, {
            lastProgressAt: Date.now(),
            lastProgressKind: "tool-in-flight",
          });
          return;
        }
        ctx.ui.notify(
          `Stalled tool detected: a tool has been in-flight for ${Math.round(toolAgeMs / 60000)}min. Treating as hung — attempting idle recovery.`,
          "warning",
        );
      }

      // Check if the agent is producing work on disk.
      if (detectWorkingTreeActivity(s.basePath)) {
        writeUnitRuntimeRecord(s.basePath, unitType, unitId, s.currentUnit.startedAt, {
          lastProgressAt: Date.now(),
          lastProgressKind: "filesystem-activity",
        });
        return;
      }

      if (s.currentUnit) {
        await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, buildSnapshotOpts());
      } else {
        saveActivityLog(ctx, s.basePath, unitType, unitId);
      }

      const recovery = await recoverTimedOutUnit(ctx, pi, unitType, unitId, "idle", buildRecoveryContext());
      if (recovery === "recovered") return;

      writeUnitRuntimeRecord(s.basePath, unitType, unitId, s.currentUnit.startedAt, {
        phase: "paused",
      });
      ctx.ui.notify(
        `Unit ${unitType} ${unitId} made no meaningful progress for ${supervisor.idle_timeout_minutes}min. Pausing auto-mode.`,
        "warning",
      );
      await pauseAuto(ctx, pi);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[idle-watchdog] Unhandled error: ${message}`);
      try {
        ctx.ui.notify(`Idle watchdog error: ${message}`, "warning");
      } catch { /* best effort */ }
    }
  }, 15000);

  // ── 3. Hard timeout ──
  s.unitTimeoutHandle = setTimeout(async () => {
    try {
      s.unitTimeoutHandle = null;
      if (!s.active) return;
      if (s.currentUnit) {
        writeUnitRuntimeRecord(s.basePath, unitType, unitId, s.currentUnit.startedAt, {
          phase: "timeout",
          timeoutAt: Date.now(),
        });
        await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, buildSnapshotOpts());
      } else {
        saveActivityLog(ctx, s.basePath, unitType, unitId);
      }

      const recovery = await recoverTimedOutUnit(ctx, pi, unitType, unitId, "hard", buildRecoveryContext());
      if (recovery === "recovered") return;

      ctx.ui.notify(
        `Unit ${unitType} ${unitId} exceeded ${supervisor.hard_timeout_minutes}min hard timeout. Pausing auto-mode.`,
        "warning",
      );
      await pauseAuto(ctx, pi);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[hard-timeout] Unhandled error: ${message}`);
      try {
        ctx.ui.notify(`Hard timeout error: ${message}`, "warning");
      } catch { /* best effort */ }
    }
  }, hardTimeoutMs);

  // ── 4. Context-pressure continue-here monitor ──
  if (s.continueHereHandle) {
    clearInterval(s.continueHereHandle);
    s.continueHereHandle = null;
  }
  const executorContextWindow = resolveExecutorContextWindow(
    ctx.modelRegistry as Parameters<typeof resolveExecutorContextWindow>[0],
    prefs as Parameters<typeof resolveExecutorContextWindow>[1],
    ctx.model?.contextWindow,
  );
  const continueHereThreshold = computeBudgets(executorContextWindow).continueThresholdPercent;
  s.continueHereHandle = setInterval(() => {
    if (!s.active || !s.currentUnit || !s.cmdCtx) return;
    const runtime = readUnitRuntimeRecord(s.basePath, unitType, unitId);
    if (runtime?.continueHereFired) return;

    const contextUsage = s.cmdCtx.getContextUsage();
    if (!contextUsage || contextUsage.percent == null || contextUsage.percent < continueHereThreshold) return;

    writeUnitRuntimeRecord(s.basePath, unitType, unitId, s.currentUnit!.startedAt, {
      continueHereFired: true,
    });

    if (s.verbose) {
      ctx.ui.notify(
        `Context at ${contextUsage.percent}% (threshold: ${continueHereThreshold}%) — sending wrap-up signal.`,
        "info",
      );
    }

    pi.sendMessage(
      {
        customType: "gsd-auto-wrapup",
        display: s.verbose,
        content: [
          "**CONTEXT BUDGET WARNING — wrap up this unit now.**",
          `Context window is at ${contextUsage.percent}% (threshold: ${continueHereThreshold}%).`,
          "The next unit needs a fresh context to work effectively. Wrap up now:",
          "1. Finish any in-progress file writes",
          "2. Write or update the required durable artifacts (summary, checkboxes)",
          "3. Mark task state on disk correctly",
          "4. Leave precise resume notes if anything remains unfinished",
          "Do NOT start new sub-tasks or investigations.",
        ].join("\n"),
      },
      { triggerTurn: true },
    );

    if (s.continueHereHandle) {
      clearInterval(s.continueHereHandle);
      s.continueHereHandle = null;
    }
  }, 15_000);
}
