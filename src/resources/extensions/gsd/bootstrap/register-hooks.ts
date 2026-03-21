import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import { isToolCallEventType } from "@gsd/pi-coding-agent";

import { buildMilestoneFileName, resolveMilestonePath, resolveSliceFile, resolveSlicePath } from "../paths.js";
import { buildBeforeAgentStartResult } from "./system-context.js";
import { handleAgentEnd } from "./agent-end-recovery.js";
import { clearDiscussionFlowState, isDepthVerified, isQueuePhaseActive, markDepthVerified, resetWriteGateState, shouldBlockContextWrite } from "./write-gate.js";
import { getDiscussionMilestoneId } from "../guided-flow.js";
import { loadToolApiKeys } from "../commands-config.js";
import { loadFile, saveFile, formatContinue } from "../files.js";
import { deriveState } from "../state.js";
import { getAutoDashboardData, isAutoActive, isAutoPaused, markToolEnd, markToolStart } from "../auto.js";
import { isParallelActive, shutdownParallel } from "../parallel-orchestrator.js";
import { saveActivityLog } from "../activity-log.js";

// Skip the welcome screen on the very first session_start — cli.ts already
// printed it before the TUI launched. Only re-print on /clear (subsequent sessions).
let isFirstSession = true;

export function registerHooks(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    resetWriteGateState();
    if (isFirstSession) {
      isFirstSession = false;
    } else {
      try {
        const gsdBinPath = process.env.GSD_BIN_PATH;
        if (gsdBinPath) {
          const { dirname } = await import('node:path');
          const { printWelcomeScreen } = await import(
            join(dirname(gsdBinPath), 'welcome-screen.js')
          ) as { printWelcomeScreen: (opts: { version: string; modelName?: string; provider?: string }) => void };
          printWelcomeScreen({ version: process.env.GSD_VERSION || '0.0.0' });
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

  pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
    return buildBeforeAgentStartResult(event, ctx);
  });

  pi.on("agent_end", async (event, ctx: ExtensionContext) => {
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
    if (!milestoneId) return;

    const details = event.details as any;
    if (details?.cancelled || !details?.response) return;

    const questions: any[] = (event.input as any)?.questions ?? [];
    for (const question of questions) {
      if (typeof question.id === "string" && question.id.includes("depth_verification")) {
        markDepthVerified();
        break;
      }
    }

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
}

