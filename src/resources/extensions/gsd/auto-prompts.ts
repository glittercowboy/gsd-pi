/**
 * Auto-mode Prompt Builders — construct dispatch prompts for each unit type.
 *
 * Pure async functions that load templates and inline file content. No module-level
 * state, no globals — every dependency is passed as a parameter or imported as a
 * utility.
 */

import { loadFile, parseContinue, parsePlan, parseRoadmap, parseSummary, extractUatType, loadActiveOverrides, formatOverridesSection } from "./files.js";
import type { Override, UatType } from "./files.js";
import { loadPrompt, inlineTemplate } from "./prompt-loader.js";
import {
  resolveMilestoneFile, resolveSliceFile, resolveSlicePath,
  resolveTasksDir, resolveTaskFiles, resolveTaskFile,
  relMilestoneFile, relSliceFile, relSlicePath, relMilestonePath,
  resolveGsdRootFile, relGsdRootFile,
} from "./paths.js";
import { resolveSkillDiscoveryMode, resolveInlineLevel, loadEffectiveGSDPreferences } from "./preferences.js";
import type { GSDState, InlineLevel } from "./types.js";
import type { GSDPreferences } from "./preferences.js";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { computeBudgets, resolveExecutorContextWindow } from "./context-budget.js";
import { compressToTarget } from "./prompt-compressor.js";
import { distillSummaries } from "./summary-distiller.js";
import { formatDecisionsCompact, formatRequirementsCompact } from "./structured-data-formatter.js";
import { chunkByRelevance, formatChunks } from "./semantic-chunker.js";

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

  // Use semantic chunking for large files
  const result = chunkByRelevance(content, query, { maxChunks: 5, minScore: 0.05 });

  // If chunking didn't save much (< 20%), just include full content
  if (result.savingsPercent < 20) {
    return `### ${label}\nSource: \`${relPath}\`\n\n${content.trim()}`;
  }

  const formatted = formatChunks(result, relPath);
  return `### ${label} (${result.omittedChunks} sections omitted for relevance)\nSource: \`${relPath}\`\n\n${formatted}`;
}

/**
 * Load and inline dependency slice summaries (full content, not just paths).
 */
export async function inlineDependencySummaries(
  mid: string, sid: string, base: string, budgetChars?: number,
): Promise<string> {
  const roadmapFile = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
  if (!roadmapContent) return "- (no dependencies)";

  const roadmap = parseRoadmap(roadmapContent);
  const sliceEntry = roadmap.slices.find(s => s.id === sid);
  if (!sliceEntry || sliceEntry.depends.length === 0) return "- (no dependencies)";

  const sections: string[] = [];
  const seen = new Set<string>();
  for (const dep of sliceEntry.depends) {
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
    // For 3+ summaries, try distillation first (preserves more information)
    if (sections.length >= 3) {
      const rawSummaries = sections.map(s => {
        // Extract content after the header line
        const lines = s.split("\n");
        const contentStart = lines.findIndex(l => l.startsWith("Source:"));
        return contentStart >= 0 ? lines.slice(contentStart + 1).join("\n").trim() : s;
      });
      const distilled = distillSummaries(rawSummaries, budgetChars);
      if (distilled.content.length <= budgetChars) {
        return distilled.content;
      }
    }
    // Fall back to section-boundary truncation
    const { truncateAtSectionBoundary } = await import("./context-budget.js");
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

// ─── Skill Discovery ──────────────────────────────────────────────────────

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
  const roadmapFile = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
  if (!roadmapContent) return null;

  const roadmap = parseRoadmap(roadmapContent);
  const completedSlices = roadmap.slices.filter(s => s.done);
  const incompleteSlices = roadmap.slices.filter(s => !s.done);

  // No completed slices or all slices done — skip
  if (completedSlices.length === 0 || incompleteSlices.length === 0) return null;

  // Check the last completed slice
  const lastCompleted = completedSlices[completedSlices.length - 1];
  const assessmentFile = resolveSliceFile(base, mid, lastCompleted.id, "ASSESSMENT");
  const hasAssessment = !!(assessmentFile && await loadFile(assessmentFile));

  if (hasAssessment) return null;

  // Also need a summary to reassess against
  const summaryFile = resolveSliceFile(base, mid, lastCompleted.id, "SUMMARY");
  const hasSummary = !!(summaryFile && await loadFile(summaryFile));

  if (!hasSummary) return null;

  return { sliceId: lastCompleted.id };
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
  const roadmapFile = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
  if (!roadmapContent) return null;

  const roadmap = parseRoadmap(roadmapContent);
  const completedSlices = roadmap.slices.filter(s => s.done);
  const incompleteSlices = roadmap.slices.filter(s => !s.done);

  // No completed slices — nothing to UAT yet
  if (completedSlices.length === 0) return null;

  // All slices done — milestone complete path, skip (reassessment handles)
  if (incompleteSlices.length === 0) return null;

  // uat_dispatch must be opted in
  if (!prefs?.uat_dispatch) return null;

  // Take the last completed slice
  const lastCompleted = completedSlices[completedSlices.length - 1];
  const sid = lastCompleted.id;

  // UAT file must exist
  const uatFile = resolveSliceFile(base, mid, sid, "UAT");
  if (!uatFile) return null;
  const uatContent = await loadFile(uatFile);
  if (!uatContent) return null;

  // If UAT result already exists, skip (idempotent)
  const uatResultFile = resolveSliceFile(base, mid, sid, "UAT-RESULT");
  if (uatResultFile) {
    const hasResult = !!(await loadFile(uatResultFile));
    if (hasResult) return null;
  }

  // Classify UAT type; unknown type → treat as human-experience (human review)
  const uatType = extractUatType(uatContent) ?? "human-experience";

  return { sliceId: sid, uatType };
}

// ─── Prompt Builders ──────────────────────────────────────────────────────

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

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const outputRelPath = relMilestoneFile(base, mid, "RESEARCH");
  return loadPrompt("research-milestone", {
    workingDirectory: base,
    milestoneId: mid, milestoneTitle: midTitle,
    milestonePath: relMilestonePath(base, mid),
    contextPath: contextRel,
    outputPath: join(base, outputRelPath),
    inlinedContext,
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

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

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

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

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

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  // Build executor context constraints from the budget engine
  const executorContextConstraints = formatExecutorConstraints();

  const outputRelPath = relSliceFile(base, mid, sid, "PLAN");
  const prefs = loadEffectiveGSDPreferences();
  const commitDocsEnabled = prefs?.preferences?.git?.commit_docs !== false;
  const commitInstruction = commitDocsEnabled
    ? `Commit the plan files only: \`git add ${relSlicePath(base, mid, sid)}/ .gsd/DECISIONS.md .gitignore && git commit -m "docs(${sid}): add slice plan"\`. Do not stage .gsd/STATE.md or other runtime files — the system manages those.`
    : "Do not commit — planning docs are not tracked in git for this project.";
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

  // Compress carry-forward section when it exceeds 40% of inline context budget.
  // Only compress when compression_strategy is "compress" (budget/balanced profiles).
  const carryForwardBudget = Math.floor(budgets.inlineContextBudgetChars * 0.4);
  let finalCarryForward = carryForwardSection;
  if (carryForwardSection.length > carryForwardBudget) {
    const { resolveCompressionStrategy } = await import("./preferences.js");
    if (resolveCompressionStrategy() === "compress") {
      finalCarryForward = compressToTarget(carryForwardSection, carryForwardBudget).content;
    }
  }

  return loadPrompt("execute-task", {
    overridesSection,
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

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

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
  const roadmapContent = roadmapPath ? await loadFile(roadmapPath) : null;
  if (roadmapContent) {
    const roadmap = parseRoadmap(roadmapContent);
    const seenSlices = new Set<string>();
    for (const slice of roadmap.slices) {
      if (seenSlices.has(slice.id)) continue;
      seenSlices.add(slice.id);
      const summaryPath = resolveSliceFile(base, mid, slice.id, "SUMMARY");
      const summaryRel = relSliceFile(base, mid, slice.id, "SUMMARY");
      inlined.push(await inlineFile(summaryPath, summaryRel, `${slice.id} Summary`));
    }
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

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const milestoneSummaryPath = join(base, `${relMilestonePath(base, mid)}/${mid}-SUMMARY.md`);

  return loadPrompt("complete-milestone", {
    workingDirectory: base,
    milestoneId: mid,
    milestoneTitle: midTitle,
    roadmapPath: roadmapRel,
    inlinedContext,
    milestoneSummaryPath,
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

  // Inline all slice summaries and UAT results
  const roadmapContent = roadmapPath ? await loadFile(roadmapPath) : null;
  if (roadmapContent) {
    const roadmap = parseRoadmap(roadmapContent);
    const seenSlices = new Set<string>();
    for (const slice of roadmap.slices) {
      if (seenSlices.has(slice.id)) continue;
      seenSlices.add(slice.id);
      const summaryPath = resolveSliceFile(base, mid, slice.id, "SUMMARY");
      const summaryRel = relSliceFile(base, mid, slice.id, "SUMMARY");
      inlined.push(await inlineFile(summaryPath, summaryRel, `${slice.id} Summary`));

      const uatPath = resolveSliceFile(base, mid, slice.id, "UAT-RESULT");
      const uatRel = relSliceFile(base, mid, slice.id, "UAT-RESULT");
      const uatInline = await inlineFileOptional(uatPath, uatRel, `${slice.id} UAT Result`);
      if (uatInline) inlined.push(uatInline);
    }
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

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

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

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

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

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const uatResultPath = join(base, relSliceFile(base, mid, sliceId, "UAT-RESULT"));
  const uatType = extractUatType(uatContent) ?? "human-experience";

  return loadPrompt("run-uat", {
    workingDirectory: base,
    milestoneId: mid,
    sliceId,
    uatPath,
    uatResultPath,
    uatType,
    inlinedContext,
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

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

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

  const reassessPrefs = loadEffectiveGSDPreferences();
  const reassessCommitDocsEnabled = reassessPrefs?.preferences?.git?.commit_docs !== false;
  const reassessCommitInstruction = reassessCommitDocsEnabled
    ? `Commit: \`docs(${mid}): reassess roadmap after ${completedSliceId}\`. Stage only the .gsd/milestones/ files you changed — do not stage .gsd/STATE.md or other runtime files.`
    : "Do not commit — planning docs are not tracked in git for this project.";

  return loadPrompt("reassess-roadmap", {
    workingDirectory: base,
    milestoneId: mid,
    milestoneTitle: midTitle,
    completedSliceId,
    roadmapPath: roadmapRel,
    completedSliceSummaryPath: summaryRel,
    assessmentPath,
    inlinedContext,
    deferredCaptures,
    commitInstruction: reassessCommitInstruction,
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
        const planContent = await loadFile(slicePlanPath);
        if (planContent) {
          const plan = parsePlan(planContent);
          for (const task of plan.tasks) {
            if (!task.done) {
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
