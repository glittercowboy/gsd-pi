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
import { resolveSkillDiscoveryMode } from "./preferences.js";
import type { GSDState } from "./types.js";
import type { GSDPreferences } from "./preferences.js";
import { join } from "node:path";
import { existsSync } from "node:fs";

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
 * Load and inline dependency slice summaries (full content, not just paths).
 */
export async function inlineDependencySummaries(
  mid: string, sid: string, base: string,
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
  return sections.join("\n\n");
}

/**
 * Load a well-known .gsd/ root file for optional inlining.
 * Handles the existsSync check internally.
 */
export async function inlineGsdRootFile(
  base: string, filename: string, label: string,
): Promise<string | null> {
  const key = filename.replace(/\.md$/i, "").toUpperCase() as "PROJECT" | "DECISIONS" | "QUEUE" | "STATE" | "REQUIREMENTS";
  const absPath = resolveGsdRootFile(base, key);
  if (!existsSync(absPath)) return null;
  return inlineFileOptional(absPath, relGsdRootFile(key), label);
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
  const projectInline = await inlineGsdRootFile(base, "project.md", "Project");
  if (projectInline) inlined.push(projectInline);
  const requirementsInline = await inlineGsdRootFile(base, "requirements.md", "Requirements");
  if (requirementsInline) inlined.push(requirementsInline);
  const decisionsInline = await inlineGsdRootFile(base, "decisions.md", "Decisions");
  if (decisionsInline) inlined.push(decisionsInline);
  inlined.push(inlineTemplate("research", "Research"));

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const outputRelPath = relMilestoneFile(base, mid, "RESEARCH");
  return loadPrompt("research-milestone", {
    workingDirectory: base,
    milestoneId: mid, milestoneTitle: midTitle,
    milestonePath: relMilestonePath(base, mid),
    contextPath: contextRel,
    outputPath: outputRelPath,
    inlinedContext,
    ...buildSkillDiscoveryVars(),
  });
}

export async function buildPlanMilestonePrompt(mid: string, midTitle: string, base: string): Promise<string> {
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
  const projectInline = await inlineGsdRootFile(base, "project.md", "Project");
  if (projectInline) inlined.push(projectInline);
  const requirementsInline = await inlineGsdRootFile(base, "requirements.md", "Requirements");
  if (requirementsInline) inlined.push(requirementsInline);
  const decisionsInline = await inlineGsdRootFile(base, "decisions.md", "Decisions");
  if (decisionsInline) inlined.push(decisionsInline);
  inlined.push(inlineTemplate("roadmap", "Roadmap"));
  inlined.push(inlineTemplate("decisions", "Decisions"));
  inlined.push(inlineTemplate("plan", "Slice Plan"));
  inlined.push(inlineTemplate("task-plan", "Task Plan"));
  inlined.push(inlineTemplate("secrets-manifest", "Secrets Manifest"));

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const outputRelPath = relMilestoneFile(base, mid, "ROADMAP");
  const secretsOutputPath = relMilestoneFile(base, mid, "SECRETS");
  return loadPrompt("plan-milestone", {
    workingDirectory: base,
    milestoneId: mid, milestoneTitle: midTitle,
    milestonePath: relMilestonePath(base, mid),
    contextPath: contextRel,
    researchPath: researchRel,
    outputPath: outputRelPath,
    secretsOutputPath,
    inlinedContext,
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
  const decisionsInline = await inlineGsdRootFile(base, "decisions.md", "Decisions");
  if (decisionsInline) inlined.push(decisionsInline);
  const requirementsInline = await inlineGsdRootFile(base, "requirements.md", "Requirements");
  if (requirementsInline) inlined.push(requirementsInline);
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
    outputPath: outputRelPath,
    inlinedContext,
    dependencySummaries: depContent,
    ...buildSkillDiscoveryVars(),
  });
}

export async function buildPlanSlicePrompt(
  mid: string, _midTitle: string, sid: string, sTitle: string, base: string,
): Promise<string> {
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const researchPath = resolveSliceFile(base, mid, sid, "RESEARCH");
  const researchRel = relSliceFile(base, mid, sid, "RESEARCH");

  const inlined: string[] = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));
  const researchInline = await inlineFileOptional(researchPath, researchRel, "Slice Research");
  if (researchInline) inlined.push(researchInline);
  const decisionsInline = await inlineGsdRootFile(base, "decisions.md", "Decisions");
  if (decisionsInline) inlined.push(decisionsInline);
  const requirementsInline = await inlineGsdRootFile(base, "requirements.md", "Requirements");
  if (requirementsInline) inlined.push(requirementsInline);
  inlined.push(inlineTemplate("plan", "Slice Plan"));
  inlined.push(inlineTemplate("task-plan", "Task Plan"));

  const depContent = await inlineDependencySummaries(mid, sid, base);
  const planActiveOverrides = await loadActiveOverrides(base);
  const planOverridesInline = formatOverridesSection(planActiveOverrides);
  if (planOverridesInline) inlined.unshift(planOverridesInline);

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const outputRelPath = relSliceFile(base, mid, sid, "PLAN");
  return loadPrompt("plan-slice", {
    workingDirectory: base,
    milestoneId: mid, sliceId: sid, sliceTitle: sTitle,
    slicePath: relSlicePath(base, mid, sid),
    roadmapPath: roadmapRel,
    researchPath: researchRel,
    outputPath: outputRelPath,
    inlinedContext,
    dependencySummaries: depContent,
  });
}

export async function buildExecuteTaskPrompt(
  mid: string, sid: string, sTitle: string,
  tid: string, tTitle: string, base: string,
): Promise<string> {

  const priorSummaries = await getPriorTaskSummaryPaths(mid, sid, tid, base);
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

  const carryForwardSection = await buildCarryForwardSection(priorSummaries, base);
  const inlinedTemplates = [
    inlineTemplate("task-summary", "Task Summary"),
    inlineTemplate("decisions", "Decisions"),
  ].join("\n\n---\n\n");

  const taskSummaryPath = `${relSlicePath(base, mid, sid)}/tasks/${tid}-SUMMARY.md`;

  const activeOverrides = await loadActiveOverrides(base);
  const overridesSection = formatOverridesSection(activeOverrides);

  return loadPrompt("execute-task", {
    overridesSection,
    workingDirectory: base,
    milestoneId: mid, sliceId: sid, sliceTitle: sTitle, taskId: tid, taskTitle: tTitle,
    planPath: relSliceFile(base, mid, sid, "PLAN"),
    slicePath: relSlicePath(base, mid, sid),
    taskPlanPath: taskPlanRelPath,
    taskPlanInline,
    slicePlanExcerpt,
    carryForwardSection,
    resumeSection,
    priorTaskLines: priorLines,
    taskSummaryPath,
    inlinedTemplates,
  });
}

export async function buildCompleteSlicePrompt(
  mid: string, _midTitle: string, sid: string, sTitle: string, base: string,
): Promise<string> {

  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const slicePlanPath = resolveSliceFile(base, mid, sid, "PLAN");
  const slicePlanRel = relSliceFile(base, mid, sid, "PLAN");

  const inlined: string[] = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));
  inlined.push(await inlineFile(slicePlanPath, slicePlanRel, "Slice Plan"));
  const requirementsInline = await inlineGsdRootFile(base, "requirements.md", "Requirements");
  if (requirementsInline) inlined.push(requirementsInline);

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
  inlined.push(inlineTemplate("uat", "UAT"));
  const completeActiveOverrides = await loadActiveOverrides(base);
  const completeOverridesInline = formatOverridesSection(completeActiveOverrides);
  if (completeOverridesInline) inlined.unshift(completeOverridesInline);

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const sliceRel = relSlicePath(base, mid, sid);
  const sliceSummaryPath = `${sliceRel}/${sid}-SUMMARY.md`;
  const sliceUatPath = `${sliceRel}/${sid}-UAT.md`;

  return loadPrompt("complete-slice", {
    workingDirectory: base,
    milestoneId: mid, sliceId: sid, sliceTitle: sTitle,
    slicePath: sliceRel,
    roadmapPath: roadmapRel,
    inlinedContext,
    sliceSummaryPath,
    sliceUatPath,
  });
}

export async function buildCompleteMilestonePrompt(
  mid: string, midTitle: string, base: string,
): Promise<string> {
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

  // Inline root GSD files
  const requirementsInline = await inlineGsdRootFile(base, "requirements.md", "Requirements");
  if (requirementsInline) inlined.push(requirementsInline);
  const decisionsInline = await inlineGsdRootFile(base, "decisions.md", "Decisions");
  if (decisionsInline) inlined.push(decisionsInline);
  const projectInline = await inlineGsdRootFile(base, "project.md", "Project");
  if (projectInline) inlined.push(projectInline);
  // Inline milestone context file (milestone-level, not GSD root)
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");
  const contextInline = await inlineFileOptional(contextPath, contextRel, "Milestone Context");
  if (contextInline) inlined.push(contextInline);
  inlined.push(inlineTemplate("milestone-summary", "Milestone Summary"));

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const milestoneSummaryPath = `${relMilestonePath(base, mid)}/${mid}-SUMMARY.md`;

  return loadPrompt("complete-milestone", {
    workingDirectory: base,
    milestoneId: mid,
    milestoneTitle: midTitle,
    roadmapPath: roadmapRel,
    inlinedContext,
    milestoneSummaryPath,
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
  const decisionsInline = await inlineGsdRootFile(base, "decisions.md", "Decisions");
  if (decisionsInline) inlined.push(decisionsInline);
  const replanActiveOverrides = await loadActiveOverrides(base);
  const replanOverridesInline = formatOverridesSection(replanActiveOverrides);
  if (replanOverridesInline) inlined.unshift(replanOverridesInline);

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const replanPath = `${relSlicePath(base, mid, sid)}/${sid}-REPLAN.md`;

  return loadPrompt("replan-slice", {
    workingDirectory: base,
    milestoneId: mid,
    sliceId: sid,
    sliceTitle: sTitle,
    slicePath: relSlicePath(base, mid, sid),
    planPath: slicePlanRel,
    blockerTaskId,
    inlinedContext,
    replanPath,
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

  const projectInline = await inlineGsdRootFile(base, "project.md", "Project");
  if (projectInline) inlined.push(projectInline);

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const uatResultPath = relSliceFile(base, mid, sliceId, "UAT-RESULT");
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
  mid: string, midTitle: string, completedSliceId: string, base: string,
): Promise<string> {
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const summaryPath = resolveSliceFile(base, mid, completedSliceId, "SUMMARY");
  const summaryRel = relSliceFile(base, mid, completedSliceId, "SUMMARY");

  const inlined: string[] = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Current Roadmap"));
  inlined.push(await inlineFile(summaryPath, summaryRel, `${completedSliceId} Summary`));
  const projectInline = await inlineGsdRootFile(base, "project.md", "Project");
  if (projectInline) inlined.push(projectInline);
  const requirementsInline = await inlineGsdRootFile(base, "requirements.md", "Requirements");
  if (requirementsInline) inlined.push(requirementsInline);
  const decisionsInline = await inlineGsdRootFile(base, "decisions.md", "Decisions");
  if (decisionsInline) inlined.push(decisionsInline);

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const assessmentPath = relSliceFile(base, mid, completedSliceId, "ASSESSMENT");

  return loadPrompt("reassess-roadmap", {
    workingDirectory: base,
    milestoneId: mid,
    milestoneTitle: midTitle,
    completedSliceId,
    roadmapPath: roadmapRel,
    completedSliceSummaryPath: summaryRel,
    assessmentPath,
    inlinedContext,
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
