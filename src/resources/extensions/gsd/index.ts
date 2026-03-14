/**
 * GSD Extension — /gsd
 *
 * One command, one wizard. Reads state from disk, shows contextual options,
 * dispatches through GSD-WORKFLOW.md. The LLM does the rest.
 *
 * Auto-mode: /gsd auto loops fresh sessions until milestone complete.
 *
 * Commands:
 *   /gsd        — contextual wizard (smart entry point)
 *   /gsd auto   — start auto-mode (fresh session per unit)
 *   /gsd stop   — stop auto-mode gracefully
 *   /gsd status — progress dashboard
 *
 * Hooks:
 *   before_agent_start — inject GSD system context for GSD projects
 *   agent_end — auto-mode advancement
 *   session_before_compact — save continue.md OR block during auto
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@gsd/pi-coding-agent";
import { createBashTool, createWriteTool, createReadTool, createEditTool, isToolCallEventType } from "@gsd/pi-coding-agent";

import { registerGSDCommand } from "./commands.js";
import { registerExitCommand } from "./exit-command.js";
import { registerWorktreeCommand, getWorktreeOriginalCwd, getActiveWorktreeName } from "./worktree-command.js";
import { saveFile, formatContinue, loadFile, parseContinue, parseSummary, loadActiveOverrides, formatOverridesSection } from "./files.js";
import { loadPrompt } from "./prompt-loader.js";
import { deriveState } from "./state.js";
import { isAutoActive, isAutoPaused, handleAgentEnd, pauseAuto, getAutoDashboardData } from "./auto.js";
import { saveActivityLog } from "./activity-log.js";
import { checkAutoStartAfterDiscuss, getDiscussionMilestoneId } from "./guided-flow.js";
import { GSDDashboardOverlay } from "./dashboard-overlay.js";
import {
  loadEffectiveGSDPreferences,
  renderPreferencesForSystemPrompt,
  resolveAllSkillReferences,
  resolveModelWithFallbacksForUnit,
  getNextFallbackModel,
} from "./preferences.js";
import { hasSkillSnapshot, detectNewSkills, formatSkillsXml } from "./skill-discovery.js";
import {
  resolveSlicePath, resolveSliceFile, resolveTaskFile, resolveTaskFiles, resolveTasksDir,
  relSliceFile, relSlicePath, relTaskFile,
  buildSliceFileName, buildMilestoneFileName, gsdRoot, resolveMilestonePath,
} from "./paths.js";
import { Key } from "@gsd/pi-tui";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { shortcutDesc } from "../shared/terminal.js";
import { Text } from "@gsd/pi-tui";

// ── Depth verification state ──────────────────────────────────────────────
let depthVerificationDone = false;

export function isDepthVerified(): boolean {
  return depthVerificationDone;
}

// ── Write-gate: block CONTEXT.md writes during discussion without depth verification ──
const MILESTONE_CONTEXT_RE = /M\d+(?:-[a-z0-9]{6})?-CONTEXT\.md$/;

export function shouldBlockContextWrite(
  toolName: string,
  inputPath: string,
  milestoneId: string | null,
  depthVerified: boolean,
): { block: boolean; reason?: string } {
  if (toolName !== "write") return { block: false };
  if (!milestoneId) return { block: false };
  if (!MILESTONE_CONTEXT_RE.test(inputPath)) return { block: false };
  if (depthVerified) return { block: false };
  return {
    block: true,
    reason: `Blocked: Cannot write to milestone CONTEXT.md during discussion phase without depth verification. Call ask_user_questions with question id "depth_verification" first to confirm discussion depth before writing context.`,
  };
}

// ── ASCII logo ────────────────────────────────────────────────────────────
const GSD_LOGO_LINES = [
  "   ██████╗ ███████╗██████╗ ",
  "  ██╔════╝ ██╔════╝██╔══██╗",
  "  ██║  ███╗███████╗██║  ██║",
  "  ██║   ██║╚════██║██║  ██║",
  "  ╚██████╔╝███████║██████╔╝",
  "   ╚═════╝ ╚══════╝╚═════╝ ",
];

export default function (pi: ExtensionAPI) {
  registerGSDCommand(pi);
  registerWorktreeCommand(pi);
  registerExitCommand(pi);

  // ── /kill — immediate exit (bypass cleanup) ─────────────────────────────
  pi.registerCommand("kill", {
    description: "Exit GSD immediately (no cleanup)",
    handler: async (_args: string, _ctx: ExtensionCommandContext) => {
      process.exit(0);
    },
  });

  // ── Dynamic-cwd bash tool with default timeout ────────────────────────
  // The built-in bash tool captures cwd at startup. This replacement uses
  // a spawnHook to read process.cwd() dynamically so that process.chdir()
  // (used by /worktree switch) propagates to shell commands.
  //
  // The upstream SDK's bash tool has no default timeout — if the LLM omits
  // the timeout parameter, commands run indefinitely, causing hangs on
  // Windows where process killing is unreliable (see #40). We wrap execute
  // to inject a 120-second default when no timeout is provided.
  const DEFAULT_BASH_TIMEOUT_SECS = 120;
  const baseBash = createBashTool(process.cwd(), {
    spawnHook: (ctx) => ({ ...ctx, cwd: process.cwd() }),
  });
  const dynamicBash = {
    ...baseBash,
    execute: async (
      toolCallId: string,
      params: { command: string; timeout?: number },
      signal?: AbortSignal,
      onUpdate?: any,
      ctx?: any,
    ) => {
      const paramsWithTimeout = {
        ...params,
        timeout: params.timeout ?? DEFAULT_BASH_TIMEOUT_SECS,
      };
      return (baseBash as any).execute(toolCallId, paramsWithTimeout, signal, onUpdate, ctx);
    },
  };
  pi.registerTool(dynamicBash as any);

  // ── Dynamic-cwd file tools (write, read, edit) ────────────────────────
  // The built-in file tools capture cwd at startup. When process.chdir()
  // moves us into a worktree, relative paths still resolve against the
  // original launch directory. These replacements delegate to freshly-
  // created tools on each call so that process.cwd() is read dynamically.
  const baseWrite = createWriteTool(process.cwd());
  const dynamicWrite = {
    ...baseWrite,
    execute: async (
      toolCallId: string,
      params: { path: string; content: string },
      signal?: AbortSignal,
      onUpdate?: any,
      ctx?: any,
    ) => {
      const fresh = createWriteTool(process.cwd());
      return (fresh as any).execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
  pi.registerTool(dynamicWrite as any);

  const baseRead = createReadTool(process.cwd());
  const dynamicRead = {
    ...baseRead,
    execute: async (
      toolCallId: string,
      params: { path: string; offset?: number; limit?: number },
      signal?: AbortSignal,
      onUpdate?: any,
      ctx?: any,
    ) => {
      const fresh = createReadTool(process.cwd());
      return (fresh as any).execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
  pi.registerTool(dynamicRead as any);

  const baseEdit = createEditTool(process.cwd());
  const dynamicEdit = {
    ...baseEdit,
    execute: async (
      toolCallId: string,
      params: { path: string; oldText: string; newText: string },
      signal?: AbortSignal,
      onUpdate?: any,
      ctx?: any,
    ) => {
      const fresh = createEditTool(process.cwd());
      return (fresh as any).execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
  pi.registerTool(dynamicEdit as any);

  // ── session_start: render branded GSD header + remote channel status ──
  pi.on("session_start", async (_event, ctx) => {
    // Theme access throws in RPC mode (no TUI) — header is decorative, skip it
    try {
      const theme = ctx.ui.theme;
      const version = process.env.GSD_VERSION || "0.0.0";

      const logoText = GSD_LOGO_LINES.map((line) => theme.fg("accent", line)).join("\n");
      const titleLine = `  ${theme.bold("Get Shit Done")} ${theme.fg("dim", `v${version}`)}`;

      const headerContent = `${logoText}\n${titleLine}`;
      ctx.ui.setHeader((_ui, _theme) => new Text(headerContent, 1, 0));
    } catch {
      // RPC mode — no TUI, skip header rendering
    }

    // Notify remote questions status if configured
    try {
      const [{ getRemoteConfigStatus }, { getLatestPromptSummary }] = await Promise.all([
        import("../remote-questions/config.js"),
        import("../remote-questions/status.js"),
      ]);
      const status = getRemoteConfigStatus();
      const latest = getLatestPromptSummary();
      if (!status.includes("not configured")) {
        const suffix = latest ? `\nLast remote prompt: ${latest.id} (${latest.status})` : "";
        ctx.ui.notify(`${status}${suffix}`, status.includes("disabled") ? "warning" : "info");
      }
    } catch {
      // Remote questions module not available — ignore
    }
  });

  // ── Ctrl+Alt+G shortcut — GSD dashboard overlay ────────────────────────
  pi.registerShortcut(Key.ctrlAlt("g"), {
    description: shortcutDesc("Open GSD dashboard", "/gsd status"),
    handler: async (ctx) => {
      // Only show if .gsd/ exists
      if (!existsSync(join(process.cwd(), ".gsd"))) {
        ctx.ui.notify("No .gsd/ directory found. Run /gsd to start.", "info");
        return;
      }

      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
          return new GSDDashboardOverlay(tui, theme, () => done());
        },
        {
          overlay: true,
          overlayOptions: {
            width: "90%",
            minWidth: 80,
            maxHeight: "92%",
            anchor: "center",
          },
        },
      );
    },
  });

  // ── before_agent_start: inject GSD contract into true system prompt ─────
  pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
    if (!existsSync(join(process.cwd(), ".gsd"))) return;

    const systemContent = loadPrompt("system");
    const loadedPreferences = loadEffectiveGSDPreferences();
    let preferenceBlock = "";
    if (loadedPreferences) {
      const cwd = process.cwd();
      const report = resolveAllSkillReferences(loadedPreferences.preferences, cwd);
      preferenceBlock = `\n\n${renderPreferencesForSystemPrompt(loadedPreferences.preferences, report.resolutions)}`;

      // Emit warnings for unresolved skill references
      if (report.warnings.length > 0) {
        ctx.ui.notify(
          `GSD skill preferences: ${report.warnings.length} unresolved skill${report.warnings.length === 1 ? "" : "s"}: ${report.warnings.join(", ")}`,
          "warning",
        );
      }
    }

    // Detect skills installed during this auto-mode session
    let newSkillsBlock = "";
    if (hasSkillSnapshot()) {
      const newSkills = detectNewSkills();
      if (newSkills.length > 0) {
        newSkillsBlock = formatSkillsXml(newSkills);
      }
    }

    const injection = await buildGuidedExecuteContextInjection(event.prompt, process.cwd());

    // Worktree context — override the static CWD in the system prompt
    let worktreeBlock = "";
    const worktreeName = getActiveWorktreeName();
    const worktreeMainCwd = getWorktreeOriginalCwd();
    if (worktreeName && worktreeMainCwd) {
      worktreeBlock = [
        "",
        "",
        "[WORKTREE CONTEXT — OVERRIDES CURRENT WORKING DIRECTORY ABOVE]",
        `IMPORTANT: Ignore the "Current working directory" shown earlier in this prompt.`,
        `The actual current working directory is: ${process.cwd()}`,
        "",
        `You are working inside a GSD worktree.`,
        `- Worktree name: ${worktreeName}`,
        `- Worktree path (this is the real cwd): ${process.cwd()}`,
        `- Main project: ${worktreeMainCwd}`,
        `- Branch: worktree/${worktreeName}`,
        "",
        "All file operations, bash commands, and GSD state resolve against the worktree path above.",
        "Use /worktree merge to merge changes back. Use /worktree return to switch back to the main tree.",
      ].join("\n");
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n[SYSTEM CONTEXT — GSD]\n\n${systemContent}${preferenceBlock}${newSkillsBlock}${worktreeBlock}`,
      ...(injection
        ? {
          message: {
            customType: "gsd-guided-context",
            content: injection,
            display: false,
          },
        }
        : {}),
    };
  });

  // ── agent_end: auto-mode advancement or auto-start after discuss ───────────
  pi.on("agent_end", async (event, ctx: ExtensionContext) => {
    // If discuss phase just finished, start auto-mode
    if (checkAutoStartAfterDiscuss()) {
      depthVerificationDone = false;
      return;
    }

    // If auto-mode is already running, advance to next unit
    if (!isAutoActive()) return;

    // If the agent was aborted (user pressed Escape) or hit a provider
    // error (fetch failure, rate limit, etc.), pause auto-mode instead of
    // advancing. This preserves the conversation so the user can inspect
    // what happened, interact with the agent, or resume.
    const lastMsg = event.messages[event.messages.length - 1];
    if (lastMsg && "stopReason" in lastMsg && lastMsg.stopReason === "aborted") {
      await pauseAuto(ctx, pi);
      return;
    }
    if (lastMsg && "stopReason" in lastMsg && lastMsg.stopReason === "error") {
      const errorDetail =
        "errorMessage" in lastMsg && lastMsg.errorMessage
          ? `: ${lastMsg.errorMessage}`
          : "";

      const dash = getAutoDashboardData();
      if (dash.currentUnit) {
        const modelConfig = resolveModelWithFallbacksForUnit(dash.currentUnit.type);
        if (modelConfig && modelConfig.fallbacks.length > 0) {
          const availableModels = ctx.modelRegistry.getAvailable();
          const currentModelId = ctx.model?.id;

          const nextModelId = getNextFallbackModel(currentModelId, modelConfig);

          if (nextModelId) {
            let modelToSet;
            const slashIdx = nextModelId.indexOf("/");
            if (slashIdx !== -1) {
              const provider = nextModelId.substring(0, slashIdx);
              const id = nextModelId.substring(slashIdx + 1);
              modelToSet = availableModels.find(
                m => m.provider.toLowerCase() === provider.toLowerCase()
                  && m.id.toLowerCase() === id.toLowerCase()
              );
            } else {
              const currentProvider = ctx.model?.provider;
              const exactProviderMatch = availableModels.find(
                m => m.id === nextModelId && m.provider === currentProvider
              );
              modelToSet = exactProviderMatch ?? availableModels.find(m => m.id === nextModelId);
            }

            if (modelToSet) {
              const ok = await pi.setModel(modelToSet, { persist: false });
              if (ok) {
                ctx.ui.notify(`Model error${errorDetail}. Switched to fallback: ${nextModelId} and resuming.`, "warning");
                // Trigger a generic "Continue execution" to resume the task since the previous attempt failed
                pi.sendMessage(
                  { customType: "gsd-auto-timeout-recovery", content: "Continue execution.", display: false },
                  { triggerTurn: true }
                );
                return;
              }
            }
          }
        }
      }

      (ctx as any).log(`Auto-mode paused due to provider error${errorDetail}`);
      await pauseAuto(ctx, pi);
      return;
    }

    try {
      await handleAgentEnd(ctx, pi);
    } catch (err) {
      // Safety net: if handleAgentEnd throws despite its internal try-catch,
      // ensure auto-mode stops gracefully instead of silently stalling (#381).
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(
        `Auto-mode error in agent_end handler: ${message}. Stopping auto-mode.`,
        "error",
      );
      try {
        await pauseAuto(ctx, pi);
      } catch {
        // Last resort — at least log
      }
    }
  });

  // ── session_before_compact ────────────────────────────────────────────────
  pi.on("session_before_compact", async (_event, _ctx: ExtensionContext) => {
    // Block compaction during auto-mode — each unit is a fresh session
    // Also block during paused state — context is valuable for the user
    if (isAutoActive() || isAutoPaused()) {
      return { cancel: true };
    }

    const basePath = process.cwd();
    const state = await deriveState(basePath);

    // Only save continue.md if we're actively executing a task
    if (!state.activeMilestone || !state.activeSlice || !state.activeTask) return;
    if (state.phase !== "executing") return;

    const sDir = resolveSlicePath(basePath, state.activeMilestone.id, state.activeSlice.id);
    if (!sDir) return;

    // Check for existing continue file (new naming or legacy)
    const existingFile = resolveSliceFile(basePath, state.activeMilestone.id, state.activeSlice.id, "CONTINUE");
    if (existingFile && await loadFile(existingFile)) return;
    const legacyContinue = join(sDir, "continue.md");
    if (await loadFile(legacyContinue)) return;

    const continuePath = join(sDir, buildSliceFileName(state.activeSlice.id, "CONTINUE"));

    const continueData = {
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
    };

    await saveFile(continuePath, formatContinue(continueData));
  });

  // ── session_shutdown: save activity log on Ctrl+C / SIGTERM ─────────────
  pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
    if (!isAutoActive() && !isAutoPaused()) return;

    // Save the current session — the lock file stays on disk
    // so the next /gsd auto knows it was interrupted
    const dash = getAutoDashboardData();
    if (dash.currentUnit) {
      saveActivityLog(ctx, dash.basePath, dash.currentUnit.type, dash.currentUnit.id);
    }
  });

  // ── tool_call: block CONTEXT.md writes during discussion without depth verification ──
  pi.on("tool_call", async (event) => {
    if (!isToolCallEventType("write", event)) return;
    const result = shouldBlockContextWrite(
      event.toolName,
      event.input.path,
      getDiscussionMilestoneId(),
      isDepthVerified(),
    );
    if (result.block) return result;
  });

  // ── tool_result: persist discussion exchanges & detect depth gate ──────
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "ask_user_questions") return;

    const milestoneId = getDiscussionMilestoneId();
    if (!milestoneId) return;

    const details = event.details as any;
    if (details?.cancelled || !details?.response) return;

    // ── Depth gate detection ──────────────────────────────────────────
    const questions: any[] = (event.input as any)?.questions ?? [];
    for (const q of questions) {
      if (typeof q.id === "string" && q.id.includes("depth_verification")) {
        depthVerificationDone = true;
        break;
      }
    }

    // ── Persist exchange to DISCUSSION.md ──────────────────────────────
    const basePath = process.cwd();
    const milestoneDir = resolveMilestonePath(basePath, milestoneId);
    if (!milestoneDir) return;

    const fileName = buildMilestoneFileName(milestoneId, "DISCUSSION");
    const discussionPath = join(milestoneDir, fileName);
    const timestamp = new Date().toISOString();

    // Format exchange as markdown
    const lines: string[] = [`## Exchange — ${timestamp}`, ""];

    for (const q of questions) {
      lines.push(`### ${q.header ?? "Question"}`);
      lines.push("");
      lines.push(q.question ?? "");
      if (Array.isArray(q.options)) {
        lines.push("");
        for (const opt of q.options) {
          lines.push(`- **${opt.label}** — ${opt.description ?? ""}`);
        }
      }

      // Append user response for this question
      const answer = details.response?.answers?.[q.id];
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

    const newBlock = lines.join("\n");
    const existing = await loadFile(discussionPath) ?? `# ${milestoneId} Discussion Log\n\n`;
    await saveFile(discussionPath, existing + newBlock);
  });
}

async function buildGuidedExecuteContextInjection(prompt: string, basePath: string): Promise<string | null> {
  const executeMatch = prompt.match(/Execute the next task:\s+(T\d+)\s+\("([^"]+)"\)\s+in slice\s+(S\d+)\s+of milestone\s+(M\d+(?:-[a-z0-9]{6})?)/i);
  if (executeMatch) {
    const [, taskId, taskTitle, sliceId, milestoneId] = executeMatch;
    return buildTaskExecutionContextInjection(basePath, milestoneId, sliceId, taskId, taskTitle);
  }

  const resumeMatch = prompt.match(/Resume interrupted work\.[\s\S]*?slice\s+(S\d+)\s+of milestone\s+(M\d+(?:-[a-z0-9]{6})?)/i);
  if (resumeMatch) {
    const [, sliceId, milestoneId] = resumeMatch;
    const state = await deriveState(basePath);
    if (
      state.activeMilestone?.id === milestoneId &&
      state.activeSlice?.id === sliceId &&
      state.activeTask
    ) {
      return buildTaskExecutionContextInjection(
        basePath,
        milestoneId,
        sliceId,
        state.activeTask.id,
        state.activeTask.title,
      );
    }
  }

  return null;
}

async function buildTaskExecutionContextInjection(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
  taskTitle: string,
): Promise<string> {
  const taskPlanPath = resolveTaskFile(basePath, milestoneId, sliceId, taskId, "PLAN");
  const taskPlanRelPath = relTaskFile(basePath, milestoneId, sliceId, taskId, "PLAN");
  const taskPlanContent = taskPlanPath ? await loadFile(taskPlanPath) : null;
  const taskPlanInline = taskPlanContent
    ? [
      "## Inlined Task Plan (authoritative local execution contract)",
      `Source: \`${taskPlanRelPath}\``,
      "",
      taskPlanContent.trim(),
    ].join("\n")
    : [
      "## Inlined Task Plan (authoritative local execution contract)",
      `Task plan not found at dispatch time. Read \`${taskPlanRelPath}\` before executing.`,
    ].join("\n");

  const slicePlanPath = resolveSliceFile(basePath, milestoneId, sliceId, "PLAN");
  const slicePlanRelPath = relSliceFile(basePath, milestoneId, sliceId, "PLAN");
  const slicePlanContent = slicePlanPath ? await loadFile(slicePlanPath) : null;
  const slicePlanExcerpt = extractSliceExecutionExcerpt(slicePlanContent, slicePlanRelPath);

  const priorTaskLines = await buildCarryForwardLines(basePath, milestoneId, sliceId, taskId);
  const resumeSection = await buildResumeSection(basePath, milestoneId, sliceId);

  const activeOverrides = await loadActiveOverrides(basePath);
  const overridesSection = formatOverridesSection(activeOverrides);

  return [
    "[GSD Guided Execute Context]",
    "Use this injected context as startup context for guided task execution. Treat the inlined task plan as the authoritative local execution contract. Use source artifacts to verify details and run checks.",
    "",
    overridesSection,
    "",
    resumeSection,
    "",
    "## Carry-Forward Context",
    ...priorTaskLines,
    "",
    taskPlanInline,
    "",
    slicePlanExcerpt,
    "",
    "## Backing Source Artifacts",
    `- Slice plan: \`${slicePlanRelPath}\``,
    `- Task plan source: \`${taskPlanRelPath}\``,
  ].join("\n");
}

async function buildCarryForwardLines(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
): Promise<string[]> {
  const tDir = resolveTasksDir(basePath, milestoneId, sliceId);
  if (!tDir) return ["- No prior task summaries in this slice."];

  const currentNum = parseInt(taskId.replace(/^T/, ""), 10);
  const sRel = relSlicePath(basePath, milestoneId, sliceId);
  const summaryFiles = resolveTaskFiles(tDir, "SUMMARY")
    .filter((file) => parseInt(file.replace(/^T/, ""), 10) < currentNum)
    .sort();

  if (summaryFiles.length === 0) return ["- No prior task summaries in this slice."];

  const lines = await Promise.all(summaryFiles.map(async (file) => {
    const absPath = join(tDir, file);
    const content = await loadFile(absPath);
    const relPath = `${sRel}/tasks/${file}`;
    if (!content) return `- \`${relPath}\``;

    const summary = parseSummary(content);
    const provided = summary.frontmatter.provides.slice(0, 2).join("; ");
    const decisions = summary.frontmatter.key_decisions.slice(0, 2).join("; ");
    const patterns = summary.frontmatter.patterns_established.slice(0, 2).join("; ");
    const diagnostics = extractMarkdownSection(content, "Diagnostics");

    const parts = [summary.title || relPath];
    if (summary.oneLiner) parts.push(summary.oneLiner);
    if (provided) parts.push(`provides: ${provided}`);
    if (decisions) parts.push(`decisions: ${decisions}`);
    if (patterns) parts.push(`patterns: ${patterns}`);
    if (diagnostics) parts.push(`diagnostics: ${oneLine(diagnostics)}`);

    return `- \`${relPath}\` — ${parts.join(" | ")}`;
  }));

  return lines;
}

async function buildResumeSection(basePath: string, milestoneId: string, sliceId: string): Promise<string> {
  const continueFile = resolveSliceFile(basePath, milestoneId, sliceId, "CONTINUE");
  const legacyDir = resolveSlicePath(basePath, milestoneId, sliceId);
  const legacyPath = legacyDir ? join(legacyDir, "continue.md") : null;
  const continueContent = continueFile ? await loadFile(continueFile) : null;
  const legacyContent = !continueContent && legacyPath ? await loadFile(legacyPath) : null;
  const resolvedContent = continueContent ?? legacyContent;
  const resolvedRelPath = continueContent
    ? relSliceFile(basePath, milestoneId, sliceId, "CONTINUE")
    : (legacyPath ? `${relSlicePath(basePath, milestoneId, sliceId)}/continue.md` : null);

  if (!resolvedContent || !resolvedRelPath) {
    return ["## Resume State", "- No continue file present. Start from the top of the task plan."].join("\n");
  }

  const cont = parseContinue(resolvedContent);
  const lines = [
    "## Resume State",
    `Source: \`${resolvedRelPath}\``,
    `- Status: ${cont.frontmatter.status || "in_progress"}`,
  ];

  if (cont.frontmatter.step && cont.frontmatter.totalSteps) {
    lines.push(`- Progress: step ${cont.frontmatter.step} of ${cont.frontmatter.totalSteps}`);
  }
  if (cont.completedWork) lines.push(`- Completed: ${oneLine(cont.completedWork)}`);
  if (cont.remainingWork) lines.push(`- Remaining: ${oneLine(cont.remainingWork)}`);
  if (cont.decisions) lines.push(`- Decisions: ${oneLine(cont.decisions)}`);
  if (cont.nextAction) lines.push(`- Next action: ${oneLine(cont.nextAction)}`);

  return lines.join("\n");
}

function extractSliceExecutionExcerpt(content: string | null, relPath: string): string {
  if (!content) {
    return [
      "## Slice Plan Excerpt",
      `Slice plan not found at dispatch time. Read \`${relPath}\` before running slice-level verification.`,
    ].join("\n");
  }

  const lines = content.split("\n");
  const goalLine = lines.find((line) => line.startsWith("**Goal:**"))?.trim();
  const demoLine = lines.find((line) => line.startsWith("**Demo:**"))?.trim();
  const verification = extractMarkdownSection(content, "Verification");
  const observability = extractMarkdownSection(content, "Observability / Diagnostics");

  const parts = ["## Slice Plan Excerpt", `Source: \`${relPath}\``];
  if (goalLine) parts.push(goalLine);
  if (demoLine) parts.push(demoLine);
  if (verification) parts.push("", "### Slice Verification", verification.trim());
  if (observability) parts.push("", "### Slice Observability / Diagnostics", observability.trim());
  return parts.join("\n");
}

function extractMarkdownSection(content: string, heading: string): string | null {
  const match = new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, "m").exec(content);
  if (!match) return null;
  const start = match.index + match[0].length;
  const rest = content.slice(start);
  const nextHeading = rest.match(/^##\s+/m);
  const end = nextHeading?.index ?? rest.length;
  return rest.slice(0, end).trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
