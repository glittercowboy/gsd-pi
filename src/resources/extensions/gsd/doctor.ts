import { existsSync, mkdirSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadFile, parseSummary, saveFile, parseTaskPlanMustHaves, countMustHavesMentionedInSummary } from "./files.js";
import { parseRoadmap as parseLegacyRoadmap, parsePlan as parseLegacyPlan } from "./parsers-legacy.js";
import { isDbAvailable, getMilestoneSlices, getSliceTasks } from "./gsd-db.js";
import { resolveMilestoneFile, resolveMilestonePath, resolveSliceFile, resolveSlicePath, resolveTaskFile, resolveTasksDir, milestonesDir, gsdRoot, relMilestoneFile, relSliceFile, relTaskFile, relSlicePath, relGsdRootFile, resolveGsdRootFile, relMilestonePath } from "./paths.js";
import { deriveState, isMilestoneComplete } from "./state.js";
import { invalidateAllCaches } from "./cache.js";
import { loadEffectiveGSDPreferences, type GSDPreferences } from "./preferences.js";
import { isClosedStatus } from "./status-guards.js";

import type { DoctorIssue, DoctorIssueCode, DoctorReport } from "./doctor-types.js";
import { GLOBAL_STATE_CODES } from "./doctor-types.js";
import type { RoadmapSliceEntry } from "./types.js";
import { checkGitHealth, checkRuntimeHealth, checkGlobalHealth, checkEngineHealth } from "./doctor-checks.js";
import { checkEnvironmentHealth } from "./doctor-environment.js";
import { runProviderChecks } from "./doctor-providers.js";

// ── Re-exports ─────────────────────────────────────────────────────────────
// All public types and functions from extracted modules are re-exported here
// so that existing imports from "./doctor.js" continue to work unchanged.
export type { DoctorSeverity, DoctorIssueCode, DoctorIssue, DoctorReport, DoctorSummary } from "./doctor-types.js";
export { summarizeDoctorIssues, filterDoctorIssues, formatDoctorReport, formatDoctorIssuesForPrompt, formatDoctorReportJson } from "./doctor-format.js";
export { runEnvironmentChecks, runFullEnvironmentChecks, formatEnvironmentReport, type EnvironmentCheckResult } from "./doctor-environment.js";
export { computeProgressScore, computeProgressScoreWithContext, formatProgressLine, formatProgressReport, type ProgressScore, type ProgressLevel } from "./progress-score.js";

/**
 * Characters that are used as delimiters in GSD state management documents
 * and should not appear in milestone or slice titles.
 *
 * - "\u2014" (em dash, U+2014): used as a display separator in STATE.md and other docs.
 *   A title containing "\u2014" makes the separator ambiguous, corrupting state display
 *   and confusing the LLM agent that reads and writes these files.
 * - "\u2013" (en dash, U+2013): visually similar to em dash; same ambiguity risk.
 * - "/" (forward slash, U+002F): used as the path separator in unit IDs (M001/S01)
 *   and git branch names (gsd/M001/S01). A slash in a title can break path resolution.
 */
const TITLE_DELIMITER_RE = /[\u2014\u2013\/]/; // em dash, en dash, forward slash

/**
 * Check whether a milestone or slice title contains characters that conflict
 * with GSD's state document delimiter conventions.
 * Returns a human-readable description of the problem, or null if the title is safe.
 */
export function validateTitle(title: string): string | null {
  if (TITLE_DELIMITER_RE.test(title)) {
    const found: string[] = [];
    if (/[\u2014\u2013]/.test(title)) found.push("em/en dash (\u2014 or \u2013)");
    if (/\//.test(title)) found.push("forward slash (/)");
    return `title contains ${found.join(" and ")}, which conflict with GSD state document delimiters`;
  }
  return null;
}

function validatePreferenceShape(preferences: GSDPreferences): string[] {
  const issues: string[] = [];
  const listFields = ["always_use_skills", "prefer_skills", "avoid_skills", "custom_instructions"] as const;
  for (const field of listFields) {
    const value = preferences[field];
    if (value !== undefined && !Array.isArray(value)) {
      issues.push(`${field} must be a list`);
    }
  }

  if (preferences.skill_rules !== undefined) {
    if (!Array.isArray(preferences.skill_rules)) {
      issues.push("skill_rules must be a list");
    } else {
      for (const [index, rule] of preferences.skill_rules.entries()) {
        if (!rule || typeof rule !== "object") {
          issues.push(`skill_rules[${index}] must be an object`);
          continue;
        }
        if (typeof rule.when !== "string") {
          issues.push(`skill_rules[${index}].when must be a string`);
        }
        for (const key of ["use", "prefer", "avoid"] as const) {
          const value = (rule as unknown as Record<string, unknown>)[key];
          if (value !== undefined && !Array.isArray(value)) {
            issues.push(`skill_rules[${index}].${key} must be a list`);
          }
        }
      }
    }
  }

  return issues;
}

/** Build STATE.md content from derived state. Exported for guided-flow pre-dispatch rebuild (#3475). */
export function buildStateMarkdown(state: Awaited<ReturnType<typeof deriveState>>): string {
  const lines: string[] = [];
  lines.push("# GSD State", "");

  const activeMilestone = state.activeMilestone
    ? `${state.activeMilestone.id}: ${state.activeMilestone.title}`
    : "None";
  const activeSlice = state.activeSlice
    ? `${state.activeSlice.id}: ${state.activeSlice.title}`
    : "None";

  lines.push(`**Active Milestone:** ${activeMilestone}`);
  lines.push(`**Active Slice:** ${activeSlice}`);
  lines.push(`**Phase:** ${state.phase}`);
  if (state.requirements) {
    lines.push(`**Requirements Status:** ${state.requirements.active} active \u00b7 ${state.requirements.validated} validated \u00b7 ${state.requirements.deferred} deferred \u00b7 ${state.requirements.outOfScope} out of scope`);
  }
  lines.push("");
  lines.push("## Milestone Registry");

  for (const entry of state.registry) {
    const glyph = entry.status === "complete" ? "\u2705" : entry.status === "active" ? "\uD83D\uDD04" : entry.status === "parked" ? "\u23F8\uFE0F" : "\u2B1C";
    lines.push(`- ${glyph} **${entry.id}:** ${entry.title}`);
  }

  lines.push("");
  lines.push("## Recent Decisions");
  if (state.recentDecisions.length > 0) {
    for (const decision of state.recentDecisions) lines.push(`- ${decision}`);
  } else {
    lines.push("- None recorded");
  }

  lines.push("");
  lines.push("## Blockers");
  if (state.blockers.length > 0) {
    for (const blocker of state.blockers) lines.push(`- ${blocker}`);
  } else {
    lines.push("- None");
  }

  lines.push("");
  lines.push("## Next Action");
  lines.push(state.nextAction || "None");
  lines.push("");

  return lines.join("\n");
}

async function updateStateFile(basePath: string, fixesApplied: string[]): Promise<void> {
  const state = await deriveState(basePath);
  const path = resolveGsdRootFile(basePath, "STATE");
  await saveFile(path, buildStateMarkdown(state));
  fixesApplied.push(`updated ${path}`);
}

/** Rebuild STATE.md from current disk state. Exported for auto-mode post-hooks. */
export async function rebuildState(basePath: string): Promise<void> {
  invalidateAllCaches();
  const state = await deriveState(basePath);
  const path = resolveGsdRootFile(basePath, "STATE");
  await saveFile(path, buildStateMarkdown(state));
}

function matchesScope(unitId: string, scope?: string): boolean {
  if (!scope) return true;
  return unitId === scope || unitId.startsWith(`${scope}/`);
}

function auditRequirements(content: string | null): DoctorIssue[] {
  if (!content) return [];
  const issues: DoctorIssue[] = [];
  const blocks = content.split(/^###\s+/m).slice(1);

  for (const block of blocks) {
    const idMatch = block.match(/^(R\d+)/);
    if (!idMatch) continue;
    const requirementId = idMatch[1];
    const status = block.match(/^-\s+Status:\s+(.+)$/m)?.[1]?.trim().toLowerCase() ?? "";
    const owner = block.match(/^-\s+Primary owning slice:\s+(.+)$/m)?.[1]?.trim().toLowerCase() ?? "";
    const notes = block.match(/^-\s+Notes:\s+(.+)$/m)?.[1]?.trim().toLowerCase() ?? "";

    if (status === "active" && (!owner || owner === "none" || owner === "none yet")) {
      // #4414: Downgrade to warning. A newly-created requirement has
      // primary_owner='' by default until the planning agent wires it to
      // a slice via gsd_requirement_update. Flagging this as an error
      // during normal planning is noisy — the real failure mode is when
      // it persists past milestone completion, which is covered by other
      // audits. Keep the signal but don't treat it as a blocker.
      issues.push({
        severity: "warning",
        code: "active_requirement_missing_owner",
        scope: "project",
        unitId: requirementId,
        message: `${requirementId} is Active but has no primary owning slice`,
        file: relGsdRootFile("REQUIREMENTS"),
        fixable: false,
      });
    }

    if (status === "blocked" && !notes) {
      issues.push({
        severity: "warning",
        code: "blocked_requirement_missing_reason",
        scope: "project",
        unitId: requirementId,
        message: `${requirementId} is Blocked but has no reason in Notes`,
        file: relGsdRootFile("REQUIREMENTS"),
        fixable: false,
      });
    }
  }

  return issues;
}

export async function selectDoctorScope(basePath: string, requestedScope?: string): Promise<string | undefined> {
  if (requestedScope) return requestedScope;

  const state = await deriveState(basePath);
  if (state.activeMilestone?.id && state.activeSlice?.id) {
    return `${state.activeMilestone.id}/${state.activeSlice.id}`;
  }
  if (state.activeMilestone?.id) {
    return state.activeMilestone.id;
  }

  const milestonesPath = milestonesDir(basePath);
  if (!existsSync(milestonesPath)) return undefined;

  for (const milestone of state.registry) {
    const roadmapPath = resolveMilestoneFile(basePath, milestone.id, "ROADMAP");
    const roadmapContent = roadmapPath ? await loadFile(roadmapPath) : null;
    if (!roadmapContent) continue;
    if (isDbAvailable()) {
      const dbSlices = getMilestoneSlices(milestone.id);
      const allDone = dbSlices.length > 0 && dbSlices.every(s => s.status === "complete");
      if (!allDone) return milestone.id;
    } else {
      const roadmap = parseLegacyRoadmap(roadmapContent);
      if (!isMilestoneComplete(roadmap)) return milestone.id;
    }
  }

  return state.registry[0]?.id;
}

// ── Helper: circular dependency detection ──────────────────────────────────
function detectCircularDependencies(slices: RoadmapSliceEntry[]): string[][] {
  const known = new Set(slices.map(s => s.id));
  const adj = new Map<string, string[]>();
  for (const s of slices) adj.set(s.id, s.depends.filter(d => known.has(d)));
  const state = new Map<string, "unvisited" | "visiting" | "done">();
  for (const s of slices) state.set(s.id, "unvisited");
  const cycles: string[][] = [];
  function dfs(id: string, path: string[]): void {
    const st = state.get(id);
    if (st === "done") return;
    if (st === "visiting") { cycles.push([...path.slice(path.indexOf(id)), id]); return; }
    state.set(id, "visiting");
    for (const dep of adj.get(id) ?? []) dfs(dep, [...path, id]);
    state.set(id, "done");
  }
  for (const s of slices) if (state.get(s.id) === "unvisited") dfs(s.id, []);
  return cycles;
}

// ── Helper: doctor run history ──────────────────────────────────────────────
export interface DoctorHistoryEntry {
  ts: string;
  ok: boolean;
  errors: number;
  warnings: number;
  fixes: number;
  codes: string[];
  /** Issue messages with severity and scope (added in Phase 2). */
  issues?: Array<{ severity: string; code: string; message: string; unitId: string }>;
  /** Fix descriptions applied during this run (added in Phase 2). */
  fixDescriptions?: string[];
  /** Milestone/slice scope this doctor run was scoped to (e.g. "M001/S02"). */
  scope?: string;
  /** Human-readable one-line summary of this doctor run. */
  summary?: string;
}

async function appendDoctorHistory(basePath: string, report: DoctorReport): Promise<void> {
  try {
    const historyPath = join(gsdRoot(basePath), "doctor-history.jsonl");
    const errorCount = report.issues.filter(i => i.severity === "error").length;
    const warningCount = report.issues.filter(i => i.severity === "warning").length;
    const issueDetails = report.issues
      .filter(i => i.severity === "error" || i.severity === "warning")
      .slice(0, 10) // cap to keep JSONL lines bounded
      .map(i => ({ severity: i.severity, code: i.code, message: i.message, unitId: i.unitId }));

    // Human-readable one-line summary
    const summaryParts: string[] = [];
    if (report.ok) {
      summaryParts.push("Clean");
    } else {
      const counts: string[] = [];
      if (errorCount > 0) counts.push(`${errorCount} error${errorCount > 1 ? "s" : ""}`);
      if (warningCount > 0) counts.push(`${warningCount} warning${warningCount > 1 ? "s" : ""}`);
      summaryParts.push(counts.join(", "));
    }
    if (report.fixesApplied.length > 0) {
      summaryParts.push(`${report.fixesApplied.length} fixed`);
    }
    if (issueDetails.length > 0) {
      const topIssue = issueDetails.find(i => i.severity === "error") ?? issueDetails[0]!;
      summaryParts.push(topIssue.message);
    }

    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      ok: report.ok,
      errors: errorCount,
      warnings: warningCount,
      fixes: report.fixesApplied.length,
      codes: [...new Set(report.issues.map(i => i.code))],
      issues: issueDetails.length > 0 ? issueDetails : undefined,
      fixDescriptions: report.fixesApplied.length > 0 ? report.fixesApplied : undefined,
      scope: (report as any).scope as string | undefined,
      summary: summaryParts.join(" · "),
    } satisfies DoctorHistoryEntry);
    const existing = existsSync(historyPath) ? readFileSync(historyPath, "utf-8") : "";
    await saveFile(historyPath, existing + entry + "\n");
  } catch { /* non-fatal */ }
}

/** Read the last N doctor history entries. Returns most-recent-first. */
export async function readDoctorHistory(basePath: string, lastN = 50): Promise<DoctorHistoryEntry[]> {
  try {
    const historyPath = join(gsdRoot(basePath), "doctor-history.jsonl");
    if (!existsSync(historyPath)) return [];
    const lines = readFileSync(historyPath, "utf-8").split("\n").filter(l => l.trim());
    return lines.slice(-lastN).reverse().map(l => JSON.parse(l) as DoctorHistoryEntry);
  } catch { return []; }
}

export async function runGSDDoctor(basePath: string, options?: { fix?: boolean; dryRun?: boolean; scope?: string; fixLevel?: "task" | "all"; isolationMode?: "none" | "worktree" | "branch"; includeBuild?: boolean; includeTests?: boolean }): Promise<DoctorReport> {
  const issues: DoctorIssue[] = [];
  const fixesApplied: string[] = [];
  const fix = options?.fix === true;
  const dryRun = options?.dryRun === true;
  const fixLevel = options?.fixLevel ?? "all";

  // Issue codes that represent completion state transitions — creating summary
  // stubs, marking slices/milestones done in the roadmap. These belong to the
  // dispatch lifecycle (complete-slice, complete-milestone units), not to
  // mechanical post-hook bookkeeping. When fixLevel is "task", these are
  // detected and reported but never auto-fixed.

  /** Whether a given issue code should be auto-fixed at the current fixLevel. */
  const shouldFix = (code: DoctorIssueCode): boolean => {
    if (!fix || dryRun) return false;
    if (fixLevel === "task" && GLOBAL_STATE_CODES.has(code)) return false;
    return true;
  };

  const prefs = loadEffectiveGSDPreferences();
  if (prefs) {
    const prefIssues = validatePreferenceShape(prefs.preferences);
    for (const issue of prefIssues) {
      issues.push({
        severity: "warning",
        code: "invalid_preferences",
        scope: "project",
        unitId: "project",
        message: `GSD preferences invalid: ${issue}`,
        file: prefs.path,
        fixable: false,
      });
    }
  }

  // Git health checks — timed
  const t0git = Date.now();
  const isolationMode: "none" | "worktree" | "branch" = options?.isolationMode ??
    (prefs?.preferences?.git?.isolation === "worktree" ? "worktree" :
    prefs?.preferences?.git?.isolation === "branch" ? "branch" : "none");
  await checkGitHealth(basePath, issues, fixesApplied, shouldFix, isolationMode);
  const gitMs = Date.now() - t0git;

  // Runtime health checks — timed
  const t0runtime = Date.now();
  await checkRuntimeHealth(basePath, issues, fixesApplied, shouldFix);
  const runtimeMs = Date.now() - t0runtime;

  // Global health checks — cross-project state (e.g. orphaned project state dirs)
  await checkGlobalHealth(issues, fixesApplied, shouldFix);

  // Environment health checks — timed
  const t0env = Date.now();
  await checkEnvironmentHealth(basePath, issues, {
    includeRemote: !options?.scope,
    includeBuild: options?.includeBuild,
    includeTests: options?.includeTests,
  });
  const envMs = Date.now() - t0env;

  // Engine health checks — DB constraints and projection drift
  await checkEngineHealth(basePath, issues, fixesApplied);

  const milestonesPath = milestonesDir(basePath);
  if (!existsSync(milestonesPath)) {
    const report: DoctorReport = { ok: issues.every(i => i.severity !== "error"), basePath, issues, fixesApplied, timing: { git: gitMs, runtime: runtimeMs, environment: envMs, gsdState: 0 } };
    await appendDoctorHistory(basePath, report);
    return report;
  }

  const requirementsPath = resolveGsdRootFile(basePath, "REQUIREMENTS");
  const requirementsContent = await loadFile(requirementsPath);
  issues.push(...auditRequirements(requirementsContent));

  const state = await deriveState(basePath);

  // Provider / auth health checks — only relevant when there is active work to dispatch.
  // Skipped for idle projects (no active milestone) to avoid noise in environments
  // where CI/test runners have no API key configured.
  if (state.activeMilestone) {
    try {
      const providerResults = runProviderChecks();
      for (const result of providerResults) {
        if (!result.required) continue;
        if (result.status === "error") {
          issues.push({
            severity: "warning",
            code: "provider_key_missing",
            scope: "project",
            unitId: "project",
            message: result.message + (result.detail ? ` — ${result.detail}` : ""),
            fixable: false,
          });
        } else if (result.status === "warning") {
          issues.push({
            severity: "warning",
            code: "provider_key_backedoff",
            scope: "project",
            unitId: "project",
            message: result.message + (result.detail ? ` — ${result.detail}` : ""),
            fixable: false,
          });
        }
      }
    } catch {
      // Non-fatal — provider check failure should not block other checks
    }
  }

  for (const milestone of state.registry) {
    const milestoneId = milestone.id;
    const milestonePath = resolveMilestonePath(basePath, milestoneId);
    if (!milestonePath) continue;

    // Validate milestone title for delimiter characters that break state documents.
    const milestoneTitleIssue = validateTitle(milestone.title);
    if (milestoneTitleIssue) {
      const roadmapFile = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
      let wasFixed = false;
      if (shouldFix("delimiter_in_title") && roadmapFile) {
        try {
          const raw = readFileSync(roadmapFile, "utf-8");
          // Replace em/en dashes with " - " in the H1 title line only
          const sanitized = raw.replace(/^(# .*)$/m, (line) =>
            line.replace(/[\u2014\u2013]/g, "-"),
          );
          if (sanitized !== raw) {
            await saveFile(roadmapFile, sanitized);
            fixesApplied.push(`sanitized delimiter characters in ${milestoneId} title`);
            wasFixed = true;
          }
        } catch { /* non-fatal — report the warning below */ }
      }
      if (!wasFixed) {
        issues.push({
          severity: "warning",
          code: "delimiter_in_title",
          scope: "milestone",
          unitId: milestoneId,
          message: `Milestone ${milestoneId} ${milestoneTitleIssue}. Rename the milestone to remove these characters to prevent state corruption.`,
          file: relMilestoneFile(basePath, milestoneId, "ROADMAP"),
          fixable: true,
        });
      }
    }

    const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
    const roadmapContent = roadmapPath ? await loadFile(roadmapPath) : null;
    if (!roadmapContent) continue;

    // Normalize slices: prefer DB, fall back to parser
    type NormSlice = RoadmapSliceEntry & { pending?: boolean; skipped?: boolean };
    let slices: NormSlice[];
    if (isDbAvailable()) {
      const dbSlices = getMilestoneSlices(milestoneId);
      slices = dbSlices.map(s => ({
        id: s.id,
        title: s.title,
        done: isClosedStatus(s.status),
        pending: s.status === "pending",
        skipped: s.status === "skipped",
        risk: (s.risk || "medium") as RoadmapSliceEntry["risk"],
        depends: s.depends,
        demo: s.demo,
      }));
    } else {
      const activeMilestoneId = state.activeMilestone?.id;
      const activeSliceId = state.activeSlice?.id;
      slices = parseLegacyRoadmap(roadmapContent).slices.map(s => ({
        ...s,
        // Legacy roadmaps only encode done vs not-done. For doctor's
        // missing-directory checks, treat every undone slice except the
        // current active slice as effectively pending/unstarted.
        pending: !s.done && (milestoneId !== activeMilestoneId || s.id !== activeSliceId),
      }));
    }
    // Wrap in Roadmap-compatible shape for detectCircularDependencies
    const roadmap = { slices };

    // ── Circular dependency detection ──────────────────────────────────────
    for (const cycle of detectCircularDependencies(roadmap.slices)) {
      issues.push({
        severity: "error",
        code: "circular_slice_dependency",
        scope: "milestone",
        unitId: milestoneId,
        message: `Circular dependency detected: ${cycle.join(" → ")}`,
        file: relMilestoneFile(basePath, milestoneId, "ROADMAP"),
        fixable: false,
      });
    }

    // ── Orphaned slice directories ─────────────────────────────────────────
    try {
      const slicesDir = join(milestonePath, "slices");
      if (existsSync(slicesDir)) {
        const knownSliceIds = new Set(roadmap.slices.map(s => s.id));
        for (const entry of readdirSync(slicesDir)) {
          try {
            if (!lstatSync(join(slicesDir, entry)).isDirectory()) continue;
          } catch { continue; }
          if (!knownSliceIds.has(entry)) {
            issues.push({
              severity: "warning",
              code: "orphaned_slice_directory",
              scope: "milestone",
              unitId: milestoneId,
              message: `Directory "${entry}" exists in ${milestoneId}/slices/ but is not referenced in the roadmap`,
              file: `${relMilestonePath(basePath, milestoneId)}/slices/${entry}`,
              fixable: false,
            });
          }
        }
      }
    } catch { /* non-fatal */ }

    for (const slice of roadmap.slices) {
      const unitId = `${milestoneId}/${slice.id}`;
      if (options?.scope && !matchesScope(unitId, options.scope) && options.scope !== milestoneId) continue;

      // Validate slice title for delimiter characters.
      const sliceTitleIssue = validateTitle(slice.title);
      if (sliceTitleIssue) {
        // Slice titles live inside the roadmap H1/checkbox lines — the milestone-level
        // fix above already sanitizes the roadmap file. For slices we only report, because
        // the title comes from the checkbox text and requires careful regex to fix safely.
        issues.push({
          severity: "warning",
          code: "delimiter_in_title",
          scope: "slice",
          unitId,
          message: `Slice ${unitId} ${sliceTitleIssue}. Rename the slice to remove these characters to prevent state corruption.`,
          file: relMilestoneFile(basePath, milestoneId, "ROADMAP"),
          fixable: false,
        });
      }

      // Check for unresolvable dependency IDs
      const knownSliceIds = new Set(roadmap.slices.map(s => s.id));
      for (const dep of slice.depends) {
        if (!knownSliceIds.has(dep)) {
          issues.push({
            severity: "warning",
            code: "unresolvable_dependency",
            scope: "slice",
            unitId,
            message: `Slice ${unitId} depends on "${dep}" which is not a slice ID in this roadmap. This permanently blocks the slice. Use comma-separated IDs: \`depends:[S01,S02]\``,
            file: relMilestoneFile(basePath, milestoneId, "ROADMAP"),
            fixable: false,
          });
        }
      }

      const slicePath = resolveSlicePath(basePath, milestoneId, slice.id);
      if (!slicePath) {
        // Pending slices haven't been planned yet — directories are created
        // lazily by ensurePreconditions() at dispatch time. Skipped slices are
        // intentionally allowed to remain summary-less and directory-less.
        if (slice.pending || slice.skipped) continue;
        const expectedPath = relSlicePath(basePath, milestoneId, slice.id);
        issues.push({
          severity: slice.done ? "warning" : "error",
          code: "missing_slice_dir",
          scope: "slice",
          unitId,
          message: slice.done
            ? `Missing slice directory for ${unitId} (slice is complete — cosmetic only)`
            : `Missing slice directory for ${unitId}`,
          file: expectedPath,
          fixable: true,
        });
        if (fix) {
          const absoluteSliceDir = join(milestonePath, "slices", slice.id);
          mkdirSync(absoluteSliceDir, { recursive: true });
          fixesApplied.push(`created ${absoluteSliceDir}`);
        }
        continue;
      }

      const tasksDir = resolveTasksDir(basePath, milestoneId, slice.id);
      if (!tasksDir) {
        // Pending slices haven't been planned yet — tasks/ is created on demand.
        // Skipped slices may legitimately never create tasks/.
        if (slice.pending || slice.skipped) continue;
        issues.push({
          severity: slice.done ? "warning" : "error",
          code: "missing_tasks_dir",
          scope: "slice",
          unitId,
          message: slice.done
            ? `Missing tasks directory for ${unitId} (slice is complete \u2014 cosmetic only)`
            : `Missing tasks directory for ${unitId}`,
          file: relSlicePath(basePath, milestoneId, slice.id),
          fixable: true,
        });
        if (fix) {
          mkdirSync(join(slicePath, "tasks"), { recursive: true });
          fixesApplied.push(`created ${join(slicePath, "tasks")}`);
        }
      }

      const planPath = resolveSliceFile(basePath, milestoneId, slice.id, "PLAN");
      const planContent = planPath ? await loadFile(planPath) : null;
      // Normalize plan tasks: prefer DB, fall back to parsers-legacy
      let plan: { tasks: Array<{ id: string; done: boolean; title: string; estimate?: string }> } | null = null;
      if (isDbAvailable()) {
        const dbTasks = getSliceTasks(milestoneId, slice.id);
        if (dbTasks.length > 0) {
          plan = { tasks: dbTasks.map(t => ({ id: t.id, done: t.status === "complete" || t.status === "done", title: t.title, estimate: t.estimate || undefined })) };
        }
      }
      if (!plan && planContent) {
        plan = parseLegacyPlan(planContent);
      }
      if (!plan) {
        if (!slice.done) {
          issues.push({
            severity: "warning",
            code: "missing_slice_plan",
            scope: "slice",
            unitId,
            message: `Slice ${unitId} has no plan file`,
            file: relSliceFile(basePath, milestoneId, slice.id, "PLAN"),
            fixable: false,
          });
        }
        continue;
      }

      // ── Duplicate task IDs ───────────────────────────────────────────────
      const taskIdCounts = new Map<string, number>();
      for (const task of plan.tasks) taskIdCounts.set(task.id, (taskIdCounts.get(task.id) ?? 0) + 1);
      for (const [taskId, count] of taskIdCounts) {
        if (count > 1) {
          issues.push({ severity: "error", code: "duplicate_task_id", scope: "slice", unitId,
            message: `Task ID "${taskId}" appears ${count} times in ${slice.id}-PLAN.md — duplicate IDs cause dispatch failures`,
            file: relSliceFile(basePath, milestoneId, slice.id, "PLAN"), fixable: false });
        }
      }

      // ── Task files on disk not in plan ────────────────────────────────────
      try {
        if (tasksDir) {
          const planTaskIds = new Set(plan.tasks.map(t => t.id));
          for (const f of readdirSync(tasksDir)) {
            if (!f.endsWith("-SUMMARY.md")) continue;
            const diskTaskId = f.replace(/-SUMMARY\.md$/, "");
            if (!planTaskIds.has(diskTaskId)) {
              issues.push({ severity: "info", code: "task_file_not_in_plan", scope: "slice", unitId,
                message: `Task summary "${f}" exists on disk but "${diskTaskId}" is not in ${slice.id}-PLAN.md`,
                file: relTaskFile(basePath, milestoneId, slice.id, diskTaskId, "SUMMARY"), fixable: false });
            }
          }
        }
      } catch { /* non-fatal */ }

      let allTasksDone = plan.tasks.length > 0;
      for (const task of plan.tasks) {
        const taskUnitId = `${unitId}/${task.id}`;
        const summaryPath = resolveTaskFile(basePath, milestoneId, slice.id, task.id, "SUMMARY");
        const hasSummary = !!(summaryPath && await loadFile(summaryPath));

        // Must-have verification
        if (task.done && hasSummary) {
          const taskPlanPath = resolveTaskFile(basePath, milestoneId, slice.id, task.id, "PLAN");
          if (taskPlanPath) {
            const taskPlanContent = await loadFile(taskPlanPath);
            if (taskPlanContent) {
              const mustHaves = parseTaskPlanMustHaves(taskPlanContent);
              if (mustHaves.length > 0) {
                const summaryContent = await loadFile(summaryPath!);
                const mentionedCount = summaryContent
                  ? countMustHavesMentionedInSummary(mustHaves, summaryContent)
                  : 0;
                if (mentionedCount < mustHaves.length) {
                  issues.push({
                    severity: "warning",
                    code: "task_done_must_haves_not_verified",
                    scope: "task",
                    unitId: taskUnitId,
                    message: `Task ${task.id} has ${mustHaves.length} must-haves but summary addresses only ${mentionedCount}`,
                    file: relTaskFile(basePath, milestoneId, slice.id, task.id, "SUMMARY"),
                    fixable: false,
                  });
                }
              }
            }
          }
        }

        // ── Future timestamp check ─────────────────────────────────────
        if (task.done && hasSummary && summaryPath) {
          try {
            const rawSummary = await loadFile(summaryPath);
            const m = rawSummary?.match(/^completed_at:\s*(.+)$/m);
            if (m) {
              const ts = new Date(m[1].trim());
              if (!isNaN(ts.getTime()) && ts.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
                issues.push({ severity: "warning", code: "future_timestamp", scope: "task", unitId: taskUnitId,
                  message: `Task ${task.id} has completed_at "${m[1].trim()}" which is more than 24h in the future`,
                  file: relTaskFile(basePath, milestoneId, slice.id, task.id, "SUMMARY"), fixable: false });
              }
            }
          } catch { /* non-fatal */ }
        }

        allTasksDone = allTasksDone && task.done;
      }

      // Blocker-without-replan detection
      // Skip when all tasks are done — the blocker was implicitly resolved
      // within the task and the slice is not stuck (#3105 Bug 2).
      const replanPath = resolveSliceFile(basePath, milestoneId, slice.id, "REPLAN");
      if (!replanPath && !allTasksDone) {
        for (const task of plan.tasks) {
          if (!task.done) continue;
          const summaryPath = resolveTaskFile(basePath, milestoneId, slice.id, task.id, "SUMMARY");
          if (!summaryPath) continue;
          const summaryContent = await loadFile(summaryPath);
          if (!summaryContent) continue;
          const summary = parseSummary(summaryContent);
          if (summary.frontmatter.blocker_discovered) {
            issues.push({
              severity: "warning",
              code: "blocker_discovered_no_replan",
              scope: "slice",
              unitId,
              message: `Task ${task.id} reported blocker_discovered but no REPLAN.md exists for ${slice.id} \u2014 slice may be stuck`,
              file: relSliceFile(basePath, milestoneId, slice.id, "REPLAN"),
              fixable: false,
            });
            break;
          }
        }
      }

      // ── Stale REPLAN: exists but all tasks done ────────────────────────
      if (replanPath && allTasksDone) {
        issues.push({ severity: "info", code: "stale_replan_file", scope: "slice", unitId,
          message: `${slice.id} has a REPLAN.md but all tasks are done — REPLAN.md may be stale`,
          file: relSliceFile(basePath, milestoneId, slice.id, "REPLAN"), fixable: false });
      }

    }

    // Milestone-level check: all slices done but no validation file
    const milestoneComplete = roadmap.slices.length > 0 && roadmap.slices.every(s => s.done);
    if (milestoneComplete && !resolveMilestoneFile(basePath, milestoneId, "VALIDATION") && !resolveMilestoneFile(basePath, milestoneId, "SUMMARY")) {
      issues.push({
        severity: "info",
        code: "all_slices_done_missing_milestone_validation",
        scope: "milestone",
        unitId: milestoneId,
        message: `All slices are done but ${milestoneId}-VALIDATION.md is missing \u2014 milestone is in validating-milestone phase`,
        file: relMilestoneFile(basePath, milestoneId, "VALIDATION"),
        fixable: false,
      });
    }

    // Milestone-level check: all slices done but no milestone summary
    if (milestoneComplete && !resolveMilestoneFile(basePath, milestoneId, "SUMMARY")) {
      issues.push({
        severity: "warning",
        code: "all_slices_done_missing_milestone_summary",
        scope: "milestone",
        unitId: milestoneId,
        message: `All slices are done but ${milestoneId}-SUMMARY.md is missing \u2014 milestone is stuck in completing-milestone phase`,
        file: relMilestoneFile(basePath, milestoneId, "SUMMARY"),
        fixable: false,
      });
    }
  }

  if (fix && !dryRun && fixesApplied.length > 0) {
    await updateStateFile(basePath, fixesApplied);
  }

  const report: DoctorReport = {
    ok: issues.every(issue => issue.severity !== "error"),
    basePath,
    issues,
    fixesApplied,
    timing: { git: gitMs, runtime: runtimeMs, environment: envMs, gsdState: Math.max(0, Date.now() - t0env - envMs) },
  };
  await appendDoctorHistory(basePath, report);
  return report;
}
