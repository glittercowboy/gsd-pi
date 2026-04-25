import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext } from "@gsd/pi-coding-agent";

import { logWarning } from "../workflow-logger.js";
import { debugTime } from "../debug-logger.js";
import { loadPrompt, getTemplatesDir } from "../prompt-loader.js";
import { readForensicsMarker } from "../forensics.js";
import { resolveAllSkillReferences, renderPreferencesForSystemPrompt, loadEffectiveGSDPreferences } from "../preferences.js";
import { resolveModelWithFallbacksForUnit } from "../preferences-models.js";
import { resolveSkillReference } from "../preferences-skills.js";
import { resolveGsdRootFile, resolveSliceFile, resolveSlicePath, resolveTaskFile, resolveTaskFiles, resolveTasksDir, relSliceFile, relSlicePath, relTaskFile } from "../paths.js";
import { ensureCodebaseMapFresh, readCodebaseMap } from "../codebase-generator.js";
import { hasSkillSnapshot, detectNewSkills, formatSkillsXml } from "../skill-discovery.js";
import { getActiveAutoWorktreeContext } from "../auto-worktree.js";
import { getActiveWorktreeName, getWorktreeOriginalCwd } from "../worktree-command.js";
import { deriveState } from "../state.js";
import { formatOverridesSection, formatShortcut, loadActiveOverrides, loadFile, parseContinue, parseSummary } from "../files.js";
import { toPosixPath } from "../../shared/mod.js";
import { autoEnableCmuxPreferences } from "../commands-cmux.js";

const gsdHome = process.env.GSD_HOME || join(homedir(), ".gsd");

/**
 * Bundled skill triggers — resolved dynamically at runtime instead of
 * hardcoding absolute paths in the system prompt template. Only skills
 * that actually exist on disk are included in the table. (#3575)
 */
export const BUNDLED_SKILL_TRIGGERS: Array<{ trigger: string; skill: string }> = [
  { trigger: "Frontend UI - web components, pages, landing pages, dashboards, React/HTML/CSS, styling", skill: "frontend-design" },
  { trigger: "macOS or iOS apps - SwiftUI, Xcode, App Store", skill: "swiftui" },
  { trigger: "Debugging - complex bugs, failing tests, root-cause investigation after standard approaches fail", skill: "debug-like-expert" },
  { trigger: "Code review - security, performance, bugs, quality review of staged/unstaged diffs or PRs", skill: "review" },
  { trigger: "Test generation or execution - auto-detect framework, generate tests, run suite, analyze failures", skill: "test" },
  { trigger: "Linting/formatting - run the detected linter/formatter with auto-fix, report remaining issues", skill: "lint" },
  { trigger: "Polishing UI details - animations, hover states, typography, borders, micro-interactions, optical alignment", skill: "make-interfaces-feel-better" },
  { trigger: "Accessibility audit - WCAG, screen reader, keyboard navigation, a11y review", skill: "accessibility" },
  { trigger: "Planning interviews - stress-test a plan, grill the user, resolve decision trees one branch at a time", skill: "grill-me" },
  { trigger: "Interface design - produce 3+ radically different designs for a module/API, compare in prose, synthesize", skill: "design-an-interface" },
  { trigger: "TDD - red-green-refactor vertical slices, never refactor while red, tests survive refactors", skill: "tdd" },
  { trigger: "Draft a milestone brief (M###-CONTEXT.md) or PRD from current conversation context", skill: "write-milestone-brief" },
  { trigger: "Break a plan into vertical-slice roadmap slices (M###-ROADMAP.md) or GitHub issues with dependency ordering", skill: "decompose-into-slices" },
  { trigger: "Package spike findings into a reusable project-local skill at .claude/skills/", skill: "spike-wrap-up" },
  { trigger: "Block completion claims until verification evidence has been produced in this message", skill: "verify-before-complete" },
  { trigger: "Create a Model Context Protocol (MCP) server — tool design, error handling, Inspector testing, evals", skill: "create-mcp-server" },
  { trigger: "Write documentation, proposals, specs, RFCs, or READMEs for a fresh reader", skill: "write-docs" },
  { trigger: "Post-mortem a failed GSD auto-mode run using .gsd/activity, .gsd/journal, and .gsd/metrics.json", skill: "forensics" },
  { trigger: "Prepare a clean cross-session handoff — continue.md + summary updates (pause/resume work)", skill: "handoff" },
  { trigger: "Security review with STRIDE threat modeling and exploit-scenario reporting", skill: "security-review" },
  { trigger: "HTTP/REST/GraphQL API design — verbs, status codes, pagination, errors, idempotency, versioning", skill: "api-design" },
  { trigger: "Dependency upgrades — risk-batched, verified between batches, one major per commit", skill: "dependency-upgrade" },
  { trigger: "Agent-first observability — structured logs, persisted failure state, health surfaces, explicit failure modes", skill: "observability" },
];

function buildBundledSkillsTable(): string {
  const cwd = process.cwd();
  const rows: string[] = [];
  for (const { trigger, skill } of BUNDLED_SKILL_TRIGGERS) {
    const resolution = resolveSkillReference(skill, cwd);
    if (resolution.method === "unresolved") continue; // skill not installed — omit from prompt
    rows.push(`| ${trigger} | \`${resolution.resolvedPath}\` |`);
  }
  if (rows.length === 0) {
    return "*No bundled skills found. Install skills to `~/.agents/skills/` or `~/.claude/skills/`.*";
  }
  return `| Trigger | Skill to load |\n|---|---|\n${rows.join("\n")}`;
}

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
  const systemContent = loadPrompt("system", {
    bundledSkillsTable: buildBundledSkillsTable(),
    templatesDir: getTemplatesDir(),
    shortcutDashboard: formatShortcut("Ctrl+Alt+G"),
    shortcutShell: formatShortcut("Ctrl+Alt+B"),
  });
  let loadedPreferences = loadEffectiveGSDPreferences();
  try {
    const { markCmuxPromptShown, shouldPromptToEnableCmux } = await import("../../cmux/index.js");
    if (shouldPromptToEnableCmux(loadedPreferences?.preferences)) {
      markCmuxPromptShown();
      if (autoEnableCmuxPreferences()) {
        loadedPreferences = loadEffectiveGSDPreferences();
        ctx.ui.notify(
          "cmux detected — auto-enabled. Run /gsd cmux off to disable.",
          "info",
        );
      }
    }
  } catch (e) {
    logWarning("bootstrap", `cmux prompt setup skipped: ${(e as Error).message}`);
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

  // ADR-013 step 5: opportunistic decisions->memories backfill. Idempotent
  // and best-effort — first run absorbs the existing decisions table into
  // the memory store; subsequent runs are a single sentinel SELECT.
  try {
    const { backfillDecisionsToMemories } = await import("../memory-backfill.js");
    const written = backfillDecisionsToMemories();
    if (written > 0) {
      ctx.ui.notify(`GSD: backfilled ${written} decision${written === 1 ? "" : "s"} into the memory store (ADR-013).`, "info");
    }
  } catch (e) {
    logWarning("bootstrap", `decisions backfill failed: ${(e as Error).message}`);
  }

  const memoryBlock = await loadMemoryBlock(event.prompt ?? "");

  let newSkillsBlock = "";
  if (hasSkillSnapshot()) {
    const newSkills = detectNewSkills();
    if (newSkills.length > 0) {
      newSkillsBlock = formatSkillsXml(newSkills);
    }
  }

  let codebaseBlock = "";
  try {
    const codebaseOptions = loadedPreferences?.preferences?.codebase
      ? {
          excludePatterns: loadedPreferences.preferences.codebase.exclude_patterns,
          maxFiles: loadedPreferences.preferences.codebase.max_files,
          collapseThreshold: loadedPreferences.preferences.codebase.collapse_threshold,
        }
      : undefined;
    ensureCodebaseMapFresh(process.cwd(), codebaseOptions);
  } catch (e) {
    logWarning("bootstrap", `CODEBASE refresh failed: ${(e as Error).message}`);
  }

  const codebasePath = resolveGsdRootFile(process.cwd(), "CODEBASE");
  const rawCodebase = readCodebaseMap(process.cwd());
  if (existsSync(codebasePath) && rawCodebase) {
    try {
      const rawContent = rawCodebase.trim();
      if (rawContent) {
        // Cap injection size to ~2 000 tokens to avoid bloating every request.
        // Full map is always available at .gsd/CODEBASE.md.
        const MAX_CODEBASE_CHARS = 8_000;
        const generatedMatch = rawContent.match(/Generated: (\S+)/);
        const generatedAt = generatedMatch?.[1] ?? "unknown";
        const content = rawContent.length > MAX_CODEBASE_CHARS
          ? rawContent.slice(0, MAX_CODEBASE_CHARS) + "\n\n*(truncated — see .gsd/CODEBASE.md for full map)*"
          : rawContent;
        codebaseBlock = `\n\n[PROJECT CODEBASE — File structure and descriptions (generated ${generatedAt}, auto-refreshed when GSD detects tracked file changes; use /gsd codebase stats for status)]\n\n${content}`;
      }
    } catch (e) {
      logWarning("bootstrap", `CODEBASE file read failed: ${(e as Error).message}`);
    }
  }

  warnDeprecatedAgentInstructions();

  const injection = await buildGuidedExecuteContextInjection(event.prompt, process.cwd());

  // Re-inject forensics context on follow-up turns (#2941)
  const forensicsInjection = !injection ? buildForensicsContextInjection(process.cwd(), event.prompt) : null;

  const worktreeBlock = buildWorktreeContextBlock();

  const subagentModelConfig = resolveModelWithFallbacksForUnit("subagent");
  const subagentModelBlock = subagentModelConfig
    ? `\n\n## Subagent Model\n\nWhen spawning subagents via the \`subagent\` tool, always pass \`model: "${subagentModelConfig.primary}"\` in the tool call parameters. Never omit this — always specify it explicitly.`
    : "";

  const fullSystem = `${event.systemPrompt}\n\n[SYSTEM CONTEXT — GSD]\n\n${systemContent}${preferenceBlock}${knowledgeBlock}${codebaseBlock}${memoryBlock}${newSkillsBlock}${worktreeBlock}${subagentModelBlock}`;

  stopContextTimer({
    systemPromptSize: fullSystem.length,
    injectionSize: injection?.length ?? forensicsInjection?.length ?? 0,
    hasPreferences: preferenceBlock.length > 0,
    hasNewSkills: newSkillsBlock.length > 0,
  });

  // Determine which context message to inject (guided execute takes priority)
  const contextMessage = injection
    ? { customType: "gsd-guided-context", content: injection, display: false as const }
    : forensicsInjection
      ? { customType: "gsd-forensics", content: forensicsInjection, display: false as const }
      : null;

  return {
    systemPrompt: fullSystem,
    ...(contextMessage ? { message: contextMessage } : {}),
  };
}

/**
 * ADR-013 step 4 — auto-injection parity for the memories table.
 *
 * Mirrors loadKnowledgeBlock by producing a labeled, deterministic block
 * combining two memory sets:
 *
 * 1. Always-on "critical" set — top-ranked active memories in categories
 *    that future GSD turns generally want without asking. After ADR-013
 *    expands this to include "architecture", these memories serve as the
 *    auto-injected replacement for inlineDecisionsFromDb when the cutover
 *    in step 6 lands.
 * 2. Prompt-relevance set — FTS5/semantic hits against the current user
 *    prompt, deduplicated against the critical set.
 *
 * Both sets are ranked, merged, and rendered via formatMemoriesForPrompt
 * with a token-budget cap. Failures degrade gracefully — the function never
 * throws and returns "" so the system prompt construction continues.
 */
export async function loadMemoryBlock(userPrompt: string): Promise<string> {
  try {
    const { formatMemoriesForPrompt, getActiveMemoriesRanked, queryMemoriesRanked } = await import("../memory-store.js");

    // Categories that belong in every turn. Pre-ADR-013 this was just
    // {gotcha, environment, convention}. ADR-013 adds "architecture" so
    // decision-equivalent memories survive the inlineDecisionsFromDb cutover
    // in step 6.
    const CRITICAL_CATEGORIES = new Set(["gotcha", "environment", "convention", "architecture"]);
    const CRITICAL_CAP = 8;
    const QUERY_K = 10;
    // ~1 token ≈ 4 chars. 4000 chars ≈ 1000 tokens — comfortably under the
    // KNOWLEDGE.md 4KB warning threshold and roughly twice the pre-ADR-013
    // budget so the absorbed DECISIONS surface fits.
    const CHAR_BUDGET = 4000;

    const allRanked = getActiveMemoriesRanked(80);
    const critical = allRanked.filter((m) => CRITICAL_CATEGORIES.has(m.category)).slice(0, CRITICAL_CAP);
    const criticalIds = new Set(critical.map((m) => m.id));

    let relevant: typeof allRanked = [];
    const trimmed = userPrompt.trim();
    if (trimmed) {
      const hits = queryMemoriesRanked({ query: trimmed, k: QUERY_K });
      relevant = hits.map((h) => h.memory).filter((m) => !criticalIds.has(m.id));
    }

    const merged = [...critical, ...relevant];
    if (merged.length === 0) return "";

    const formatted = formatMemoriesForPrompt(merged, CHAR_BUDGET);
    if (!formatted) return "";

    return `\n\n[MEMORY — Critical and prompt-relevant memories from the GSD memory store]\n\n${formatted}`;
  } catch (e) {
    logWarning("bootstrap", `memory block fetch failed: ${(e as Error).message}`);
    return "";
  }
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
    } catch (e) {
      logWarning("bootstrap", `global knowledge file read failed: ${(e as Error).message}`);
    }
  }

  // 2. Project knowledge (.gsd/KNOWLEDGE.md) — project-specific
  let projectKnowledge = "";
  const knowledgePath = resolveGsdRootFile(cwd, "KNOWLEDGE");
  if (existsSync(knowledgePath)) {
    try {
      const content = readFileSync(knowledgePath, "utf-8").trim();
      if (content) projectKnowledge = content;
    } catch (e) {
      logWarning("bootstrap", `project knowledge file read failed: ${(e as Error).message}`);
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

/**
 * Low-entropy resume intent patterns — short phrases a user types to
 * continue work after a pause, rate limit, or context reset (#3615).
 * Tested against the trimmed, lowercased prompt with trailing punctuation stripped.
 */
const RESUME_INTENT_PATTERNS = /^(continue|resume|ok|go|go ahead|proceed|keep going|carry on|next|yes|yeah|yep|sure|do it|let's go|pick up where you left off)$/;

async function buildGuidedExecuteContextInjection(prompt: string, basePath: string): Promise<string | null> {
  const ensureStateDbOpen = async () => {
    const { ensureDbOpen } = await import("./dynamic-tools.js");
    await ensureDbOpen();
  };

  const executeMatch = prompt.match(/Execute the next task:\s+(T\d+)\s+\("([^"]+)"\)\s+in slice\s+(S\d+)\s+of milestone\s+(M\d+(?:-[a-z0-9]{6})?)/i);
  if (executeMatch) {
    const [, taskId, taskTitle, sliceId, milestoneId] = executeMatch;
    return buildTaskExecutionContextInjection(basePath, milestoneId, sliceId, taskId, taskTitle);
  }

  const resumeMatch = prompt.match(/Resume interrupted work\.[\s\S]*?slice\s+(S\d+)\s+of milestone\s+(M\d+(?:-[a-z0-9]{6})?)/i);
  if (resumeMatch) {
    const [, sliceId, milestoneId] = resumeMatch;
    await ensureStateDbOpen();
    const state = await deriveState(basePath);
    if (state.activeMilestone?.id === milestoneId && state.activeSlice?.id === sliceId && state.activeTask) {
      return buildTaskExecutionContextInjection(basePath, milestoneId, sliceId, state.activeTask.id, state.activeTask.title);
    }
  }

  // Fallback: low-entropy resume prompt (e.g., "continue", "ok", "go ahead")
  // during an active executing task — inject task context so the agent
  // doesn't rebuild from scratch (#3615).
  // Intent-gated: only fire for short, resume-like prompts to avoid hijacking
  // control/help/diagnostic prompts with unrelated execution context.
  // Phase-gated: only fire during "executing" to avoid misrouting during
  // replanning, gate evaluation, or other non-execution phases.
  const trimmed = prompt.trim().toLowerCase().replace(/[.!?,]+$/g, "");
  if (RESUME_INTENT_PATTERNS.test(trimmed)) {
    await ensureStateDbOpen();
    const state = await deriveState(basePath);
    if (state.phase === "executing" && state.activeTask && state.activeMilestone && state.activeSlice) {
      return buildTaskExecutionContextInjection(
        basePath,
        state.activeMilestone.id,
        state.activeSlice.id,
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

// ─── Forensics Context Re-injection (#2941) ──────────────────────────────────

/**
 * Check for an active forensics session and return the prompt content
 * so it can be re-injected on follow-up turns.
 */
export function buildForensicsContextInjection(basePath: string, prompt: string): string | null {
  const marker = readForensicsMarker(basePath);
  if (!marker) return null;

  // Expire markers older than 2 hours to avoid stale context
  const age = Date.now() - new Date(marker.createdAt).getTime();
  if (age > 2 * 60 * 60 * 1000) {
    clearForensicsMarker(basePath);
    return null;
  }

  const trimmed = prompt.trim().toLowerCase().replace(/[.!?,]+$/g, "");
  if (trimmed && !RESUME_INTENT_PATTERNS.test(trimmed)) {
    clearForensicsMarker(basePath);
    return null;
  }

  return marker.promptContent;
}

/**
 * Remove the active forensics marker file, e.g. when the investigation
 * is complete or the session expires.
 */
export function clearForensicsMarker(basePath: string): void {
  const markerPath = join(basePath, ".gsd", "runtime", "active-forensics.json");
  if (existsSync(markerPath)) {
    try {
      unlinkSync(markerPath);
    } catch (e) {
      logWarning("bootstrap", `unlinkSync forensics marker failed: ${(e as Error).message}`);
    }
  }
}
