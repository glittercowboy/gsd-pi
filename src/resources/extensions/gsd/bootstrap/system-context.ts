import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext } from "@gsd/pi-coding-agent";

import { debugTime, debugLog } from "../debug-logger.js";
import { loadPrompt } from "../prompt-loader.js";
import { resolveAllSkillReferences, renderPreferencesForSystemPrompt, loadEffectiveGSDPreferences } from "../preferences.js";
import { section, optimizeForCaching, type PromptSection } from "../prompt-cache-optimizer.js";
import { resolveGsdRootFile, resolveSliceFile, resolveSlicePath, resolveTaskFile, resolveTaskFiles, resolveTasksDir, relSliceFile, relSlicePath, relTaskFile } from "../paths.js";
import { hasSkillSnapshot, detectNewSkills, formatSkillsXml } from "../skill-discovery.js";
import { getActiveAutoWorktreeContext } from "../auto-worktree.js";
import { getActiveWorktreeName, getWorktreeOriginalCwd } from "../worktree-command.js";
import { deriveState } from "../state.js";
import { formatOverridesSection, loadActiveOverrides, loadFile, parseContinue, parseSummary } from "../files.js";
import { toPosixPath } from "../../shared/mod.js";
import { markCmuxPromptShown, shouldPromptToEnableCmux } from "../../cmux/index.js";

const gsdHome = process.env.GSD_HOME || join(homedir(), ".gsd");

function warnDeprecatedAgentInstructions(): void {
  const paths = [
    join(gsdHome, "agent-instructions.md"),
    join(process.cwd(), ".gsd", "agent-instructions.md"),
  ];
  for (const path of paths) {
    if (existsSync(path)) {
      console.warn(
        `[GSD] DEPRECATED: ${path} is no longer loaded. ` +
        `Migrate your instructions to AGENTS.md (or CLAUDE.md) in the same directory. ` +
        `See https://github.com/gsd-build/GSD-2/issues/1492`,
      );
    }
  }
}

export async function buildBeforeAgentStartResult(
  event: { prompt: string; systemPrompt: string },
  ctx: ExtensionContext,
): Promise<{ systemPrompt: string; message?: { customType: string; content: string; display: false } } | undefined> {
  if (!existsSync(join(process.cwd(), ".gsd"))) return undefined;

  const stopContextTimer = debugTime("context-inject");
  const systemContent = loadPrompt("system");
  const loadedPreferences = loadEffectiveGSDPreferences();
  if (shouldPromptToEnableCmux(loadedPreferences?.preferences)) {
    markCmuxPromptShown();
    ctx.ui.notify(
      "cmux detected. Run /gsd cmux on to enable sidebar metadata, notifications, and visual subagent splits for this project.",
      "info",
    );
  }

  let preferenceBlock = "";
  if (loadedPreferences) {
    const cwd = process.cwd();
    const report = resolveAllSkillReferences(loadedPreferences.preferences, cwd);
    preferenceBlock = `\n\n${renderPreferencesForSystemPrompt(loadedPreferences.preferences, report.resolutions)}`;
    if (report.warnings.length > 0) {
      ctx.ui.notify(
        `GSD skill preferences: ${report.warnings.length} unresolved skill${report.warnings.length === 1 ? "" : "s"}: ${report.warnings.join(", ")}`,
        "warning",
      );
    }
  }

  const { block: knowledgeBlock, globalSizeKb } = loadKnowledgeBlock(gsdHome, process.cwd());
  if (globalSizeKb > 4) {
    ctx.ui.notify(
      `GSD: ~/.gsd/agent/KNOWLEDGE.md is ${globalSizeKb.toFixed(1)}KB — consider trimming to keep system prompt lean.`,
      "warning",
    );
  }

  let memoryBlock = "";
  try {
    const { formatMemoriesForPrompt, getActiveMemoriesRanked } = await import("../memory-store.js");
    const memories = getActiveMemoriesRanked(30);
    if (memories.length > 0) {
      const formatted = formatMemoriesForPrompt(memories, 2000);
      if (formatted) {
        memoryBlock = `\n\n${formatted}`;
      }
    }
  } catch {
    // non-fatal
  }

  let newSkillsBlock = "";
  if (hasSkillSnapshot()) {
    const newSkills = detectNewSkills();
    if (newSkills.length > 0) {
      newSkillsBlock = formatSkillsXml(newSkills);
    }
  }

  warnDeprecatedAgentInstructions();

  const injection = await buildGuidedExecuteContextInjection(event.prompt, process.cwd());
  const worktreeBlock = buildWorktreeContextBlock();

  // Assemble system prompt sections with cache-aware ordering.
  // Static content first (cached by providers), dynamic content last.
  const sections: PromptSection[] = [
    section("system-prompt", event.systemPrompt, "static"),
    section("base-instructions", `[SYSTEM CONTEXT — GSD]\n\n${systemContent}`, "static"),
  ];
  if (preferenceBlock) sections.push(section("preferences", preferenceBlock, "semi-static"));
  if (knowledgeBlock) sections.push(section("knowledge", knowledgeBlock, "semi-static"));
  if (memoryBlock) sections.push(section("memories", memoryBlock, "dynamic"));
  if (newSkillsBlock) sections.push(section("new-skills", newSkillsBlock, "dynamic"));
  if (worktreeBlock) sections.push(section("worktree-context", worktreeBlock, "dynamic"));

  const optimized = optimizeForCaching(sections);
  const fullSystem = optimized.prompt;

  debugLog("prompt-cache-stats", {
    cacheEfficiency: `${(optimized.cacheEfficiency * 100).toFixed(1)}%`,
    cacheablePrefixChars: optimized.cacheablePrefixChars,
    totalChars: optimized.totalChars,
    sections: optimized.sectionCounts,
  });

  stopContextTimer({
    systemPromptSize: fullSystem.length,
    injectionSize: injection?.length ?? 0,
    hasPreferences: preferenceBlock.length > 0,
    hasNewSkills: newSkillsBlock.length > 0,
  });

  return {
    systemPrompt: fullSystem,
    ...(injection
      ? {
        message: {
          customType: "gsd-guided-context",
          content: injection,
          display: false as const,
        },
      }
      : {}),
  };
}

export function loadKnowledgeBlock(gsdHomeDir: string, cwd: string): { block: string; globalSizeKb: number } {
  // 1. Global knowledge (~/.gsd/agent/KNOWLEDGE.md) — cross-project, user-maintained
  let globalKnowledge = "";
  let globalSizeKb = 0;
  const globalKnowledgePath = join(gsdHomeDir, "agent", "KNOWLEDGE.md");
  if (existsSync(globalKnowledgePath)) {
    try {
      const content = readFileSync(globalKnowledgePath, "utf-8").trim();
      if (content) {
        globalSizeKb = Buffer.byteLength(content, "utf-8") / 1024;
        globalKnowledge = content;
      }
    } catch {
      // skip
    }
  }

  // 2. Project knowledge (.gsd/KNOWLEDGE.md) — project-specific
  let projectKnowledge = "";
  const knowledgePath = resolveGsdRootFile(cwd, "KNOWLEDGE");
  if (existsSync(knowledgePath)) {
    try {
      const content = readFileSync(knowledgePath, "utf-8").trim();
      if (content) projectKnowledge = content;
    } catch {
      // skip
    }
  }

  if (!globalKnowledge && !projectKnowledge) {
    return { block: "", globalSizeKb: 0 };
  }

  const parts: string[] = [];
  if (globalKnowledge) parts.push(`## Global Knowledge\n\n${globalKnowledge}`);
  if (projectKnowledge) parts.push(`## Project Knowledge\n\n${projectKnowledge}`);
  return {
    block: `\n\n[KNOWLEDGE — Rules, patterns, and lessons learned]\n\n${parts.join("\n\n")}`,
    globalSizeKb,
  };
}

function buildWorktreeContextBlock(): string {
  const worktreeName = getActiveWorktreeName();
  const worktreeMainCwd = getWorktreeOriginalCwd();
  const autoWorktree = getActiveAutoWorktreeContext();

  if (worktreeName && worktreeMainCwd) {
    return [
      "",
      "",
      "[WORKTREE CONTEXT — OVERRIDES CURRENT WORKING DIRECTORY ABOVE]",
      `IMPORTANT: Ignore the "Current working directory" shown earlier in this prompt.`,
      `The actual current working directory is: ${toPosixPath(process.cwd())}`,
      "",
      `You are working inside a GSD worktree.`,
      `- Worktree name: ${worktreeName}`,
      `- Worktree path (this is the real cwd): ${toPosixPath(process.cwd())}`,
      `- Main project: ${toPosixPath(worktreeMainCwd)}`,
      `- Branch: worktree/${worktreeName}`,
      "",
      "All file operations, bash commands, and GSD state resolve against the worktree path above.",
      "Use /worktree merge to merge changes back. Use /worktree return to switch back to the main tree.",
    ].join("\n");
  }

  if (autoWorktree) {
    return [
      "",
      "",
      "[WORKTREE CONTEXT — OVERRIDES CURRENT WORKING DIRECTORY ABOVE]",
      `IMPORTANT: Ignore the "Current working directory" shown earlier in this prompt.`,
      `The actual current working directory is: ${toPosixPath(process.cwd())}`,
      "",
      "You are working inside a GSD auto-worktree.",
      `- Milestone worktree: ${autoWorktree.worktreeName}`,
      `- Worktree path (this is the real cwd): ${toPosixPath(process.cwd())}`,
      `- Main project: ${toPosixPath(autoWorktree.originalBase)}`,
      `- Branch: ${autoWorktree.branch}`,
      "",
      "All file operations, bash commands, and GSD state resolve against the worktree path above.",
      "Write every .gsd artifact in the worktree path above, never in the main project tree.",
    ].join("\n");
  }

  return "";
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
    if (state.activeMilestone?.id === milestoneId && state.activeSlice?.id === sliceId && state.activeTask) {
      return buildTaskExecutionContextInjection(basePath, milestoneId, sliceId, state.activeTask.id, state.activeTask.title);
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
    ? ["## Inlined Task Plan (authoritative local execution contract)", `Source: \`${taskPlanRelPath}\``, "", taskPlanContent.trim()].join("\n")
    : ["## Inlined Task Plan (authoritative local execution contract)", `Task plan not found at dispatch time. Read \`${taskPlanRelPath}\` before executing.`].join("\n");

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
    overridesSection, "",
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
  const tasksDir = resolveTasksDir(basePath, milestoneId, sliceId);
  if (!tasksDir) return ["- No prior task summaries in this slice."];

  const currentNum = parseInt(taskId.replace(/^T/, ""), 10);
  const sliceRel = relSlicePath(basePath, milestoneId, sliceId);
  const summaryFiles = resolveTaskFiles(tasksDir, "SUMMARY")
    .filter((file) => parseInt(file.replace(/^T/, ""), 10) < currentNum)
    .sort();

  if (summaryFiles.length === 0) return ["- No prior task summaries in this slice."];

  return Promise.all(summaryFiles.map(async (file) => {
    const absPath = join(tasksDir, file);
    const content = await loadFile(absPath);
    const relPath = `${sliceRel}/tasks/${file}`;
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
    return ["## Slice Plan Excerpt", `Slice plan not found at dispatch time. Read \`${relPath}\` before running slice-level verification.`].join("\n");
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

