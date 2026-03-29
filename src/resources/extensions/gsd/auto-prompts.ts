/**
 * Auto-mode Prompt Builders — construct dispatch prompts for each unit type.
 *
 * Pure async functions that load templates and inline file content. No module-level
 * state, no globals — every dependency is passed as a parameter or imported as a
 * utility.
 */

import { loadFile, parseContinue, parseSummary, loadActiveOverrides, formatOverridesSection, parseTaskPlanFile } from "./files.js";
import type { Override, UatType } from "./files.js";
import { hasVerdict, getUatType } from "./verdict-parser.js";
import { loadPrompt, inlineTemplate } from "./prompt-loader.js";
import {
  resolveMilestoneFile, resolveSliceFile, resolveSlicePath,
  resolveTasksDir, resolveTaskFiles, resolveTaskFile,
  relMilestoneFile, relSliceFile, relSlicePath, relMilestonePath,
  resolveGsdRootFile, relGsdRootFile, resolveRuntimeFile,
} from "./paths.js";
import { resolveSkillDiscoveryMode, resolveInlineLevel, loadEffectiveGSDPreferences, resolveAllSkillReferences } from "./preferences.js";
import { parseRoadmap } from "./parsers-legacy.js";
import type { GSDState, InlineLevel } from "./types.js";
import type { GSDPreferences } from "./preferences.js";
import { getLoadedSkills, type Skill } from "@gsd/pi-coding-agent";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import { computeBudgets, resolveExecutorContextWindow, truncateAtSectionBoundary } from "./context-budget.js";
import { getPendingGates } from "./gsd-db.js";
import { formatDecisionsCompact, formatRequirementsCompact } from "./structured-data-formatter.js";

// ─── Preamble Cap ─────────────────────────────────────────────────────────────

const MAX_PREAMBLE_CHARS = 30_000;

function capPreamble(preamble: string): string {
  if (preamble.length <= MAX_PREAMBLE_CHARS) return preamble;
  return truncateAtSectionBoundary(preamble, MAX_PREAMBLE_CHARS).content;
}

// ─── Executor Constraints ─────────────────────────────────────────────────────

/**
 * Format executor context constraints for injection into the plan-slice prompt.
 * Uses the budget engine to compute task count ranges and inline context budgets
 * based on the configured executor model's context window.
 */
function formatExecutorConstraints(): string {
  let windowTokens: number;
  try {
    const prefs = loadEffectiveGSDPreferences();
    windowTokens = resolveExecutorContextWindow(undefined, prefs?.preferences);
  } catch {
    windowTokens = 200_000; // safe default
  }
  const budgets = computeBudgets(windowTokens);
  const { min, max } = budgets.taskCountRange;
  const execWindowK = Math.round(windowTokens / 1000);
  const perTaskBudgetK = Math.round(budgets.inlineContextBudgetChars / 1000);
  return [
    `## Executor Context Constraints`,
    ``,
    `The agent that executes each task has a **${execWindowK}K token** context window.`,
    `- Recommended task count for this slice: **${min}–${max} tasks**`,
    `- Each task gets ~${perTaskBudgetK}K chars of inline context (plans, code, decisions)`,
    `- Keep individual tasks completable within a single context window — if a task needs more context than fits, split it`,
  ].join("\n");
}

function buildSourceFilePaths(
  base: string,
  mid: string,
  sid?: string,
): string {
  const paths: string[] = [];

  const projectPath = resolveGsdRootFile(base, "PROJECT");
  if (existsSync(projectPath)) {
    paths.push(`- **Project**: \`${relGsdRootFile("PROJECT")}\``);
  }

  const requirementsPath = resolveGsdRootFile(base, "REQUIREMENTS");
  if (existsSync(requirementsPath)) {
    paths.push(`- **Requirements**: \`${relGsdRootFile("REQUIREMENTS")}\``);
  }

  const decisionsPath = resolveGsdRootFile(base, "DECISIONS");
  if (existsSync(decisionsPath)) {
    paths.push(`- **Decisions**: \`${relGsdRootFile("DECISIONS")}\``);
  }

  const queuePath = resolveGsdRootFile(base, "QUEUE");
  if (existsSync(queuePath)) {
    paths.push(`- **Queue**: \`${relGsdRootFile("QUEUE")}\``);
  }

  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  if (contextPath) {
    paths.push(`- **Milestone Context**: \`${relMilestoneFile(base, mid, "CONTEXT")}\``);
  }

  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  if (roadmapPath) {
    paths.push(`- **Roadmap**: \`${relMilestoneFile(base, mid, "ROADMAP")}\``);
  }

  if (sid) {
    const researchPath = resolveSliceFile(base, mid, sid, "RESEARCH");
    if (researchPath) {
      paths.push(`- **Slice Research**: \`${relSliceFile(base, mid, sid, "RESEARCH")}\``);
    }
  } else {
    const researchPath = resolveMilestoneFile(base, mid, "RESEARCH");
    if (researchPath) {
      paths.push(`- **Milestone Research**: \`${relMilestoneFile(base, mid, "RESEARCH")}\``);
    }
  }

  return paths.length > 0
    ? paths.join("\n")
    : "- Use `rg --files` and targeted reads to identify the relevant source files before planning.";
}

// ─── Inline Helpers ───────────────────────────────────────────────────────

/**
 * Load a file and format it for inlining into a prompt.
 * Returns the content wrapped with a source path header, or a fallback
 * message if the file doesn't exist. This eliminates tool calls — the LLM
 * gets the content directly instead of "Read this file:".
 */
export async function inlineFile(
  absPath: string | null, relPath: string, label: string,
): Promise<string> {
  const content = absPath ? await loadFile(absPath) : null;
  if (!content) {
    return `### ${label}\nSource: \`${relPath}\`\n\n_(not found — file does not exist yet)_`;
  }
  return `### ${label}\nSource: \`${relPath}\`\n\n${content.trim()}`;
}

/**
 * Load a file for inlining, returning null if it doesn't exist.
 * Use when the file is optional and should be omitted entirely if absent.
 */
export async function inlineFileOptional(
  absPath: string | null, relPath: string, label: string,
): Promise<string | null> {
  const content = absPath ? await loadFile(absPath) : null;
  if (!content) return null;
  return `### ${label}\nSource: \`${relPath}\`\n\n${content.trim()}`;
}

/**
 * Smart file inlining — for large files, use semantic chunking to include
 * only the most relevant portions based on the task context.
 * Falls back to full content for small files or when no query is provided.
 *
 * @param absPath Absolute file path
 * @param relPath Relative display path
 * @param label Section label
 * @param query Task description for relevance scoring (optional)
 * @param threshold Character threshold for chunking (default: 3000)
 */
export async function inlineFileSmart(
  absPath: string | null, relPath: string, label: string,
  query?: string, threshold = 3000,
): Promise<string> {
  const content = absPath ? await loadFile(absPath) : null;
  if (!content) {
    return `### ${label}\nSource: \`${relPath}\`\n\n_(not found — file does not exist yet)_`;
  }

  // For small files or no query, include full content
  if (content.length <= threshold || !query) {
    return `### ${label}\nSource: \`${relPath}\`\n\n${content.trim()}`;
  }

  // For large files, truncate at section boundary
  const truncated = truncateAtSectionBoundary(content, threshold).content;
  return `### ${label}\nSource: \`${relPath}\`\n\n${truncated}`;
}

/**
 * Load and inline dependency slice summaries (full content, not just paths).
 */
export async function inlineDependencySummaries(
  mid: string, sid: string, base: string, budgetChars?: number,
): Promise<string> {
  // DB primary path — get slice depends directly
  let depends: string[] | null = null;
  try {
    const { isDbAvailable, getSlice } = await import("./gsd-db.js");
    if (isDbAvailable()) {
      const slice = getSlice(mid, sid);
      if (slice) {
        if (slice.depends.length === 0) return "- (no dependencies)";
        depends = slice.depends as string[];
      }
      // If slice not found in DB, fall through to file-based parsing
    }
  } catch { /* fall through */ }

  // If DB didn't provide depends, fall back to roadmap parsing
  if (!depends) {
    const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
    if (roadmapPath) {
      const roadmapContent = await loadFile(roadmapPath);
      if (roadmapContent) {
        const parsed = parseRoadmap(roadmapContent);
        const slice = parsed.slices.find(s => s.id === sid);
        if (slice && slice.depends.length > 0) {
          depends = slice.depends;
        }
      }
    }
    if (!depends) {
      return "- (no dependencies)";
    }
  }

  const sections: string[] = [];
  const seen = new Set<string>();
  for (const dep of depends) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    const summaryFile = resolveSliceFile(base, mid, dep, "SUMMARY");
    const summaryContent = summaryFile ? await loadFile(summaryFile) : null;
    const relPath = relSliceFile(base, mid, dep, "SUMMARY");
    if (summaryContent) {
      sections.push(`#### ${dep} Summary\nSource: \`${relPath}\`\n\n${summaryContent.trim()}`);
    } else {
      sections.push(`- \`${relPath}\` _(not found)_`);
    }
  }

  const result = sections.join("\n\n");
  if (budgetChars !== undefined && result.length > budgetChars) {
    return truncateAtSectionBoundary(result, budgetChars).content;
  }
  return result;
}

/**
 * Load a well-known .gsd/ root file for optional inlining.
 * Handles the existsSync check internally.
 */
export async function inlineGsdRootFile(
  base: string, filename: string, label: string,
): Promise<string | null> {
  const key = filename.replace(/\.md$/i, "").toUpperCase() as "PROJECT" | "DECISIONS" | "QUEUE" | "STATE" | "REQUIREMENTS" | "KNOWLEDGE";
  const absPath = resolveGsdRootFile(base, key);
  if (!existsSync(absPath)) return null;
  return inlineFileOptional(absPath, relGsdRootFile(key), label);
}

// ─── DB-Aware Inline Helpers ──────────────────────────────────────────────

/**
 * Inline decisions with optional milestone scoping from the DB.
 * Falls back to filesystem via inlineGsdRootFile when DB unavailable or empty.
 */
export async function inlineDecisionsFromDb(
  base: string, milestoneId?: string, scope?: string, level?: InlineLevel,
): Promise<string | null> {
  const inlineLevel = level ?? resolveInlineLevel();
  try {
    const { isDbAvailable } = await import("./gsd-db.js");
    if (isDbAvailable()) {
      const { queryDecisions, formatDecisionsForPrompt } = await import("./context-store.js");
      const decisions = queryDecisions({ milestoneId, scope });
      if (decisions.length > 0) {
        // Use compact format for non-full levels to save ~35% tokens
        const formatted = inlineLevel !== "full"
          ? formatDecisionsCompact(decisions)
          : formatDecisionsForPrompt(decisions);
        return `### Decisions\nSource: \`.gsd/DECISIONS.md\`\n\n${formatted}`;
      }
    }
  } catch {
    // DB not available — fall through to filesystem
  }
  return inlineGsdRootFile(base, "decisions.md", "Decisions");
}

/**
 * Inline requirements with optional slice scoping from the DB.
 * Falls back to filesystem via inlineGsdRootFile when DB unavailable or empty.
 */
export async function inlineRequirementsFromDb(
  base: string, sliceId?: string, level?: InlineLevel,
): Promise<string | null> {
  const inlineLevel = level ?? resolveInlineLevel();
  try {
    const { isDbAvailable } = await import("./gsd-db.js");
    if (isDbAvailable()) {
      const { queryRequirements, formatRequirementsForPrompt } = await import("./context-store.js");
      const requirements = queryRequirements({ sliceId });
      if (requirements.length > 0) {
        // Use compact format for non-full levels to save ~40% tokens
        const formatted = inlineLevel !== "full"
          ? formatRequirementsCompact(requirements)
          : formatRequirementsForPrompt(requirements);
        return `### Requirements\nSource: \`.gsd/REQUIREMENTS.md\`\n\n${formatted}`;
      }
    }
  } catch {
    // DB not available — fall through to filesystem
  }
  return inlineGsdRootFile(base, "requirements.md", "Requirements");
}

/**
 * Inline project context from the DB.
 * Falls back to filesystem via inlineGsdRootFile when DB unavailable or empty.
 */
export async function inlineProjectFromDb(
  base: string,
): Promise<string | null> {
  try {
    const { isDbAvailable } = await import("./gsd-db.js");
    if (isDbAvailable()) {
      const { queryProject } = await import("./context-store.js");
      const content = queryProject();
      if (content) {
        return `### Project\nSource: \`.gsd/PROJECT.md\`\n\n${content}`;
      }
    }
  } catch {
    // DB not available — fall through to filesystem
  }
  return inlineGsdRootFile(base, "project.md", "Project");
}

// ─── Skill Activation & Discovery ─────────────────────────────────────────

function normalizeSkillReference(ref: string): string {
  const normalized = ref.replace(/\\/g, "/").trim();
  const base = basename(normalized).replace(/\.md$/i, "");
  const name = /^SKILL$/i.test(base)
    ? basename(normalized.replace(/\/SKILL(?:\.md)?$/i, ""))
    : base;
  return name.trim().toLowerCase();
}

function tokenizeSkillContext(...parts: Array<string | null | undefined>): Set<string> {
  const tokens = new Set<string>();
  const addVariants = (raw: string) => {
    const value = raw.trim().toLowerCase();
    if (!value || value.length < 2) return;
    tokens.add(value);
    tokens.add(value.replace(/[-_]+/g, " "));
    tokens.add(value.replace(/\s+/g, "-"));
    tokens.add(value.replace(/\s+/g, ""));
  };

  for (const part of parts) {
    if (!part) continue;
    const text = part.toLowerCase();
    const phraseMatches = text.match(/[a-z0-9][a-z0-9+.#/_-]{1,}/g) ?? [];
    for (const match of phraseMatches) {
      addVariants(match);
      for (const piece of match.split(/[^a-z0-9+.#]+/g)) {
        if (piece.length >= 3) addVariants(piece);
      }
    }
  }

  return tokens;
}

function skillMatchesContext(skill: Skill, contextTokens: Set<string>): boolean {
  const haystacks = [
    skill.name.toLowerCase(),
    skill.name.toLowerCase().replace(/[-_]+/g, " "),
    skill.description.toLowerCase(),
  ];

  return [...contextTokens].some(token =>
    token.length >= 3 && haystacks.some(haystack => haystack.includes(token)),
  );
}

function resolvePreferenceSkillNames(refs: string[], base: string): string[] {
  if (refs.length === 0) return [];
  const prefs: GSDPreferences = { always_use_skills: refs };
  const report = resolveAllSkillReferences(prefs, base);
  return refs.map(ref => {
    const resolution = report.resolutions.get(ref);
    return normalizeSkillReference(resolution?.resolvedPath ?? ref);
  }).filter(Boolean);
}

function ruleMatchesContext(when: string, contextTokens: Set<string>): boolean {
  const whenTokens = tokenizeSkillContext(when);
  return [...whenTokens].some(token =>
    contextTokens.has(token) || [...contextTokens].some(ctx => ctx.includes(token) || token.includes(ctx)),
  );
}

function resolveSkillRuleMatches(
  prefs: GSDPreferences | undefined,
  contextTokens: Set<string>,
  base: string,
): { include: string[]; avoid: string[] } {
  if (!prefs?.skill_rules?.length) return { include: [], avoid: [] };

  const include: string[] = [];
  const avoid: string[] = [];
  for (const rule of prefs.skill_rules) {
    if (!ruleMatchesContext(rule.when, contextTokens)) continue;
    include.push(...resolvePreferenceSkillNames([...(rule.use ?? []), ...(rule.prefer ?? [])], base));
    avoid.push(...resolvePreferenceSkillNames(rule.avoid ?? [], base));
  }
  return { include, avoid };
}

function resolvePreferredSkillNames(
  prefs: GSDPreferences | undefined,
  visibleSkills: Skill[],
  contextTokens: Set<string>,
  base: string,
): string[] {
  if (!prefs?.prefer_skills?.length) return [];
  const preferred = new Set(resolvePreferenceSkillNames(prefs.prefer_skills, base));
  return visibleSkills
    .filter(skill => preferred.has(normalizeSkillReference(skill.name)) && skillMatchesContext(skill, contextTokens))
    .map(skill => normalizeSkillReference(skill.name));
}

/** Skill names must be lowercase alphanumeric with hyphens — reject anything else
 *  to prevent prompt injection via crafted directory names. */
const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

function formatSkillActivationBlock(skillNames: string[]): string {
  const safe = skillNames.filter(name => SAFE_SKILL_NAME.test(name));
  if (safe.length === 0) return "";
  // Use explicit parameter syntax so LLMs pass { skill: "..." } instead of { name: "..." }.
  // The function-call-like syntax `Skill('name')` led LLMs to infer a positional
  // parameter name, causing tool validation failures — see #2224.
  const calls = safe.map(name => `Call Skill({ skill: '${name}' })`).join('. ');
  return `<skill_activation>${calls}.</skill_activation>`;
}

export function buildSkillActivationBlock(params: {
  base: string;
  milestoneId: string;
  milestoneTitle?: string;
  sliceId?: string;
  sliceTitle?: string;
  taskId?: string;
  taskTitle?: string;
  extraContext?: string[];
  taskPlanContent?: string | null;
  preferences?: GSDPreferences;
}): string {
  const prefs = params.preferences ?? loadEffectiveGSDPreferences()?.preferences;
  const contextTokens = tokenizeSkillContext(
    params.milestoneId,
    params.milestoneTitle,
    params.sliceId,
    params.sliceTitle,
    params.taskId,
    params.taskTitle,
  );

  const visibleSkills = (typeof getLoadedSkills === 'function' ? getLoadedSkills() : []).filter(skill => !skill.disableModelInvocation);
  const installedNames = new Set(visibleSkills.map(skill => normalizeSkillReference(skill.name)));
  const avoided = new Set(resolvePreferenceSkillNames(prefs?.avoid_skills ?? [], params.base));
  const matched = new Set<string>();

  for (const name of resolvePreferenceSkillNames(prefs?.always_use_skills ?? [], params.base)) {
    matched.add(name);
  }

  const ruleMatches = resolveSkillRuleMatches(prefs, contextTokens, params.base);
  for (const name of ruleMatches.include) matched.add(name);
  for (const name of ruleMatches.avoid) avoided.add(name);

  for (const name of resolvePreferredSkillNames(prefs, visibleSkills, contextTokens, params.base)) {
    matched.add(name);
  }

  if (params.taskPlanContent) {
    try {
      const taskPlan = parseTaskPlanFile(params.taskPlanContent);
      for (const skillName of taskPlan.frontmatter.skills_used) {
        matched.add(normalizeSkillReference(skillName));
      }
    } catch {
      // Non-fatal — malformed task plan should not break prompt construction
    }
  }

  const ordered = [...matched]
    .filter(name => installedNames.has(name) && !avoided.has(name))
    .sort();
  return formatSkillActivationBlock(ordered);
}

/**
 * Build the skill discovery template variables for research prompts.
 * Returns { skillDiscoveryMode, skillDiscoveryInstructions } for template substitution.
 */
export function buildSkillDiscoveryVars(): { skillDiscoveryMode: string; skillDiscoveryInstructions: string } {
  const mode = resolveSkillDiscoveryMode();

  if (mode === "off") {
    return {
      skillDiscoveryMode: "off",
      skillDiscoveryInstructions: " Skill discovery is disabled. Skip this step.",
    };
  }

  const autoInstall = mode === "auto";
  const instructions = `
   Identify the key technologies, frameworks, and services this work depends on (e.g. Stripe, Clerk, Supabase, JUCE, SwiftUI).
   For each, check if a professional agent skill already exists:
   - First check \`<available_skills>\` in your system prompt — a skill may already be installed.
   - For technologies without an installed skill, run: \`npx skills find "<technology>"\`
   - Only consider skills that are **directly relevant** to core technologies — not tangentially related.
   - Evaluate results by install count and relevance to the actual work.${autoInstall
    ? `
   - Install relevant skills: \`npx skills add <owner/repo@skill> -g -y\`
   - Record installed skills in the "Skills Discovered" section of your research output.
   - Installed skills will automatically appear in subsequent units' system prompts — no manual steps needed.`
    : `
   - Note promising skills in your research output with their install commands, but do NOT install them.
   - The user will decide which to install.`
  }`;

  return {
    skillDiscoveryMode: mode,
    skillDiscoveryInstructions: instructions,
  };
}

// ─── Text Helpers ──────────────────────────────────────────────────────────

export function extractMarkdownSection(content: string, heading: string): string | null {
  const match = new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, "m").exec(content);
  if (!match) return null;

  const start = match.index + match[0].length;
  const rest = content.slice(start);
  const nextHeading = rest.match(/^##\s+/m);
  const end = nextHeading?.index ?? rest.length;
  return rest.slice(0, end).trim();
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// ─── Section Builders ──────────────────────────────────────────────────────

export function buildResumeSection(
  continueContent: string | null,
  legacyContinueContent: string | null,
  continueRelPath: string,
  legacyContinueRelPath: string | null,
): string {
  const resolvedContent = continueContent ?? legacyContinueContent;
  const resolvedRelPath = continueContent ? continueRelPath : legacyContinueRelPath;

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

export async function buildCarryForwardSection(priorSummaryPaths: string[], base: string): Promise<string> {
  if (priorSummaryPaths.length === 0) {
    return ["## Carry-Forward Context", "- No prior task summaries in this slice."].join("\n");
  }

  const items = await Promise.all(priorSummaryPaths.map(async (relPath) => {
    const absPath = join(base, relPath);
    const content = await loadFile(absPath);
    if (!content) return `- \`${relPath}\``;

    const summary = parseSummary(content);
    const provided = summary.frontmatter.provides.slice(0, 2).join("; ");
    const decisions = summary.frontmatter.key_decisions.slice(0, 2).join("; ");
    const patterns = summary.frontmatter.patterns_established.slice(0, 2).join("; ");
    const keyFiles = summary.frontmatter.key_files.slice(0, 3).join("; ");
    const diagnostics = extractMarkdownSection(content, "Diagnostics");

    const parts = [summary.title || relPath];
    if (summary.oneLiner) parts.push(summary.oneLiner);
    if (provided) parts.push(`provides: ${provided}`);
    if (decisions) parts.push(`decisions: ${decisions}`);
    if (patterns) parts.push(`patterns: ${patterns}`);
    if (keyFiles) parts.push(`key_files: ${keyFiles}`);
    if (diagnostics) parts.push(`diagnostics: ${oneLine(diagnostics)}`);

    return `- \`${relPath}\` — ${parts.join(" | ")}`;
  }));

  return ["## Carry-Forward Context", ...items].join("\n");
}

export function extractSliceExecutionExcerpt(content: string | null, relPath: string): string {
  if (!content) {
    return [
      "## Slice Plan Excerpt",
      `Slice plan not found at dispatch time. Read \`${relPath}\` before running slice-level verification.`,
    ].join("\n");
  }

  const lines = content.split("\n");
  const goalLine = lines.find(l => l.startsWith("**Goal:**"))?.trim();
  const demoLine = lines.find(l => l.startsWith("**Demo:**"))?.trim();

  const verification = extractMarkdownSection(content, "Verification");
  const observability = extractMarkdownSection(content, "Observability / Diagnostics");

  const parts = ["## Slice Plan Excerpt", `Source: \`${relPath}\``];
  if (goalLine) parts.push(goalLine);
  if (demoLine) parts.push(demoLine);
  if (verification) {
    parts.push("", "### Slice Verification", verification.trim());
  }
  if (observability) {
    parts.push("", "### Slice Observability / Diagnostics", observability.trim());
  }

  return parts.join("\n");
}

// ─── Prior Task Summaries ──────────────────────────────────────────────────

export async function getPriorTaskSummaryPaths(
  mid: string, sid: string, currentTid: string, base: string,
): Promise<string[]> {
  const tDir = resolveTasksDir(base, mid, sid);
  if (!tDir) return [];

  const summaryFiles = resolveTaskFiles(tDir, "SUMMARY");
  const currentNum = parseInt(currentTid.replace(/^T/, ""), 10);
  const sRel = relSlicePath(base, mid, sid);

  return summaryFiles
    .filter(f => {
      const num = parseInt(f.replace(/^T/, ""), 10);
      return num < currentNum;
    })
    .map(f => `${sRel}/tasks/${f}`);
}

/**
 * Get carry-forward summary paths scoped to a task's derived dependencies.
 *
 * Instead of all prior tasks (order-based), returns only summaries for task
 * IDs in `dependsOn`. Used by reactive-execute to give each subagent only
 * the context it actually needs — not sibling tasks from a parallel batch.
 *
 * Falls back to order-based when dependsOn is empty (root tasks still get
 * any available prior summaries for continuity).
 */
export async function getDependencyTaskSummaryPaths(
  mid: string, sid: string, currentTid: string,
  dependsOn: string[], base: string,
): Promise<string[]> {
  // If no dependencies, fall back to order-based for root tasks
  if (dependsOn.length === 0) {
    return getPriorTaskSummaryPaths(mid, sid, currentTid, base);
  }

  const tDir = resolveTasksDir(base, mid, sid);
  if (!tDir) return [];

  const summaryFiles = resolveTaskFiles(tDir, "SUMMARY");
  const sRel = relSlicePath(base, mid, sid);
  const depSet = new Set(dependsOn.map((d) => d.toUpperCase()));

  return summaryFiles
    .filter((f) => {
      // Extract task ID from filename: "T02-SUMMARY.md" → "T02"
      const tid = f.replace(/-SUMMARY\.md$/i, "").toUpperCase();
      return depSet.has(tid);
    })
    .map((f) => `${sRel}/tasks/${f}`);
}

// ─── Adaptive Replanning Checks ────────────────────────────────────────────

/**
 * Check if the most recently completed slice needs reassessment.
 * Returns { sliceId } if reassessment is needed, null otherwise.
 *
 * Skips reassessment when:
 * - No roadmap exists yet
 * - No slices are completed
 * - The last completed slice already has an assessment file
 * - All slices are complete (milestone done — no point reassessing)
 */
export async function checkNeedsReassessment(
  base: string, mid: string, state: GSDState,
): Promise<{ sliceId: string } | null> {
  // DB primary path — fall through to file-based when DB has no data for this milestone
  try {
    const { isDbAvailable, getMilestoneSlices } = await import("./gsd-db.js");
    if (isDbAvailable()) {
      const slices = getMilestoneSlices(mid);
      if (slices.length > 0) {
        const completedSliceIds = slices.filter(s => s.status === "complete").map(s => s.id);
        const hasIncomplete = slices.some(s => s.status !== "complete");
        if (completedSliceIds.length === 0 || !hasIncomplete) return null;
        const lastCompleted = completedSliceIds[completedSliceIds.length - 1];
        const assessmentFile = resolveSliceFile(base, mid, lastCompleted, "ASSESSMENT");
        const hasAssessment = !!(assessmentFile && await loadFile(assessmentFile));
        if (hasAssessment) return null;
        const summaryFile = resolveSliceFile(base, mid, lastCompleted, "SUMMARY");
        const hasSummary = !!(summaryFile && await loadFile(summaryFile));
        if (!hasSummary) return null;
        return { sliceId: lastCompleted };
      }
    }
  } catch { /* fall through */ }

  // File-based fallback using roadmap checkboxes
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  if (!roadmapPath) return null;
  const roadmapContent = await loadFile(roadmapPath);
  if (!roadmapContent) return null;
  const parsed = parseRoadmap(roadmapContent);
  const fileCompletedIds = parsed.slices.filter(s => s.done).map(s => s.id);
  const fileHasIncomplete = parsed.slices.some(s => !s.done);
  if (fileCompletedIds.length === 0 || !fileHasIncomplete) return null;
  const lastDone = fileCompletedIds[fileCompletedIds.length - 1];
  const assessFile = resolveSliceFile(base, mid, lastDone, "ASSESSMENT");
  const hasAssess = !!(assessFile && await loadFile(assessFile));
  if (hasAssess) return null;
  const summFile = resolveSliceFile(base, mid, lastDone, "SUMMARY");
  const hasSumm = !!(summFile && await loadFile(summFile));
  if (!hasSumm) return null;
  return { sliceId: lastDone };
}

/**
 * Check if the most recently completed slice needs a UAT run.
 * Returns { sliceId, uatType } if UAT should be dispatched, null otherwise.
 *
 * Skips when:
 * - No roadmap or no completed slices
 * - All slices are done (milestone complete path — reassessment handles it)
 * - uat_dispatch preference is not enabled
 * - No UAT file exists for the slice
 * - UAT result file already exists (idempotent — already ran)
 */
export async function checkNeedsRunUat(
  base: string, mid: string, state: GSDState, prefs: GSDPreferences | undefined,
): Promise<{ sliceId: string; uatType: UatType } | null> {
  // DB primary path — fall through to file-based when DB has no data for this milestone
  try {
    const { isDbAvailable, getMilestoneSlices } = await import("./gsd-db.js");
    if (isDbAvailable()) {
      const slices = getMilestoneSlices(mid);
      if (slices.length > 0) {
        const completedSlices = slices.filter(s => s.status === "complete");
        const incompleteSlices = slices.filter(s => s.status !== "complete");
        if (completedSlices.length === 0) return null;
        if (incompleteSlices.length === 0) return null;
        if (!prefs?.uat_dispatch) return null;
        const lastCompleted = completedSlices[completedSlices.length - 1];
        const sid = lastCompleted.id;
        const uatFile = resolveSliceFile(base, mid, sid, "UAT");
        if (!uatFile) return null;
        const uatContent = await loadFile(uatFile);
        if (!uatContent) return null;
        // If the UAT file already contains a verdict, UAT has been run — skip
        if (hasVerdict(uatContent)) return null;
        // Also check the ASSESSMENT file — the run-uat prompt writes the verdict
        // there (via gsd_summary_save artifact_type:"ASSESSMENT"), not into the
        // UAT spec file. Without this check the unit re-dispatches indefinitely.
        const assessmentFile = resolveSliceFile(base, mid, sid, "ASSESSMENT");
        if (assessmentFile) {
          const assessmentContent = await loadFile(assessmentFile);
          if (assessmentContent && hasVerdict(assessmentContent)) return null;
        }
        const uatType = getUatType(uatContent);
        return { sliceId: sid, uatType };
      }
    }
  } catch { /* fall through */ }

  // File-based fallback using roadmap checkboxes
  if (!prefs?.uat_dispatch) return null;
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  if (!roadmapPath) return null;
  const roadmapContent = await loadFile(roadmapPath);
  if (!roadmapContent) return null;
  const parsed = parseRoadmap(roadmapContent);
  const completedFileSlices = parsed.slices.filter(s => s.done);
  const incompleteFileSlices = parsed.slices.filter(s => !s.done);
  if (completedFileSlices.length === 0 || incompleteFileSlices.length === 0) return null;
  const lastCompletedFile = completedFileSlices[completedFileSlices.length - 1];
  const uatSid = lastCompletedFile.id;
  const uatFileFb = resolveSliceFile(base, mid, uatSid, "UAT");
  if (!uatFileFb) return null;
  const uatContentFb = await loadFile(uatFileFb);
  if (!uatContentFb) return null;
  // If the UAT file already contains a verdict, UAT has been run — skip
  if (hasVerdict(uatContentFb)) return null;
  // Also check the ASSESSMENT file for the file-based fallback path (same
  // reason as the DB path above — verdict lives in ASSESSMENT, not UAT).
  const assessmentFileFb = resolveSliceFile(base, mid, uatSid, "ASSESSMENT");
  if (assessmentFileFb) {
    const assessmentContentFb = await loadFile(assessmentFileFb);
    if (assessmentContentFb && hasVerdict(assessmentContentFb)) return null;
  }
  const uatTypeFb = getUatType(uatContentFb);
  return { sliceId: uatSid, uatType: uatTypeFb };
}

// ─── Prompt Builders ──────────────────────────────────────────────────────

/**
 * Build a prompt for the discuss-milestone unit type.
 * Loads the guided-discuss-milestone template and inlines the CONTEXT-DRAFT
 * as a seed when present. The discussion agent interviews the user, writes
 * a full CONTEXT.md, and the phase transitions to pre-planning automatically.
 */
export async function buildDiscussMilestonePrompt(mid: string, midTitle: string, base: string): Promise<string> {
  const discussTemplates = inlineTemplate("context", "Context");

  const basePrompt = loadPrompt("guided-discuss-milestone", {
    milestoneId: mid,
    milestoneTitle: midTitle,
    inlinedTemplates: discussTemplates,
    structuredQuestionsAvailable: "true",
    commitInstruction: "Do not commit planning artifacts — .gsd/ is managed externally.",
  });

  // If a CONTEXT-DRAFT.md exists, append it as seed material
  const draftPath = resolveMilestoneFile(base, mid, "CONTEXT-DRAFT");
  const draftContent = draftPath ? await loadFile(draftPath) : null;

  if (draftContent) {
    return `${basePrompt}\n\n## Prior Discussion (Draft Seed)\n\nThe following draft was captured from a prior multi-milestone discussion. Use it as seed material — the user has already provided this context. Start with a brief reflection on what the draft covers, then probe for any gaps or open questions before writing the full CONTEXT.md.\n\n${draftContent}`;
  }

  return basePrompt;
}

export async function buildResearchMilestonePrompt(mid: string, midTitle: string, base: string): Promise<string> {
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");

  const inlined: string[] = [];
  inlined.push(await inlineFile(contextPath, contextRel, "Milestone Context"));
  const projectInline = await inlineProjectFromDb(base);
  if (projectInline) inlined.push(projectInline);
  const requirementsInline = await inlineRequirementsFromDb(base);
  if (requirementsInline) inlined.push(requirementsInline);
  const decisionsInline = await inlineDecisionsFromDb(base, mid);
  if (decisionsInline) inlined.push(decisionsInline);
  const knowledgeInlineRM = await inlineGsdRootFile(base, "knowledge.md", "Project Knowledge");
  if (knowledgeInlineRM) inlined.push(knowledgeInlineRM);
  inlined.push(inlineTemplate("research", "Research"));

  const inlinedContext = capPreamble(`## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`);

  const outputRelPath = relMilestoneFile(base, mid, "RESEARCH");
  return loadPrompt("research-milestone", {
    workingDirectory: base,
    milestoneId: mid, milestoneTitle: midTitle,
    milestonePath: relMilestonePath(base, mid),
    contextPath: contextRel,
    outputPath: join(base, outputRelPath),
    inlinedContext,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      milestoneTitle: midTitle,
      extraContext: [inlinedContext],
    }),
    ...buildSkillDiscoveryVars(),
  });
}

export async function buildPlanMilestonePrompt(mid: string, midTitle: string, base: string, level?: InlineLevel): Promise<string> {
  const inlineLevel = level ?? resolveInlineLevel();
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");
  const researchPath = resolveMilestoneFile(base, mid, "RESEARCH");
  const researchRel = relMilestoneFile(base, mid, "RESEARCH");

  const inlined: string[] = [];
  inlined.push(await inlineFile(contextPath, contextRel, "Milestone Context"));
  const researchInline = await inlineFileOptional(researchPath, researchRel, "Milestone Research");
  if (researchInline) inlined.push(researchInline);
  const { inlinePriorMilestoneSummary } = await import("./files.js");
  const priorSummaryInline = await inlinePriorMilestoneSummary(mid, base);
  if (priorSummaryInline) inlined.push(priorSummaryInline);
  if (inlineLevel !== "minimal") {
    const projectInline = await inlineProjectFromDb(base);
    if (projectInline) inlined.push(projectInline);
    const requirementsInline = await inlineRequirementsFromDb(base, undefined, inlineLevel);
    if (requirementsInline) inlined.push(requirementsInline);
    const decisionsInline = await inlineDecisionsFromDb(base, mid, undefined, inlineLevel);
    if (decisionsInline) inlined.push(decisionsInline);
  }
  const queuePath = resolveGsdRootFile(base, "QUEUE");
  if (existsSync(queuePath)) {
    const queueInline = await inlineFileSmart(
      queuePath,
      relGsdRootFile("QUEUE"),
      "Project Queue",
      `${mid} ${midTitle}`,
    );
    inlined.push(queueInline);
  }
  const knowledgeInlinePM = await inlineGsdRootFile(base, "knowledge.md", "Project Knowledge");
  if (knowledgeInlinePM) inlined.push(knowledgeInlinePM);
  inlined.push(inlineTemplate("roadmap", "Roadmap"));
  if (inlineLevel === "full") {
    inlined.push(inlineTemplate("decisions", "Decisions"));
    inlined.push(inlineTemplate("plan", "Slice Plan"));
    inlined.push(inlineTemplate("task-plan", "Task Plan"));
    inlined.push(inlineTemplate("secrets-manifest", "Secrets Manifest"));
  } else if (inlineLevel === "standard") {
    inlined.push(inlineTemplate("decisions", "Decisions"));
    inlined.push(inlineTemplate("plan", "Slice Plan"));
    inlined.push(inlineTemplate("task-plan", "Task Plan"));
  }

  const inlinedContext = capPreamble(`## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`);

  const outputRelPath = relMilestoneFile(base, mid, "ROADMAP");
  const researchOutputPath = join(base, relMilestoneFile(base, mid, "RESEARCH"));
  const secretsOutputPath = join(base, relMilestoneFile(base, mid, "SECRETS"));
  return loadPrompt("plan-milestone", {
    workingDirectory: base,
    milestoneId: mid, milestoneTitle: midTitle,
    milestonePath: relMilestonePath(base, mid),
    contextPath: contextRel,
    researchPath: researchRel,
    researchOutputPath,
    outputPath: join(base, outputRelPath),
    secretsOutputPath,
    inlinedContext,
    sourceFilePaths: buildSourceFilePaths(base, mid),
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      milestoneTitle: midTitle,
      extraContext: [inlinedContext],
    }),
    ...buildSkillDiscoveryVars(),
  });
}

export async function buildResearchSlicePrompt(
  mid: string, _midTitle: string, sid: string, sTitle: string, base: string,
): Promise<string> {
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");
  const milestoneResearchPath = resolveMilestoneFile(base, mid, "RESEARCH");
  const milestoneResearchRel = relMilestoneFile(base, mid, "RESEARCH");

  const inlined: string[] = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));
  const contextInline = await inlineFileOptional(contextPath, contextRel, "Milestone Context");
  if (contextInline) inlined.push(contextInline);
  const researchInline = await inlineFileOptional(milestoneResearchPath, milestoneResearchRel, "Milestone Research");
  if (researchInline) inlined.push(researchInline);
  const decisionsInline = await inlineDecisionsFromDb(base, mid);
  if (decisionsInline) inlined.push(decisionsInline);
  const requirementsInline = await inlineRequirementsFromDb(base, sid);
  if (requirementsInline) inlined.push(requirementsInline);
  const knowledgeInlineRS = await inlineGsdRootFile(base, "knowledge.md", "Project Knowledge");
  if (knowledgeInlineRS) inlined.push(knowledgeInlineRS);
  inlined.push(inlineTemplate("research", "Research"));

  const depContent = await inlineDependencySummaries(mid, sid, base);
  const activeOverrides = await loadActiveOverrides(base);
  const overridesInline = formatOverridesSection(activeOverrides);
  if (overridesInline) inlined.unshift(overridesInline);

  const inlinedContext = capPreamble(`## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`);

  const outputRelPath = relSliceFile(base, mid, sid, "RESEARCH");
  return loadPrompt("research-slice", {
    workingDirectory: base,
    milestoneId: mid, sliceId: sid, sliceTitle: sTitle,
    slicePath: relSlicePath(base, mid, sid),
    roadmapPath: roadmapRel,
    contextPath: contextRel,
    milestoneResearchPath: milestoneResearchRel,
    outputPath: join(base, outputRelPath),
    inlinedContext,
    dependencySummaries: depContent,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      sliceId: sid,
      sliceTitle: sTitle,
      extraContext: [inlinedContext, depContent],
    }),
    ...buildSkillDiscoveryVars(),
  });
}

export async function buildPlanSlicePrompt(
  mid: string, _midTitle: string, sid: string, sTitle: string, base: string, level?: InlineLevel,
): Promise<string> {
  const inlineLevel = level ?? resolveInlineLevel();
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const researchPath = resolveSliceFile(base, mid, sid, "RESEARCH");
  const researchRel = relSliceFile(base, mid, sid, "RESEARCH");

  const inlined: string[] = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));
  const researchInline = await inlineFileOptional(researchPath, researchRel, "Slice Research");
  if (researchInline) inlined.push(researchInline);
  if (inlineLevel !== "minimal") {
    const decisionsInline = await inlineDecisionsFromDb(base, mid, undefined, inlineLevel);
    if (decisionsInline) inlined.push(decisionsInline);
    const requirementsInline = await inlineRequirementsFromDb(base, sid, inlineLevel);
    if (requirementsInline) inlined.push(requirementsInline);
  }
  const knowledgeInlinePS = await inlineGsdRootFile(base, "knowledge.md", "Project Knowledge");
  if (knowledgeInlinePS) inlined.push(knowledgeInlinePS);
  inlined.push(inlineTemplate("plan", "Slice Plan"));
  if (inlineLevel === "full") {
    inlined.push(inlineTemplate("task-plan", "Task Plan"));
  }

  const depContent = await inlineDependencySummaries(mid, sid, base);
  const planActiveOverrides = await loadActiveOverrides(base);
  const planOverridesInline = formatOverridesSection(planActiveOverrides);
  if (planOverridesInline) inlined.unshift(planOverridesInline);

  const inlinedContext = capPreamble(`## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`);

  // Build executor context constraints from the budget engine
  const executorContextConstraints = formatExecutorConstraints();

  const outputRelPath = relSliceFile(base, mid, sid, "PLAN");
  const commitInstruction = "Do not commit — .gsd/ planning docs are managed externally and not tracked in git.";
  return loadPrompt("plan-slice", {
    workingDirectory: base,
    milestoneId: mid, sliceId: sid, sliceTitle: sTitle,
    slicePath: relSlicePath(base, mid, sid),
    roadmapPath: roadmapRel,
    researchPath: researchRel,
    outputPath: join(base, outputRelPath),
    inlinedContext,
    dependencySummaries: depContent,
    sourceFilePaths: buildSourceFilePaths(base, mid, sid),
    executorContextConstraints,
    commitInstruction,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      sliceId: sid,
      sliceTitle: sTitle,
      extraContext: [inlinedContext, depContent],
    }),
  });
}

/** Options for customizing execute-task prompt construction. */
export interface ExecuteTaskPromptOptions {
  level?: InlineLevel;
  /** Override carry-forward paths (dependency-based instead of order-based). */
  carryForwardPaths?: string[];
}

export async function buildExecuteTaskPrompt(
  mid: string, sid: string, sTitle: string,
  tid: string, tTitle: string, base: string,
  level?: InlineLevel | ExecuteTaskPromptOptions,
): Promise<string> {
  const opts: ExecuteTaskPromptOptions = typeof level === "object" && level !== null && !Array.isArray(level)
    ? level
    : { level: level as InlineLevel | undefined };
  const inlineLevel = opts.level ?? resolveInlineLevel();

  const priorSummaries = opts.carryForwardPaths ?? await getPriorTaskSummaryPaths(mid, sid, tid, base);
  const priorLines = priorSummaries.length > 0
    ? priorSummaries.map(p => `- \`${p}\``).join("\n")
    : "- (no prior tasks)";

  const taskPlanPath = resolveTaskFile(base, mid, sid, tid, "PLAN");
  const taskPlanContent = taskPlanPath ? await loadFile(taskPlanPath) : null;
  const taskPlanRelPath = relSlicePath(base, mid, sid) + `/tasks/${tid}-PLAN.md`;
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

  const slicePlanPath = resolveSliceFile(base, mid, sid, "PLAN");
  const slicePlanContent = slicePlanPath ? await loadFile(slicePlanPath) : null;
  const slicePlanExcerpt = extractSliceExecutionExcerpt(slicePlanContent, relSliceFile(base, mid, sid, "PLAN"));

  // Check for continue file (new naming or legacy)
  const continueFile = resolveSliceFile(base, mid, sid, "CONTINUE");
  const legacyContinueDir = resolveSlicePath(base, mid, sid);
  const legacyContinuePath = legacyContinueDir ? join(legacyContinueDir, "continue.md") : null;
  const continueContent = continueFile ? await loadFile(continueFile) : null;
  const legacyContinueContent = !continueContent && legacyContinuePath ? await loadFile(legacyContinuePath) : null;
  const continueRelPath = relSliceFile(base, mid, sid, "CONTINUE");
  const resumeSection = buildResumeSection(
    continueContent,
    legacyContinueContent,
    continueRelPath,
    legacyContinuePath ? `${relSlicePath(base, mid, sid)}/continue.md` : null,
  );

  // For minimal inline level, only carry forward the most recent prior summary
  const effectivePriorSummaries = inlineLevel === "minimal" && priorSummaries.length > 1
    ? priorSummaries.slice(-1)
    : priorSummaries;
  const carryForwardSection = await buildCarryForwardSection(effectivePriorSummaries, base);

  // Inline project knowledge if available (smart-chunked for relevance)
  const knowledgeAbsPath = resolveGsdRootFile(base, "KNOWLEDGE");
  const knowledgeInlineET = existsSync(knowledgeAbsPath)
    ? await inlineFileSmart(
        knowledgeAbsPath,
        relGsdRootFile("KNOWLEDGE"),
        "Project Knowledge",
        `${tTitle} ${sTitle}`,  // use task + slice title as relevance query
      )
    : null;
  // Only include if it has content (not a "not found" result)
  const knowledgeContent = knowledgeInlineET && !knowledgeInlineET.includes("not found") ? knowledgeInlineET : null;

  const inlinedTemplates = inlineLevel === "minimal"
    ? inlineTemplate("task-summary", "Task Summary")
    : [
        inlineTemplate("task-summary", "Task Summary"),
        inlineTemplate("decisions", "Decisions"),
        ...(knowledgeContent ? [knowledgeContent] : []),
      ].join("\n\n---\n\n");

  const taskSummaryPath = join(base, `${relSlicePath(base, mid, sid)}/tasks/${tid}-SUMMARY.md`);

  const activeOverrides = await loadActiveOverrides(base);
  const overridesSection = formatOverridesSection(activeOverrides);

  // Compute verification budget for the executor's context window (issue #707)
  const prefs = loadEffectiveGSDPreferences();
  const contextWindow = resolveExecutorContextWindow(undefined, prefs?.preferences);
  const budgets = computeBudgets(contextWindow);
  const verificationBudget = `~${Math.round(budgets.verificationBudgetChars / 1000)}K chars`;

  // Truncate carry-forward section when it exceeds 40% of inline context budget.
  const carryForwardBudget = Math.floor(budgets.inlineContextBudgetChars * 0.4);
  let finalCarryForward = carryForwardSection;
  if (carryForwardSection.length > carryForwardBudget) {
    finalCarryForward = truncateAtSectionBoundary(carryForwardSection, carryForwardBudget).content;
  }

  // Inline RUNTIME.md if present
  const runtimePath = resolveRuntimeFile(base);
  const runtimeContent = existsSync(runtimePath) ? await loadFile(runtimePath) : null;
  const runtimeContext = runtimeContent
    ? `### Runtime Context\nSource: \`.gsd/RUNTIME.md\`\n\n${runtimeContent.trim()}`
    : "";

  return loadPrompt("execute-task", {
    overridesSection,
    runtimeContext,
    workingDirectory: base,
    milestoneId: mid, sliceId: sid, sliceTitle: sTitle, taskId: tid, taskTitle: tTitle,
    planPath: join(base, relSliceFile(base, mid, sid, "PLAN")),
    slicePath: relSlicePath(base, mid, sid),
    taskPlanPath: taskPlanRelPath,
    taskPlanInline,
    slicePlanExcerpt,
    carryForwardSection: finalCarryForward,
    resumeSection,
    priorTaskLines: priorLines,
    taskSummaryPath,
    inlinedTemplates,
    verificationBudget,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      sliceId: sid,
      sliceTitle: sTitle,
      taskId: tid,
      taskTitle: tTitle,
      taskPlanContent,
      extraContext: [taskPlanInline, slicePlanExcerpt, finalCarryForward, resumeSection],
    }),
  });
}

export async function buildCompleteSlicePrompt(
  mid: string, _midTitle: string, sid: string, sTitle: string, base: string, level?: InlineLevel,
): Promise<string> {
  const inlineLevel = level ?? resolveInlineLevel();

  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const slicePlanPath = resolveSliceFile(base, mid, sid, "PLAN");
  const slicePlanRel = relSliceFile(base, mid, sid, "PLAN");

  const inlined: string[] = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));
  inlined.push(await inlineFile(slicePlanPath, slicePlanRel, "Slice Plan"));
  if (inlineLevel !== "minimal") {
    const requirementsInline = await inlineRequirementsFromDb(base, sid, inlineLevel);
    if (requirementsInline) inlined.push(requirementsInline);
  }
  const knowledgeInlineCS = await inlineGsdRootFile(base, "knowledge.md", "Project Knowledge");
  if (knowledgeInlineCS) inlined.push(knowledgeInlineCS);

  // Inline all task summaries for this slice
  const tDir = resolveTasksDir(base, mid, sid);
  if (tDir) {
    const summaryFiles = resolveTaskFiles(tDir, "SUMMARY").sort();
    for (const file of summaryFiles) {
      const absPath = join(tDir, file);
      const content = await loadFile(absPath);
      const sRel = relSlicePath(base, mid, sid);
      const relPath = `${sRel}/tasks/${file}`;
      if (content) {
        inlined.push(`### Task Summary: ${file.replace(/-SUMMARY\.md$/i, "")}\nSource: \`${relPath}\`\n\n${content.trim()}`);
      }
    }
  }
  inlined.push(inlineTemplate("slice-summary", "Slice Summary"));
  if (inlineLevel !== "minimal") {
    inlined.push(inlineTemplate("uat", "UAT"));
  }
  const completeActiveOverrides = await loadActiveOverrides(base);
  const completeOverridesInline = formatOverridesSection(completeActiveOverrides);
  if (completeOverridesInline) inlined.unshift(completeOverridesInline);

  const inlinedContext = capPreamble(`## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`);

  const sliceRel = relSlicePath(base, mid, sid);
  const sliceSummaryPath = join(base, `${sliceRel}/${sid}-SUMMARY.md`);
  const sliceUatPath = join(base, `${sliceRel}/${sid}-UAT.md`);

  return loadPrompt("complete-slice", {
    workingDirectory: base,
    milestoneId: mid, sliceId: sid, sliceTitle: sTitle,
    slicePath: sliceRel,
    roadmapPath: join(base, roadmapRel),
    inlinedContext,
    sliceSummaryPath,
    sliceUatPath,
  });
}

export async function buildCompleteMilestonePrompt(
  mid: string, midTitle: string, base: string, level?: InlineLevel,
): Promise<string> {
  const inlineLevel = level ?? resolveInlineLevel();
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");

  const inlined: string[] = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));

  // Inline all slice summaries (deduplicated by slice ID)
  let sliceIds: string[] = [];
  try {
    const { isDbAvailable, getMilestoneSlices } = await import("./gsd-db.js");
    if (isDbAvailable()) {
      sliceIds = getMilestoneSlices(mid).map(s => s.id);
    }
  } catch { /* fall through */ }
  // File-based fallback: parse roadmap for slice IDs when DB has no data
  if (sliceIds.length === 0 && roadmapPath) {
    const roadmapContent = await loadFile(roadmapPath);
    if (roadmapContent) {
      sliceIds = parseRoadmap(roadmapContent).slices.map(s => s.id);
    }
  }
  const seenSlices = new Set<string>();
  for (const sid of sliceIds) {
    if (seenSlices.has(sid)) continue;
    seenSlices.add(sid);
    const summaryPath = resolveSliceFile(base, mid, sid, "SUMMARY");
    const summaryRel = relSliceFile(base, mid, sid, "SUMMARY");
    inlined.push(await inlineFile(summaryPath, summaryRel, `${sid} Summary`));
  }

  // Inline root GSD files (skip for minimal — completion can read these if needed)
  if (inlineLevel !== "minimal") {
    const requirementsInline = await inlineRequirementsFromDb(base, undefined, inlineLevel);
    if (requirementsInline) inlined.push(requirementsInline);
    const decisionsInline = await inlineDecisionsFromDb(base, mid, undefined, inlineLevel);
    if (decisionsInline) inlined.push(decisionsInline);
    const projectInline = await inlineProjectFromDb(base);
    if (projectInline) inlined.push(projectInline);
  }
  const knowledgeInlineCM = await inlineGsdRootFile(base, "knowledge.md", "Project Knowledge");
  if (knowledgeInlineCM) inlined.push(knowledgeInlineCM);
  // Inline milestone context file (milestone-level, not GSD root)
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");
  const contextInline = await inlineFileOptional(contextPath, contextRel, "Milestone Context");
  if (contextInline) inlined.push(contextInline);
  inlined.push(inlineTemplate("milestone-summary", "Milestone Summary"));

  const inlinedContext = capPreamble(`## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`);

  const milestoneSummaryPath = join(base, `${relMilestonePath(base, mid)}/${mid}-SUMMARY.md`);

  return loadPrompt("complete-milestone", {
    workingDirectory: base,
    milestoneId: mid,
    milestoneTitle: midTitle,
    roadmapPath: roadmapRel,
    inlinedContext,
    milestoneSummaryPath,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      milestoneTitle: midTitle,
      extraContext: [inlinedContext],
    }),
  });
}

export async function buildValidateMilestonePrompt(
  mid: string, midTitle: string, base: string, level?: InlineLevel,
): Promise<string> {
  const inlineLevel = level ?? resolveInlineLevel();
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");

  const inlined: string[] = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));

  // Inline verification classes from planning (if available in DB)
  try {
    const { isDbAvailable, getMilestone } = await import("./gsd-db.js");
    if (isDbAvailable()) {
      const milestone = getMilestone(mid);
      if (milestone) {
        const classes: string[] = [];
        if (milestone.verification_contract) classes.push(`- **Contract:** ${milestone.verification_contract}`);
        if (milestone.verification_integration) classes.push(`- **Integration:** ${milestone.verification_integration}`);
        if (milestone.verification_operational) classes.push(`- **Operational:** ${milestone.verification_operational}`);
        if (milestone.verification_uat) classes.push(`- **UAT:** ${milestone.verification_uat}`);
        if (classes.length > 0) {
          inlined.push(`### Verification Classes (from planning)\n\nThese verification tiers were defined during milestone planning. Each non-empty class must be checked for evidence during validation.\n\n${classes.join("\n")}`);
        }
      }
    }
  } catch { /* fall through */ }

  // Inline all slice summaries and UAT results
  let valSliceIds: string[] = [];
  try {
    const { isDbAvailable, getMilestoneSlices } = await import("./gsd-db.js");
    if (isDbAvailable()) {
      valSliceIds = getMilestoneSlices(mid).map(s => s.id);
    }
  } catch { /* fall through */ }
  // File-based fallback: parse roadmap for slice IDs when DB has no data
  if (valSliceIds.length === 0 && roadmapPath) {
    const roadmapContent = await loadFile(roadmapPath);
    if (roadmapContent) {
      valSliceIds = parseRoadmap(roadmapContent).slices.map(s => s.id);
    }
  }
  const seenValSlices = new Set<string>();
  for (const sid of valSliceIds) {
    if (seenValSlices.has(sid)) continue;
    seenValSlices.add(sid);
    const summaryPath = resolveSliceFile(base, mid, sid, "SUMMARY");
    const summaryRel = relSliceFile(base, mid, sid, "SUMMARY");
    inlined.push(await inlineFile(summaryPath, summaryRel, `${sid} Summary`));

    const uatPath = resolveSliceFile(base, mid, sid, "UAT");
    const uatRel = relSliceFile(base, mid, sid, "UAT");
    const uatInline = await inlineFileOptional(uatPath, uatRel, `${sid} UAT Result`);
    if (uatInline) inlined.push(uatInline);
  }

  // Aggregate unresolved follow-ups and known limitations across slices
  const outstandingItems: string[] = [];
  for (const sid of valSliceIds) {
    const summaryPath = resolveSliceFile(base, mid, sid, "SUMMARY");
    if (!summaryPath) continue;
    const content = await loadFile(summaryPath);
    if (!content) continue;
    const summary = parseSummary(content);
    if (summary.followUps) outstandingItems.push(`- **${sid} Follow-ups:** ${summary.followUps.trim()}`);
    if (summary.knownLimitations) outstandingItems.push(`- **${sid} Known Limitations:** ${summary.knownLimitations.trim()}`);
  }
  if (outstandingItems.length > 0) {
    inlined.push(`### Outstanding Items (aggregated from slice summaries)\n\nThese follow-ups and known limitations were documented during slice completion but have not been resolved.\n\n${outstandingItems.join('\n')}`);
  }

  // Inline existing VALIDATION file if this is a re-validation round
  const validationPath = resolveMilestoneFile(base, mid, "VALIDATION");
  const validationRel = relMilestoneFile(base, mid, "VALIDATION");
  const validationContent = validationPath ? await loadFile(validationPath) : null;
  let remediationRound = 0;
  if (validationContent) {
    const roundMatch = validationContent.match(/remediation_round:\s*(\d+)/);
    remediationRound = roundMatch ? parseInt(roundMatch[1], 10) + 1 : 1;
    inlined.push(`### Previous Validation (re-validation round ${remediationRound})\nSource: \`${validationRel}\`\n\n${validationContent.trim()}`);
  }

  // Inline root GSD files
  if (inlineLevel !== "minimal") {
    const requirementsInline = await inlineRequirementsFromDb(base, undefined, inlineLevel);
    if (requirementsInline) inlined.push(requirementsInline);
    const decisionsInline = await inlineDecisionsFromDb(base, mid, undefined, inlineLevel);
    if (decisionsInline) inlined.push(decisionsInline);
    const projectInline = await inlineProjectFromDb(base);
    if (projectInline) inlined.push(projectInline);
  }
  const knowledgeInline = await inlineGsdRootFile(base, "knowledge.md", "Project Knowledge");
  if (knowledgeInline) inlined.push(knowledgeInline);
  // Inline milestone context file
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");
  const contextInline = await inlineFileOptional(contextPath, contextRel, "Milestone Context");
  if (contextInline) inlined.push(contextInline);

  const inlinedContext = capPreamble(`## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`);

  const validationOutputPath = join(base, `${relMilestonePath(base, mid)}/${mid}-VALIDATION.md`);
  const roadmapOutputPath = `${relMilestonePath(base, mid)}/${mid}-ROADMAP.md`;

  return loadPrompt("validate-milestone", {
    workingDirectory: base,
    milestoneId: mid,
    milestoneTitle: midTitle,
    roadmapPath: roadmapOutputPath,
    inlinedContext,
    validationPath: validationOutputPath,
    remediationRound: String(remediationRound),
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      milestoneTitle: midTitle,
      extraContext: [inlinedContext],
    }),
  });
}

export async function buildReplanSlicePrompt(
  mid: string, midTitle: string, sid: string, sTitle: string, base: string,
): Promise<string> {
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const slicePlanPath = resolveSliceFile(base, mid, sid, "PLAN");
  const slicePlanRel = relSliceFile(base, mid, sid, "PLAN");

  const inlined: string[] = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));
  inlined.push(await inlineFile(slicePlanPath, slicePlanRel, "Current Slice Plan"));

  // Find the blocker task summary — the completed task with blocker_discovered: true
  let blockerTaskId = "";
  const tDir = resolveTasksDir(base, mid, sid);
  if (tDir) {
    const summaryFiles = resolveTaskFiles(tDir, "SUMMARY").sort();
    for (const file of summaryFiles) {
      const absPath = join(tDir, file);
      const content = await loadFile(absPath);
      if (!content) continue;
      const summary = parseSummary(content);
      const sRel = relSlicePath(base, mid, sid);
      const relPath = `${sRel}/tasks/${file}`;
      if (summary.frontmatter.blocker_discovered) {
        blockerTaskId = summary.frontmatter.id || file.replace(/-SUMMARY\.md$/i, "");
        inlined.push(`### Blocker Task Summary: ${blockerTaskId}\nSource: \`${relPath}\`\n\n${content.trim()}`);
      }
    }
  }

  // Inline decisions
  const decisionsInline = await inlineDecisionsFromDb(base, mid);
  if (decisionsInline) inlined.push(decisionsInline);
  const replanActiveOverrides = await loadActiveOverrides(base);
  const replanOverridesInline = formatOverridesSection(replanActiveOverrides);
  if (replanOverridesInline) inlined.unshift(replanOverridesInline);

  const inlinedContext = capPreamble(`## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`);

  const replanPath = join(base, `${relSlicePath(base, mid, sid)}/${sid}-REPLAN.md`);

  // Build capture context for replan prompt (captures that triggered this replan)
  let captureContext = "(none)";
  try {
    const { loadReplanCaptures } = await import("./triage-resolution.js");
    const replanCaptures = loadReplanCaptures(base);
    if (replanCaptures.length > 0) {
      captureContext = replanCaptures.map(c =>
        `- **${c.id}**: "${c.text}" — ${c.rationale ?? "no rationale"}`
      ).join("\n");
    }
  } catch {
    // Non-fatal — captures module may not be available
  }

  return loadPrompt("replan-slice", {
    workingDirectory: base,
    milestoneId: mid,
    sliceId: sid,
    sliceTitle: sTitle,
    slicePath: relSlicePath(base, mid, sid),
    planPath: join(base, slicePlanRel),
    blockerTaskId,
    inlinedContext,
    replanPath,
    captureContext,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      milestoneTitle: midTitle,
      sliceId: sid,
      sliceTitle: sTitle,
      extraContext: [inlinedContext, captureContext],
    }),
  });
}

export async function buildRunUatPrompt(
  mid: string, sliceId: string, uatPath: string, uatContent: string, base: string,
): Promise<string> {
  const inlined: string[] = [];
  inlined.push(await inlineFile(resolveSliceFile(base, mid, sliceId, "UAT"), uatPath, `${sliceId} UAT`));

  const summaryPath = resolveSliceFile(base, mid, sliceId, "SUMMARY");
  const summaryRel = relSliceFile(base, mid, sliceId, "SUMMARY");
  if (summaryPath) {
    const summaryInline = await inlineFileOptional(summaryPath, summaryRel, `${sliceId} Summary`);
    if (summaryInline) inlined.push(summaryInline);
  }

  const projectInline = await inlineProjectFromDb(base);
  if (projectInline) inlined.push(projectInline);

  const inlinedContext = capPreamble(`## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`);

  const uatResultPath = join(base, relSliceFile(base, mid, sliceId, "ASSESSMENT"));
  const uatType = getUatType(uatContent);

  return loadPrompt("run-uat", {
    workingDirectory: base,
    milestoneId: mid,
    sliceId,
    uatPath,
    uatResultPath,
    uatType,
    inlinedContext,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      sliceId,
      extraContext: [inlinedContext],
    }),
  });
}

export async function buildReassessRoadmapPrompt(
  mid: string, midTitle: string, completedSliceId: string, base: string, level?: InlineLevel,
): Promise<string> {
  const inlineLevel = level ?? resolveInlineLevel();
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const summaryPath = resolveSliceFile(base, mid, completedSliceId, "SUMMARY");
  const summaryRel = relSliceFile(base, mid, completedSliceId, "SUMMARY");

  const inlined: string[] = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Current Roadmap"));
  inlined.push(await inlineFile(summaryPath, summaryRel, `${completedSliceId} Summary`));
  if (inlineLevel !== "minimal") {
    const projectInline = await inlineProjectFromDb(base);
    if (projectInline) inlined.push(projectInline);
    const requirementsInline = await inlineRequirementsFromDb(base, undefined, inlineLevel);
    if (requirementsInline) inlined.push(requirementsInline);
    const decisionsInline = await inlineDecisionsFromDb(base, mid, undefined, inlineLevel);
    if (decisionsInline) inlined.push(decisionsInline);
  }
  const knowledgeInlineRA = await inlineGsdRootFile(base, "knowledge.md", "Project Knowledge");
  if (knowledgeInlineRA) inlined.push(knowledgeInlineRA);

  const inlinedContext = capPreamble(`## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`);

  const assessmentPath = join(base, relSliceFile(base, mid, completedSliceId, "ASSESSMENT"));

  // Build deferred captures context for reassess prompt
  let deferredCaptures = "(none)";
  try {
    const { loadDeferredCaptures } = await import("./triage-resolution.js");
    const deferred = loadDeferredCaptures(base);
    if (deferred.length > 0) {
      deferredCaptures = deferred.map(c =>
        `- **${c.id}**: "${c.text}" — ${c.rationale ?? "deferred during triage"}`
      ).join("\n");
    }
  } catch {
    // Non-fatal — captures module may not be available
  }

  const reassessCommitInstruction = "Do not commit — .gsd/ planning docs are managed externally and not tracked in git.";

  return loadPrompt("reassess-roadmap", {
    workingDirectory: base,
    milestoneId: mid,
    milestoneTitle: midTitle,
    completedSliceId,
    roadmapPath: roadmapRel,
    assessmentPath,
    inlinedContext,
    deferredCaptures,
    commitInstruction: reassessCommitInstruction,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      milestoneTitle: midTitle,
      extraContext: [inlinedContext, deferredCaptures],
    }),
  });
}

// ─── Reactive Execute Prompt ──────────────────────────────────────────────

export async function buildReactiveExecutePrompt(
  mid: string, midTitle: string, sid: string, sTitle: string,
  readyTaskIds: string[], base: string,
): Promise<string> {
  const { loadSliceTaskIO, deriveTaskGraph, graphMetrics } = await import("./reactive-graph.js");

  // Build graph for context
  const taskIO = await loadSliceTaskIO(base, mid, sid);
  const graph = deriveTaskGraph(taskIO);
  const metrics = graphMetrics(graph);

  // Build graph context section
  const graphLines: string[] = [];
  for (const node of graph) {
    const status = node.done ? "✅ done" : readyTaskIds.includes(node.id) ? "🟢 ready" : "⏳ waiting";
    const deps = node.dependsOn.length > 0 ? ` (depends on: ${node.dependsOn.join(", ")})` : "";
    graphLines.push(`- **${node.id}: ${node.title}** — ${status}${deps}`);
    if (node.outputFiles.length > 0) {
      graphLines.push(`  - Outputs: ${node.outputFiles.map(f => `\`${f}\``).join(", ")}`);
    }
  }
  const graphContext = [
    `Tasks: ${metrics.taskCount}, Edges: ${metrics.edgeCount}, Ready: ${metrics.readySetSize}`,
    "",
    ...graphLines,
  ].join("\n");

  // Build individual subagent prompts for each ready task
  const subagentSections: string[] = [];
  const readyTaskListLines: string[] = [];

  for (const tid of readyTaskIds) {
    const node = graph.find((n) => n.id === tid);
    const tTitle = node?.title ?? tid;
    readyTaskListLines.push(`- **${tid}: ${tTitle}**`);

    // Build dependency-scoped carry-forward paths for this task
    const depPaths = await getDependencyTaskSummaryPaths(
      mid, sid, tid, node?.dependsOn ?? [], base,
    );

    // Build a full execute-task prompt with dependency-based carry-forward
    const taskPrompt = await buildExecuteTaskPrompt(
      mid, sid, sTitle, tid, tTitle, base,
      { carryForwardPaths: depPaths },
    );

    subagentSections.push([
      `### ${tid}: ${tTitle}`,
      "",
      "Use this as the prompt for a `subagent` call:",
      "",
      "```",
      taskPrompt,
      "```",
    ].join("\n"));
  }

  const inlinedTemplates = inlineTemplate("task-summary", "Task Summary");

  return loadPrompt("reactive-execute", {
    workingDirectory: base,
    milestoneId: mid,
    milestoneTitle: midTitle,
    sliceId: sid,
    sliceTitle: sTitle,
    graphContext,
    readyTaskCount: String(readyTaskIds.length),
    readyTaskList: readyTaskListLines.join("\n"),
    subagentPrompts: subagentSections.join("\n\n---\n\n"),
    inlinedTemplates,
  });
}

// ─── Gate Evaluation ──────────────────────────────────────────────────────

const GATE_QUESTIONS: Record<string, { question: string; guidance: string }> = {
  Q3: {
    question: "How can this be exploited?",
    guidance: [
      "Identify abuse scenarios: parameter tampering, replay attacks, privilege escalation.",
      "Map data exposure risks: PII, tokens, secrets accessible through this slice.",
      "Define input trust boundaries: untrusted user input reaching DB, API, or filesystem.",
      "If none apply, return verdict 'omitted' with rationale explaining why.",
    ].join("\n"),
  },
  Q4: {
    question: "What existing promises does this break?",
    guidance: [
      "List which existing requirements (R001, R003, etc.) are touched by this slice.",
      "Identify what must be re-tested after shipping.",
      "Flag decisions that should be revisited given the new scope.",
      "If no existing requirements are affected, return verdict 'omitted'.",
    ].join("\n"),
  },
};

export async function buildGateEvaluatePrompt(
  mid: string, midTitle: string, sid: string, sTitle: string,
  base: string,
): Promise<string> {
  const pending = getPendingGates(mid, sid, "slice");

  // Load the slice plan for context
  const planFile = resolveSliceFile(base, mid, sid, "PLAN");
  const planContent = planFile ? (await loadFile(planFile)) ?? "(plan file empty)" : "(plan file not found)";

  // Build per-gate subagent prompts
  const subagentSections: string[] = [];
  const gateListLines: string[] = [];

  for (const gate of pending) {
    const meta = GATE_QUESTIONS[gate.gate_id];
    if (!meta) continue;

    gateListLines.push(`- **${gate.gate_id}**: ${meta.question}`);

    const subPrompt = [
      `You are evaluating quality gate **${gate.gate_id}** for slice ${sid} (${sTitle}).`,
      "",
      `## Question: ${meta.question}`,
      "",
      meta.guidance,
      "",
      "## Slice Plan",
      "",
      planContent,
      "",
      "## Instructions",
      "",
      "Analyze the slice plan above and answer the gate question.",
      `Call the \`gsd_save_gate_result\` tool with:`,
      `- \`milestoneId\`: "${mid}"`,
      `- \`sliceId\`: "${sid}"`,
      `- \`gateId\`: "${gate.gate_id}"`,
      "- `verdict`: \"pass\" (no concerns), \"flag\" (concerns found), or \"omitted\" (not applicable)",
      "- `rationale`: one-sentence justification",
      "- `findings`: detailed markdown findings (or empty if omitted)",
    ].join("\n");

    subagentSections.push([
      `### ${gate.gate_id}: ${meta.question}`,
      "",
      "Use this as the prompt for a `subagent` call:",
      "",
      "```",
      subPrompt,
      "```",
    ].join("\n"));
  }

  return loadPrompt("gate-evaluate", {
    workingDirectory: base,
    milestoneId: mid,
    milestoneTitle: midTitle,
    sliceId: sid,
    sliceTitle: sTitle,
    slicePlanContent: planContent,
    gateCount: String(pending.length),
    gateList: gateListLines.join("\n"),
    subagentPrompts: subagentSections.join("\n\n---\n\n"),
  });
}

export async function buildRewriteDocsPrompt(
  mid: string, midTitle: string,
  activeSlice: { id: string; title: string } | null,
  base: string,
  overrides: Override[],
): Promise<string> {
  const sid = activeSlice?.id;
  const sTitle = activeSlice?.title ?? "";
  const docList: string[] = [];

  if (sid) {
    const slicePlanPath = resolveSliceFile(base, mid, sid, "PLAN");
    const slicePlanRel = relSliceFile(base, mid, sid, "PLAN");
    if (slicePlanPath) {
      docList.push(`- Slice plan: \`${slicePlanRel}\``);
      const tDir = resolveTasksDir(base, mid, sid);
      if (tDir) {
        // DB primary path — get incomplete tasks
        let incompleteTasks: { id: string }[] | null = null;
        try {
          const { isDbAvailable, getSliceTasks } = await import("./gsd-db.js");
          if (isDbAvailable()) {
            incompleteTasks = getSliceTasks(mid, sid)
              .filter(t => t.status !== "complete" && t.status !== "done")
              .map(t => ({ id: t.id }));
          }
        } catch { /* fall through */ }

        if (!incompleteTasks) {
          // DB unavailable — no task data to inline
          incompleteTasks = [];
        }

        if (incompleteTasks) {
          for (const task of incompleteTasks) {
            const taskPlanPath = resolveTaskFile(base, mid, sid, task.id, "PLAN");
            if (taskPlanPath) {
              const taskRelPath = `${relSlicePath(base, mid, sid)}/tasks/${task.id}-PLAN.md`;
              docList.push(`- Task plan: \`${taskRelPath}\``);
            }
          }
        }
      }
    }
  }

  const decisionsPath = resolveGsdRootFile(base, "DECISIONS");
  if (existsSync(decisionsPath)) docList.push(`- Decisions: \`${relGsdRootFile("DECISIONS")}\``);
  const requirementsPath = resolveGsdRootFile(base, "REQUIREMENTS");
  if (existsSync(requirementsPath)) docList.push(`- Requirements: \`${relGsdRootFile("REQUIREMENTS")}\``);
  const projectPath = resolveGsdRootFile(base, "PROJECT");
  if (existsSync(projectPath)) docList.push(`- Project: \`${relGsdRootFile("PROJECT")}\``);
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");
  if (contextPath) docList.push(`- Milestone context (reference only): \`${contextRel}\``);
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  if (roadmapPath) docList.push(`- Roadmap: \`${roadmapRel}\``);

  const overrideContent = overrides.map((o, i) => [
    `### Override ${i + 1}`,
    `**Change:** ${o.change}`,
    `**Issued:** ${o.timestamp}`,
    `**During:** ${o.appliedAt}`,
  ].join("\n")).join("\n\n");

  const documentList = docList.length > 0 ? docList.join("\n") : "- No active plan documents found.";

  return loadPrompt("rewrite-docs", {
    milestoneId: mid,
    milestoneTitle: midTitle,
    sliceId: sid ?? "none",
    sliceTitle: sTitle,
    overrideContent,
    documentList,
    overridesPath: relGsdRootFile("OVERRIDES"),
  });
}
