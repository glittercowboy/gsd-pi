/**
 * Timeout recovery logic for auto-mode units.
 * Handles idle and hard timeout recovery with escalation, steering messages,
 * and blocker reporting via engine.
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import {
  resolveExpectedArtifactPath,
  diagnoseExpectedArtifact,
} from "./auto-artifact-paths.js";
import { existsSync } from "node:fs";

import { resolveAgentEnd } from "./auto-loop.js";

export interface RecoveryContext {
  basePath: string;
  verbose: boolean;
  currentUnitStartedAt: number;
  unitRecoveryCount: Map<string, number>;
}

export async function recoverTimedOutUnit(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  unitType: string,
  unitId: string,
  reason: "idle" | "hard",
  rctx: RecoveryContext,
): Promise<"recovered" | "paused"> {
  const { basePath, verbose, unitRecoveryCount } = rctx;

  const maxRecoveryAttempts = reason === "idle" ? 2 : 1;

  const recoveryKey = `${unitType}/${unitId}`;
  const attemptNumber = (unitRecoveryCount.get(recoveryKey) ?? 0) + 1;
  unitRecoveryCount.set(recoveryKey, attemptNumber);
  // recoveryAttempts is 0-based: attempt 1 = recoveryAttempts 0
  const recoveryAttempts = attemptNumber - 1;

  if (attemptNumber > 1) {
    // Exponential backoff: 2^(n-1) seconds, capped at 30s
    const backoffMs = Math.min(1000 * Math.pow(2, attemptNumber - 2), 30000);
    ctx.ui.notify(
      `Recovery attempt ${attemptNumber} for ${unitType} ${unitId}. Waiting ${backoffMs / 1000}s before retry.`,
      "info",
    );
    await new Promise(r => setTimeout(r, backoffMs));
  }

  if (unitType === "execute-task") {
    // Check durability via artifact paths (engine-based status check)
    const { isEngineAvailable, WorkflowEngine } = await import("./workflow-engine.js");
    let durableComplete = false;
    let diagnostic = "unknown status";

    if (isEngineAvailable(basePath)) {
      try {
        const parts = unitId.split("/");
        const [mid, sid, tid] = parts;
        if (mid && sid && tid) {
          const engine = new WorkflowEngine(basePath);
          const taskRow = engine.getTask(mid, sid, tid);
          durableComplete = !!(taskRow && taskRow.status === "done" && taskRow.summary);
          diagnostic = durableComplete
            ? "all durable task artifacts present"
            : `task status: ${taskRow?.status ?? "not found"}, summary: ${taskRow?.summary ? "present" : "missing"}`;
        }
      } catch {
        durableComplete = false;
        diagnostic = "engine query failed";
      }
    } else {
      // No engine — fall back to artifact path check
      const artifactPath = resolveExpectedArtifactPath(unitType, unitId, basePath);
      durableComplete = !!(artifactPath && existsSync(artifactPath));
      diagnostic = durableComplete ? "artifact exists on disk" : "artifact missing";
    }

    if (durableComplete) {
      ctx.ui.notify(
        `${reason === "idle" ? "Idle" : "Timeout"} recovery: ${unitType} ${unitId} already completed on disk. Continuing auto-mode. (attempt ${attemptNumber})`,
        "info",
      );
      unitRecoveryCount.delete(recoveryKey);
      resolveAgentEnd({ messages: [], _synthetic: "timeout-recovery" } as any);
      return "recovered";
    }

    if (recoveryAttempts < maxRecoveryAttempts) {
      const isEscalation = recoveryAttempts > 0;

      const steeringLines = isEscalation
        ? [
            `**FINAL ${reason === "idle" ? "IDLE" : "HARD TIMEOUT"} RECOVERY — last chance before this task is skipped.**`,
            `You are still executing ${unitType} ${unitId}.`,
            `Recovery attempt ${recoveryAttempts + 1} of ${maxRecoveryAttempts}.`,
            `Current durability status: ${diagnostic}.`,
            "You MUST finish the durable output NOW, even if incomplete.",
            "Write the task summary with whatever you have accomplished so far.",
            "Mark the task [x] in the plan. Commit your work.",
            "A partial summary is infinitely better than no summary.",
          ]
        : [
            `**${reason === "idle" ? "IDLE" : "HARD TIMEOUT"} RECOVERY — do not stop.**`,
            `You are still executing ${unitType} ${unitId}.`,
            `Recovery attempt ${recoveryAttempts + 1} of ${maxRecoveryAttempts}.`,
            `Current durability status: ${diagnostic}.`,
            "Do not keep exploring.",
            "Immediately finish the required durable output for this unit.",
            "If full completion is impossible, write the partial artifact/state needed for recovery and make the blocker explicit.",
          ];

      pi.sendMessage(
        {
          customType: "gsd-auto-timeout-recovery",
          display: verbose,
          content: steeringLines.join("\n"),
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
      ctx.ui.notify(
        `${reason === "idle" ? "Idle" : "Timeout"} recovery: steering ${unitType} ${unitId} to finish durable output (attempt ${attemptNumber}, session ${recoveryAttempts + 1}/${maxRecoveryAttempts}).`,
        "warning",
      );
      return "recovered";
    }

    // Retries exhausted — report blocker via engine and advance.
    const [mid, sid, tid] = unitId.split("/");
    let reported = false;
    if (mid && sid && tid) {
      try {
        if (isEngineAvailable(basePath)) {
          const engine = new WorkflowEngine(basePath);
          engine.reportBlocker({
            milestoneId: mid,
            sliceId: sid,
            taskId: tid,
            description: `${reason} recovery exhausted ${maxRecoveryAttempts} attempts. ${diagnostic}`,
          });
          reported = true;
        }
      } catch {
        // Engine not available — fall through to pause
      }
    }

    if (reported) {
      ctx.ui.notify(
        `${unitType} ${unitId} skipped after ${maxRecoveryAttempts} recovery attempts (${diagnostic}). Blocker reported via engine. Advancing pipeline. (attempt ${attemptNumber})`,
        "warning",
      );
      unitRecoveryCount.delete(recoveryKey);
      resolveAgentEnd({ messages: [], _synthetic: "timeout-recovery" } as any);
      return "recovered";
    }

    // Fallback: engine not available — pause as before.
    ctx.ui.notify(
      `${reason === "idle" ? "Idle" : "Timeout"} recovery check for ${unitType} ${unitId}: ${diagnostic}`,
      "warning",
    );
    return "paused";
  }

  const expected = diagnoseExpectedArtifact(unitType, unitId, basePath) ?? "required durable artifact";

  // Check if the artifact already exists on disk — agent may have written it
  // without signaling completion.
  const artifactPath = resolveExpectedArtifactPath(unitType, unitId, basePath);
  if (artifactPath && existsSync(artifactPath)) {
    ctx.ui.notify(
      `${reason === "idle" ? "Idle" : "Timeout"} recovery: ${unitType} ${unitId} artifact already exists on disk. Advancing. (attempt ${attemptNumber})`,
      "info",
    );
    unitRecoveryCount.delete(recoveryKey);
    resolveAgentEnd({ messages: [], _synthetic: "timeout-recovery" } as any);
    return "recovered";
  }

  if (recoveryAttempts < maxRecoveryAttempts) {
    const isEscalation = recoveryAttempts > 0;

    const steeringLines = isEscalation
      ? [
          `**FINAL ${reason === "idle" ? "IDLE" : "HARD TIMEOUT"} RECOVERY — last chance before skip.**`,
          `You are still executing ${unitType} ${unitId}.`,
          `Recovery attempt ${recoveryAttempts + 1} of ${maxRecoveryAttempts} — next failure skips this unit.`,
          `Expected durable output: ${expected}.`,
          "You MUST write the artifact file NOW, even if incomplete.",
          "Write whatever you have — partial research, preliminary findings, best-effort analysis.",
          "A partial artifact is infinitely better than no artifact.",
          "If you are truly blocked, write the file with a BLOCKER section explaining why.",
        ]
      : [
          `**${reason === "idle" ? "IDLE" : "HARD TIMEOUT"} RECOVERY — stay in auto-mode.**`,
          `You are still executing ${unitType} ${unitId}.`,
          `Recovery attempt ${recoveryAttempts + 1} of ${maxRecoveryAttempts}.`,
          `Expected durable output: ${expected}.`,
          "Stop broad exploration.",
          "Write the required artifact now.",
          "If blocked, write the partial artifact and explicitly record the blocker instead of going silent.",
        ];

    pi.sendMessage(
      {
        customType: "gsd-auto-timeout-recovery",
        display: verbose,
        content: steeringLines.join("\n"),
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
    ctx.ui.notify(
      `${reason === "idle" ? "Idle" : "Timeout"} recovery: steering ${unitType} ${unitId} to produce ${expected} (attempt ${attemptNumber}, session ${recoveryAttempts + 1}/${maxRecoveryAttempts}).`,
      "warning",
    );
    return "recovered";
  }

  // Retries exhausted — report blocker via engine and advance the pipeline
  // instead of silently stalling.
  let blockerReported = false;
  try {
    const parts = unitId.split("/");
    const [bMid, bSid, bTid] = parts;
    if (bMid && bSid && bTid) {
      const { WorkflowEngine, isEngineAvailable } = await import("./workflow-engine.js");
      if (isEngineAvailable(basePath)) {
        const engine = new WorkflowEngine(basePath);
        engine.reportBlocker({
          milestoneId: bMid,
          sliceId: bSid,
          taskId: bTid,
          description: `${reason} recovery exhausted ${maxRecoveryAttempts} attempts without producing the artifact.`,
        });
        blockerReported = true;
      }
    }
  } catch {
    // Engine not available — fall through
  }

  if (blockerReported) {
    ctx.ui.notify(
      `${unitType} ${unitId} skipped after ${maxRecoveryAttempts} recovery attempts. Blocker reported via engine. Advancing pipeline. (attempt ${attemptNumber})`,
      "warning",
    );
    unitRecoveryCount.delete(recoveryKey);
    resolveAgentEnd({ messages: [], _synthetic: "timeout-recovery" } as any);
    return "recovered";
  }

  // Fallback: couldn't resolve artifact path — pause as before.
  return "paused";
}
