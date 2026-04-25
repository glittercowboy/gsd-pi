import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import { isToolCallEventType } from "@gsd/pi-coding-agent";

import type { GSDEcosystemBeforeAgentStartHandler } from "../ecosystem/gsd-extension-api.js";
import { updateSnapshot } from "../ecosystem/gsd-extension-api.js";
import { getEcosystemReadyPromise } from "../ecosystem/loader.js";

import { buildMilestoneFileName, resolveMilestonePath, resolveSliceFile, resolveSlicePath } from "../paths.js";
import { buildBeforeAgentStartResult } from "./system-context.js";
import { handleAgentEnd } from "./agent-end-recovery.js";
import { clearDiscussionFlowState, isDepthConfirmationAnswer, isQueuePhaseActive, markDepthVerified, resetWriteGateState, shouldBlockContextWrite, shouldBlockQueueExecution, isGateQuestionId, setPendingGate, clearPendingGate, getPendingGate, shouldBlockPendingGate, shouldBlockPendingGateBash, extractDepthVerificationMilestoneId } from "./write-gate.js";
import { isBlockedStateFile, isBashWriteToStateFile, BLOCKED_WRITE_ERROR } from "../write-intercept.js";
import { cleanupQuickBranch } from "../quick.js";
import { getDiscussionMilestoneId } from "../guided-flow.js";
import { loadToolApiKeys } from "../commands-config.js";
import { loadFile, saveFile, formatContinue } from "../files.js";
import { deriveState } from "../state.js";
import { getAutoDashboardData, isAutoActive, isAutoPaused, markToolEnd, markToolStart, recordToolInvocationError } from "../auto.js";

import { isParallelActive, shutdownParallel } from "../parallel-orchestrator.js";
import { checkToolCallLoop, resetToolCallLoopGuard } from "./tool-call-loop-guard.js";
import { saveActivityLog } from "../activity-log.js";
import { resetAskUserQuestionsCache } from "../../ask-user-questions.js";
import { recordToolCall as safetyRecordToolCall, recordToolResult as safetyRecordToolResult, saveEvidenceToDisk } from "../safety/evidence-collector.js";
import { parseUnitId } from "../unit-id.js";
import { classifyCommand } from "../safety/destructive-guard.js";
import { logWarning as safetyLogWarning } from "../workflow-logger.js";
import { installNotifyInterceptor } from "./notify-interceptor.js";
import { initNotificationStore } from "../notification-store.js";
import { initNotificationWidget } from "../notification-widget.js";
import { initHealthWidget } from "../health-widget.js";

// Skip the welcome screen on the very first session_start — cli.ts already
// printed it before the TUI launched. Only re-print on /clear (subsequent sessions).
let isFirstSession = true;

async function syncServiceTierStatus(ctx: ExtensionContext): Promise<void> {
  const { getEffectiveServiceTier, formatServiceTierFooterStatus } = await import("../service-tier.js");
  ctx.ui.setStatus("gsd-fast", formatServiceTierFooterStatus(getEffectiveServiceTier(), ctx.model?.id));
}

export function registerHooks(
  pi: ExtensionAPI,
  ecosystemHandlers: GSDEcosystemBeforeAgentStartHandler[],
): void {
  pi.on("session_start", async (_event, ctx) => {
    initNotificationStore(process.cwd());
    installNotifyInterceptor(ctx);
    initNotificationWidget(ctx);
    if (!isAutoActive()) {
      initHealthWidget(ctx);
    }
    resetWriteGateState();
    resetToolCallLoopGuard();
    resetAskUserQuestionsCache();
    await syncServiceTierStatus(ctx);
    // Skip MCP auto-prep when running inside an auto-worktree (see session_switch below).
    const { isInAutoWorktree } = await import("../auto-worktree.js");
    if (!isInAutoWorktree(process.cwd())) {
      const { prepareWorkflowMcpForProject } = await import("../workflow-mcp-auto-prep.js");
      prepareWorkflowMcpForProject(ctx, process.cwd());
    }

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
          ) as { printWelcomeScreen: (opts: { version: string; modelName?: string; provider?: string; remoteChannel?: string }) => void };

          let remoteChannel: string | undefined;
          try {
            const { resolveRemoteConfig } = await import("../../remote-questions/config.js");
            const rc = resolveRemoteConfig();
            if (rc) remoteChannel = rc.channel;
          } catch { /* non-fatal */ }

          printWelcomeScreen({ version: process.env.GSD_VERSION || "0.0.0", remoteChannel });
        }
      } catch { /* non-fatal */ }
    }
    loadToolApiKeys();
    if (isAutoActive()) {
      ctx.ui.setWidget("gsd-health", undefined);
    }
  });

  pi.on("session_switch", async (_event, ctx) => {
    initNotificationStore(process.cwd());
    installNotifyInterceptor(ctx);
    resetWriteGateState();
    resetToolCallLoopGuard();
    resetAskUserQuestionsCache();
    clearDiscussionFlowState();
    await syncServiceTierStatus(ctx);
    // Skip MCP auto-prep when running inside an auto-worktree. The worktree
    // already has .mcp.json from createAutoWorktree, and re-running the writer
    // post-chdir rewrites the file mid-run (non-idempotent due to cwd-relative
    // CLI path resolution), dirtying the tree and breaking the milestone merge.
    const { isInAutoWorktree } = await import("../auto-worktree.js");
    if (!isInAutoWorktree(process.cwd())) {
      const { prepareWorkflowMcpForProject } = await import("../workflow-mcp-auto-prep.js");
      prepareWorkflowMcpForProject(ctx, process.cwd());
    }
    loadToolApiKeys();
    if (isAutoActive()) {
      ctx.ui.setWidget("gsd-health", undefined);
    }
  });

  pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
    // Wait for ecosystem loader to finish (no-op after first turn).
    await getEcosystemReadyPromise();

    // GSD's own context injection (existing behavior — unchanged).
    const gsdResult = await buildBeforeAgentStartResult(event, ctx);

    // Refresh the snapshot used by ecosystem getPhase()/getActiveUnit().
    // deriveState has its own ~100ms cache so this is cheap on repeat calls.
    try {
      const state = await deriveState(process.cwd());
      updateSnapshot(state);
    } catch {
      updateSnapshot(null);
    }

    // Chain ecosystem handlers using pi's runner.ts chaining protocol:
    // each handler sees the systemPrompt mutated by prior handlers.
    let currentSystemPrompt = gsdResult?.systemPrompt ?? event.systemPrompt;
    // `any` because pi's BeforeAgentStartEventResult.message uses an internal
    // CustomMessage type that's not re-exported (see ecosystem/gsd-extension-api.ts).
    let lastMessage: any = gsdResult?.message;

    for (const handler of ecosystemHandlers) {
      try {
        const r = await handler(
          { ...event, systemPrompt: currentSystemPrompt },
          ctx,
        );
        if (r?.systemPrompt !== undefined) currentSystemPrompt = r.systemPrompt;
        if (r?.message) lastMessage = r.message;
      } catch (err) {
        safetyLogWarning(
          "ecosystem",
          `before_agent_start handler failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Compose result. Return undefined if nothing changed (preserves runner contract).
    if (currentSystemPrompt === event.systemPrompt && !lastMessage) return undefined;
    return {
      systemPrompt: currentSystemPrompt !== event.systemPrompt ? currentSystemPrompt : undefined,
      message: lastMessage,
    };
  });

  pi.on("agent_end", async (event, ctx: ExtensionContext) => {
    resetToolCallLoopGuard();
    resetAskUserQuestionsCache();
    await handleAgentEnd(pi, event, ctx);
  });

  // Squash-merge quick-task branch back to the original branch after the
  // agent turn completes (#2668). cleanupQuickBranch is a no-op when no
  // quick-return state is pending, so this is safe to call on every turn.
  pi.on("turn_end", async () => {
    try {
      cleanupQuickBranch();
    } catch {
      // Best-effort: don't break the turn lifecycle if cleanup fails.
    }
  });

  pi.on("session_before_compact", async () => {
    // Only cancel compaction while auto-mode is actively running.
    // Paused auto-mode should allow compaction — the user may be doing
    // interactive work (#3165).
    if (isAutoActive()) {
      return { cancel: true };
    }
    const basePath = process.cwd();
    const { ensureDbOpen } = await import("./dynamic-tools.js");
    await ensureDbOpen();
    const state = await deriveState(basePath);
    if (!state.activeMilestone || !state.activeSlice || !state.activeTask) return;
    // Write checkpoint for ALL phases, not just "executing" — discuss, research,
    // and planning also carry in-memory state (user answers, gate verification)
    // that would be lost on compaction (#4258).
    // if (state.phase !== "executing") return;

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

  // Context-mode snapshot: write .gsd/last-snapshot.md before compaction so
  // agents can call gsd_resume (or Read the file) to re-orient. Opt-in via
  // preferences.context_mode.enabled. Runs after the auto-cancel handler
  // above — if that one returned cancel:true, pi still fires us but the
  // compaction won't actually happen; the snapshot is still useful then,
  // since auto may pause and resume later.
  pi.on("session_before_compact", async () => {
    try {
      const { loadEffectiveGSDPreferences } = await import("../preferences.js");
      const { isContextModeEnabled } = await import("../preferences-types.js");
      const prefs = loadEffectiveGSDPreferences();
      if (!isContextModeEnabled(prefs?.preferences)) return;
      const { writeCompactionSnapshot } = await import("../compaction-snapshot.js");
      const { ensureDbOpen } = await import("./dynamic-tools.js");
      await ensureDbOpen();
      const basePath = process.cwd();
      let activeContext: string | null = null;
      try {
        const state = await deriveState(basePath);
        if (state.activeMilestone && state.activeSlice && state.activeTask) {
          activeContext =
            `Active: ${state.activeMilestone.id} / ${state.activeSlice.id} / ${state.activeTask.id}` +
            (state.activeTask.title ? ` — ${state.activeTask.title}` : "");
        }
      } catch {
        /* non-fatal */
      }
      writeCompactionSnapshot(basePath, { activeContext });
    } catch (err) {
      safetyLogWarning(
        "context-mode",
        `failed to write compaction snapshot: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
    const discussionBasePath = process.cwd();
    // ── Loop guard: block repeated identical tool calls ──
    const loopCheck = checkToolCallLoop(event.toolName, event.input as Record<string, unknown>);
    if (loopCheck.block) {
      return { block: true, reason: loopCheck.reason };
    }

    // ── Discussion gate enforcement: track pending gate questions ─────────
    // Only gate-shaped ask_user_questions calls should block execution.
    // The gate stays pending until the user selects the approval option.
    if (event.toolName === "ask_user_questions") {
      const questions: any[] = (event.input as any)?.questions ?? [];
      const questionId = questions.find((question) => typeof question?.id === "string" && isGateQuestionId(question.id))?.id;
      if (typeof questionId === "string") {
        setPendingGate(questionId);
      }
    }

    // ── Discussion gate enforcement: block tool calls while gate is pending ──
    // If ask_user_questions was called with a gate ID but hasn't been confirmed,
    // block all non-read-only tool calls to prevent the model from skipping gates.
    if (getPendingGate()) {
      const milestoneId = getDiscussionMilestoneId(discussionBasePath);
      if (isToolCallEventType("bash", event)) {
        const bashGuard = shouldBlockPendingGateBash(
          event.input.command,
          milestoneId,
          isQueuePhaseActive(),
        );
        if (bashGuard.block) return bashGuard;
      } else {
        const gateGuard = shouldBlockPendingGate(
          event.toolName,
          milestoneId,
          isQueuePhaseActive(),
        );
        if (gateGuard.block) return gateGuard;
      }
    }

    // ── Queue-mode execution guard (#2545): block source-code mutations ──
    // When /gsd queue is active, the agent should only create milestones,
    // not execute work. Block write/edit to non-.gsd/ paths and bash commands
    // that would modify files.
    if (isQueuePhaseActive()) {
      let queueInput = "";
      if (isToolCallEventType("write", event)) {
        queueInput = event.input.path;
      } else if (isToolCallEventType("edit", event)) {
        queueInput = event.input.path;
      } else if (isToolCallEventType("bash", event)) {
        queueInput = event.input.command;
      }
      const queueGuard = shouldBlockQueueExecution(event.toolName, queueInput, true);
      if (queueGuard.block) return queueGuard;
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
      getDiscussionMilestoneId(discussionBasePath),
      isQueuePhaseActive(),
    );
    if (result.block) return result;
  });

  // ── Safety harness: evidence collection + destructive command warnings ──
  pi.on("tool_call", async (event, ctx) => {
    if (!isAutoActive()) return;
    markToolStart(event.toolCallId, event.toolName);
    safetyRecordToolCall(event.toolCallId, event.toolName, event.input as Record<string, unknown>);

    // Destructive command classification (warn only, never block)
    if (isToolCallEventType("bash", event)) {
      const classification = classifyCommand(event.input.command);
      if (classification.destructive) {
        safetyLogWarning("safety", `destructive command: ${classification.labels.join(", ")}`, {
          command: String(event.input.command).slice(0, 200),
        });
        ctx.ui.notify(
          `Destructive command detected: ${classification.labels.join(", ")}`,
          "warning",
        );
      }
    }
  });

  pi.on("tool_result", async (event) => {
    if (isAutoActive() && typeof event.toolCallId === "string") {
      markToolEnd(event.toolCallId);
    }
    if (isAutoActive() && event.isError && event.toolName.startsWith("gsd_")) {
      const resultPayload = ("result" in event ? event.result : undefined) as any;
      const errorText = typeof resultPayload === "string"
        ? resultPayload
        : (typeof resultPayload?.content?.[0]?.text === "string"
            ? resultPayload.content[0].text
            : (typeof (event as any).content === "string"
                ? (event as any).content
                : String(resultPayload ?? "")));
      recordToolInvocationError(event.toolName, errorText);
    }
    if (event.toolName !== "ask_user_questions") return;
    const milestoneId = getDiscussionMilestoneId(process.cwd());
    const queueActive = isQueuePhaseActive();

    const details = event.details as any;

    // ── Discussion gate enforcement: handle gate question responses ──
    // If the result is cancelled or has no response, the pending gate stays active
    // so the model is blocked from non-read-only tools until it re-asks.
    // If the user responded at all (even "needs adjustment"), clear the pending gate
    // because the user engaged — the prompt handles the re-ask-after-adjustment flow.
    const questions: any[] = (event.input as any)?.questions ?? [];
    const currentPendingGate = getPendingGate();
    if (currentPendingGate) {
      if (details?.cancelled || !details?.response) {
        // Gate stays pending — model will be blocked from non-read-only tools
        // until it re-asks and gets a valid response
      } else {
        const pendingQuestion = questions.find((question) => question?.id === currentPendingGate);
        if (pendingQuestion) {
          const answer = details.response?.answers?.[currentPendingGate];
          if (isDepthConfirmationAnswer(answer?.selected, pendingQuestion.options)) {
            clearPendingGate();
          }
        }
      }
    }

    if (details?.cancelled || !details?.response) return;

    for (const question of questions) {
      if (typeof question.id === "string" && question.id.includes("depth_verification")) {
        // Only unlock the gate if the user selected the first option (confirmation).
        // Cross-references against the question's defined options to reject free-form "Other" text.
        const answer = details.response?.answers?.[question.id];
        const inferredMilestoneId = extractDepthVerificationMilestoneId(question.id) ?? milestoneId;
        if (isDepthConfirmationAnswer(answer?.selected, question.options)) {
          markDepthVerified(inferredMilestoneId);
          clearPendingGate();
        }
        break;
      }
    }

    if (!milestoneId && !queueActive) return;
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
    markToolStart(event.toolCallId, event.toolName);
  });

  pi.on("tool_execution_end", async (event) => {
    markToolEnd(event.toolCallId);
    // #2883: Capture tool invocation errors (malformed/truncated JSON arguments)
    // so postUnitPreVerification can break the retry loop instead of re-dispatching.
    if (event.isError && event.toolName.startsWith("gsd_")) {
      const errorText = typeof event.result === "string"
        ? event.result
        : (typeof event.result?.content?.[0]?.text === "string" ? event.result.content[0].text : String(event.result));
      recordToolInvocationError(event.toolName, errorText);
    }
    // Safety harness: record tool execution results for evidence cross-referencing
    if (isAutoActive()) {
      safetyRecordToolResult(event.toolCallId, event.toolName, event.result, event.isError);
      // Persist evidence to disk after each tool result so it survives a session
      // restart mid-unit (Bug #4385 — non-persisted evidence false positives).
      const dash = getAutoDashboardData();
      if (dash.basePath && dash.currentUnit?.type === "execute-task") {
        const { milestone: pMid, slice: pSid, task: pTid } = parseUnitId(dash.currentUnit.id);
        if (pMid && pSid && pTid) {
          saveEvidenceToDisk(dash.basePath, pMid, pSid, pTid);
        }
      }
    }
  });

  pi.on("model_select", async (_event, ctx) => {
    await syncServiceTierStatus(ctx);
  });

  pi.on("before_provider_request", async (event) => {
    const payload = event.payload as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object") return;

    // ── Observation Masking ─────────────────────────────────────────────
    // Replace old tool results with placeholders to reduce context bloat.
    // Only active during auto-mode when context_management.observation_masking is enabled.
    if (isAutoActive()) {
      try {
        const { loadEffectiveGSDPreferences } = await import("../preferences.js");
        const prefs = loadEffectiveGSDPreferences();
        const cmConfig = prefs?.preferences.context_management;

        // Observation masking: replace old tool results with placeholders
        if (cmConfig?.observation_masking !== false) {
          const keepTurns = cmConfig?.observation_mask_turns ?? 8;
          const { createObservationMask } = await import("../context-masker.js");
          const mask = createObservationMask(keepTurns);
          const messages = payload.messages;
          if (Array.isArray(messages)) {
            payload.messages = mask(messages);
          }
        }

        // Tool result truncation: cap individual tool result content length.
        // In pi-ai format, toolResult messages have role: "toolResult" and content: TextContent[].
        // Creates new objects to avoid mutating shared conversation state.
        const maxChars = cmConfig?.tool_result_max_chars ?? 800;
        const msgs = payload.messages;
        if (Array.isArray(msgs)) {
          payload.messages = msgs.map((msg: Record<string, unknown>) => {
            // Match toolResult messages (role: "toolResult", content is array of content blocks)
            if (msg?.role === "toolResult" && Array.isArray(msg.content)) {
              const blocks = msg.content as Array<Record<string, unknown>>;
              const totalLen = blocks.reduce((sum: number, b) => sum + (typeof b.text === "string" ? b.text.length : 0), 0);
              if (totalLen > maxChars) {
                const truncated = blocks.map(b => {
                  if (typeof b.text === "string" && b.text.length > maxChars) {
                    return { ...b, text: b.text.slice(0, maxChars) + "\n…[truncated]" };
                  }
                  return b;
                });
                return { ...msg, content: truncated };
              }
            }
            return msg;
          });
        }
      } catch { /* non-fatal */ }
    }

    // ── Service Tier ────────────────────────────────────────────────────
    const modelId = event.model?.id;
    if (!modelId) return payload;
    const { getEffectiveServiceTier, supportsServiceTier } = await import("../service-tier.js");
    const tier = getEffectiveServiceTier();
    if (!tier || !supportsServiceTier(modelId)) return payload;
    payload.service_tier = tier;
    return payload;
  });

  // Capability-aware model routing hook (ADR-004)
  // Extensions can override model selection by returning { modelId: "..." }
  // Return undefined to let the built-in capability scoring proceed.
  pi.on("before_model_select", async (_event) => {
    // Default: no override — let capability scoring handle selection
    return undefined;
  });

  // Tool set adaptation hook (ADR-005 Phase 4)
  // Extensions can override tool set after model selection by returning { toolNames: [...] }
  // Return undefined to let the built-in provider compatibility filtering proceed.
  pi.on("adjust_tool_set", async (_event) => {
    // Default: no override — let provider capability filtering handle tool set
    return undefined;
  });
}
