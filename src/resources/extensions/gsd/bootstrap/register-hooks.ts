import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import { isToolCallEventType } from "@gsd/pi-coding-agent";

import { buildMilestoneFileName, resolveMilestonePath, resolveSliceFile, resolveSlicePath } from "../paths.js";
import { buildBeforeAgentStartResult } from "./system-context.js";
import { handleAgentEnd } from "./agent-end-recovery.js";
import { clearDiscussionFlowState, isDepthVerified, isQueuePhaseActive, markDepthVerified, resetWriteGateState, shouldBlockContextWrite } from "./write-gate.js";
import { isBlockedStateFile, isBashWriteToStateFile, BLOCKED_WRITE_ERROR } from "../write-intercept.js";
import { getDiscussionMilestoneId } from "../guided-flow.js";
import { loadToolApiKeys } from "../commands-config.js";
import { loadFile, saveFile, formatContinue } from "../files.js";
import { deriveState } from "../state.js";
import { getAutoDashboardData, isAutoActive, isAutoPaused, markToolEnd, markToolStart } from "../auto.js";
import { isParallelActive, shutdownParallel } from "../parallel-orchestrator.js";
import { checkToolCallLoop, resetToolCallLoopGuard } from "./tool-call-loop-guard.js";
import { saveActivityLog } from "../activity-log.js";
import { startRtkStatusUpdates, stopRtkStatusUpdates } from "../rtk-status.js";
import { rewriteCommandWithRtk } from "../../shared/rtk.js";

// Skip the welcome screen on the very first session_start — cli.ts already
// printed it before the TUI launched. Only re-print on /clear (subsequent sessions).
let isFirstSession = true;

async function syncServiceTierStatus(ctx: ExtensionContext): Promise<void> {
  const { getEffectiveServiceTier, formatServiceTierFooterStatus } = await import("../service-tier.js");
  ctx.ui.setStatus("gsd-fast", formatServiceTierFooterStatus(getEffectiveServiceTier(), ctx.model?.id));
}

export function registerHooks(pi: ExtensionAPI): void {
  // Route all agent bash tool commands through RTK rewrite when opted in.
  // This is a no-op when RTK is disabled or not installed.
  pi.on("bash_transform", async (event) => {
    const rewritten = rewriteCommandWithRtk(event.command);
    if (rewritten === event.command) return undefined;
    return { command: rewritten };
  });

  pi.on("session_start", async (_event, ctx) => {
    resetWriteGateState();
    resetToolCallLoopGuard();
    await syncServiceTierStatus(ctx);
    startRtkStatusUpdates(ctx);

    // Apply show_token_cost preference (#1515)
    try {
      const { loadEffectiveGSDPreferences } = await import("../preferences.js");
      const prefs = loadEffectiveGSDPreferences();
      process.env.GSD_SHOW_TOKEN_COST = prefs?.preferences.show_token_cost ? "1" : "";
    } catch { /* non-fatal */ }
    if (isFirstSession) {
      isFirstSession = false;
    } else {
      try {
        const gsdBinPath = process.env.GSD_BIN_PATH;
        if (gsdBinPath) {
          const { dirname } = await import("node:path");
          const { printWelcomeScreen } = await import(
            join(dirname(gsdBinPath), "welcome-screen.js")
          ) as { printWelcomeScreen: (opts: { version: string; modelName?: string; provider?: string }) => void };
          printWelcomeScreen({ version: process.env.GSD_VERSION || "0.0.0" });
        }
      } catch { /* non-fatal */ }
    }
    loadToolApiKeys();
    try {
      const [{ getRemoteConfigStatus }, { getLatestPromptSummary }] = await Promise.all([
        import("../../remote-questions/config.js"),
        import("../../remote-questions/status.js"),
      ]);
      const status = getRemoteConfigStatus();
      const latest = getLatestPromptSummary();
      if (!status.includes("not configured")) {
        const suffix = latest ? `\nLast remote prompt: ${latest.id} (${latest.status})` : "";
        ctx.ui.notify(`${status}${suffix}`, status.includes("disabled") ? "warning" : "info");
      }
    } catch {
      // ignore
    }
  });

  pi.on("session_switch", async (_event, ctx) => {
    resetWriteGateState();
    resetToolCallLoopGuard();
    clearDiscussionFlowState();
    await syncServiceTierStatus(ctx);
    loadToolApiKeys();
    startRtkStatusUpdates(ctx);
  });

  pi.on("session_fork", async (_event, ctx) => {
    startRtkStatusUpdates(ctx);
  });

  pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
    return buildBeforeAgentStartResult(event, ctx);
  });

  pi.on("agent_end", async (event, ctx: ExtensionContext) => {
    resetToolCallLoopGuard();
    await handleAgentEnd(pi, event, ctx);
  });

  pi.on("session_before_compact", async () => {
    if (isAutoActive() || isAutoPaused()) {
      return { cancel: true };
    }
    const basePath = process.cwd();
    const state = await deriveState(basePath);
    if (!state.activeMilestone || !state.activeSlice || !state.activeTask) return;
    if (state.phase !== "executing") return;

    const sliceDir = resolveSlicePath(basePath, state.activeMilestone.id, state.activeSlice.id);
    if (!sliceDir) return;

    const existingFile = resolveSliceFile(basePath, state.activeMilestone.id, state.activeSlice.id, "CONTINUE");
    if (existingFile && await loadFile(existingFile)) return;
    const legacyContinue = join(sliceDir, "continue.md");
    if (await loadFile(legacyContinue)) return;

    const continuePath = join(sliceDir, `${state.activeSlice.id}-CONTINUE.md`);
    await saveFile(continuePath, formatContinue({
      frontmatter: {
        milestone: state.activeMilestone.id,
        slice: state.activeSlice.id,
        task: state.activeTask.id,
        step: 0,
        totalSteps: 0,
        status: "compacted" as const,
        savedAt: new Date().toISOString(),
      },
      completedWork: `Task ${state.activeTask.id} (${state.activeTask.title}) was in progress when compaction occurred.`,
      remainingWork: "Check the task plan for remaining steps.",
      decisions: "Check task summary files for prior decisions.",
      context: "Session was auto-compacted by Pi. Resume with /gsd.",
      nextAction: `Resume task ${state.activeTask.id}: ${state.activeTask.title}.`,
    }));
  });

  pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
    stopRtkStatusUpdates(ctx);
    if (isParallelActive()) {
      try {
        await shutdownParallel(process.cwd());
      } catch {
        // best-effort
      }
    }
    if (!isAutoActive() && !isAutoPaused()) return;
    const dash = getAutoDashboardData();
    if (dash.currentUnit) {
      saveActivityLog(ctx, dash.basePath, dash.currentUnit.type, dash.currentUnit.id);
    }
  });

  pi.on("tool_call", async (event) => {
    // ── Loop guard: block repeated identical tool calls ──
    const loopCheck = checkToolCallLoop(event.toolName, event.input as Record<string, unknown>);
    if (loopCheck.block) {
      return { block: true, reason: loopCheck.reason };
    }

    // ── Single-writer engine: block direct writes to STATE.md ──────────
    // Covers write, edit, and bash tools to prevent bypass vectors.
    if (isToolCallEventType("write", event)) {
      if (isBlockedStateFile(event.input.path)) {
        return { block: true, reason: BLOCKED_WRITE_ERROR };
      }
    }

    if (isToolCallEventType("edit", event)) {
      if (isBlockedStateFile(event.input.path)) {
        return { block: true, reason: BLOCKED_WRITE_ERROR };
      }
    }

    if (isToolCallEventType("bash", event)) {
      if (isBashWriteToStateFile(event.input.command)) {
        return { block: true, reason: BLOCKED_WRITE_ERROR };
      }
    }

    if (!isToolCallEventType("write", event)) return;

    const result = shouldBlockContextWrite(
      event.toolName,
      event.input.path,
      getDiscussionMilestoneId(),
      isDepthVerified(),
      isQueuePhaseActive(),
    );
    if (result.block) return result;
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "ask_user_questions") return;
    const milestoneId = getDiscussionMilestoneId();
    const queueActive = isQueuePhaseActive();
    if (!milestoneId && !queueActive) return;

    const details = event.details as any;
    if (details?.cancelled || !details?.response) return;

    const questions: any[] = (event.input as any)?.questions ?? [];
    for (const question of questions) {
      if (typeof question.id === "string" && question.id.includes("depth_verification")) {
        markDepthVerified();
        break;
      }
    }

    if (!milestoneId) return;

    const basePath = process.cwd();
    const milestoneDir = resolveMilestonePath(basePath, milestoneId);
    if (!milestoneDir) return;

    const discussionPath = join(milestoneDir, buildMilestoneFileName(milestoneId, "DISCUSSION"));
    const timestamp = new Date().toISOString();
    const lines: string[] = [`## Exchange — ${timestamp}`, ""];
    for (const question of questions) {
      lines.push(`### ${question.header ?? "Question"}`, "", question.question ?? "");
      if (Array.isArray(question.options)) {
        lines.push("");
        for (const opt of question.options) {
          lines.push(`- **${opt.label}** — ${opt.description ?? ""}`);
        }
      }
      const answer = details.response?.answers?.[question.id];
      if (answer) {
        lines.push("");
        const selected = Array.isArray(answer.selected) ? answer.selected.join(", ") : answer.selected;
        lines.push(`**Selected:** ${selected}`);
        if (answer.notes) {
          lines.push(`**Notes:** ${answer.notes}`);
        }
      }
      lines.push("");
    }
    lines.push("---", "");
    const existing = await loadFile(discussionPath) ?? `# ${milestoneId} Discussion Log\n\n`;
    await saveFile(discussionPath, existing + lines.join("\n"));
  });

  pi.on("tool_execution_start", async (event) => {
    if (!isAutoActive()) return;
    markToolStart(event.toolCallId);
  });

  pi.on("tool_execution_end", async (event) => {
    markToolEnd(event.toolCallId);
  });

  pi.on("model_select", async (_event, ctx) => {
    await syncServiceTierStatus(ctx);
  });

  pi.on("before_provider_request", async (event) => {
    const modelId = event.model?.id;
    if (!modelId) return;
    const { getEffectiveServiceTier, supportsServiceTier } = await import("../service-tier.js");
    const tier = getEffectiveServiceTier();
    if (!tier || !supportsServiceTier(modelId)) return;
    const payload = event.payload as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object") return;
    payload.service_tier = tier;
    return payload;
  });
}
