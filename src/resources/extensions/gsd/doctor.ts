import { existsSync, mkdirSync } from "node:fs";
import { join, sep } from "node:path";

import { loadFile, parsePlan, parseRoadmap, parseSummary, saveFile, parseTaskPlanMustHaves, countMustHavesMentionedInSummary } from "./files.js";
import { resolveMilestoneFile, resolveMilestonePath, resolveSliceFile, resolveSlicePath, resolveTaskFile, resolveTaskFiles, resolveTasksDir, milestonesDir, gsdRoot, relMilestoneFile, relSliceFile, relTaskFile, relSlicePath, relGsdRootFile, resolveGsdRootFile } from "./paths.js";
import { deriveState, isMilestoneComplete } from "./state.js";
import { loadEffectiveGSDPreferences, type GSDPreferences } from "./preferences.js";
import { listWorktrees } from "./worktree-manager.js";
import { abortAndReset } from "./git-self-heal.js";
import { RUNTIME_EXCLUSION_PATHS } from "./git-service.js";
import { nativeIsRepo, nativeWorktreeRemove, nativeBranchList, nativeBranchDelete, nativeLsFiles, nativeRmCached } from "./native-git-bridge.js";

export type DoctorSeverity = "info" | "warning" | "error";
export type DoctorIssueCode =
  | "invalid_preferences"
  | "missing_tasks_dir"
  | "missing_slice_plan"
  | "task_done_missing_summary"
  | "task_summary_without_done_checkbox"
  | "all_tasks_done_missing_slice_summary"
  | "all_tasks_done_missing_slice_uat"
  | "all_tasks_done_roadmap_not_checked"
  | "slice_checked_missing_summary"
  | "slice_checked_missing_uat"
  | "all_slices_done_missing_milestone_summary"
  | "task_done_must_haves_not_verified"
  | "active_requirement_missing_owner"
  | "blocked_requirement_missing_reason"
  | "blocker_discovered_no_replan"
  | "delimiter_in_title"
  | "orphaned_auto_worktree"
  | "stale_milestone_branch"
  | "corrupt_merge_state"
  | "tracked_runtime_files"
  | "legacy_slice_branches";

export interface DoctorIssue {
  severity: DoctorSeverity;
  code: DoctorIssueCode;
  scope: "project" | "milestone" | "slice" | "task";
  unitId: string;
  message: string;
  file?: string;
  fixable: boolean;
}

export interface DoctorReport {
  ok: boolean;
  basePath: string;
  issues: DoctorIssue[];
  fixesApplied: string[];
}

export interface DoctorSummary {
  total: number;
  errors: number;
  warnings: number;
  infos: number;
  fixable: number;
  byCode: Array<{ code: DoctorIssueCode; count: number }>;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean);
  return items.length > 0 ? Array.from(new Set(items)) : undefined;
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

/**
 * Characters that are used as delimiters in GSD state management documents
 * and should not appear in milestone or slice titles.
 *
 * - "—" (em dash, U+2014): used as a display separator in STATE.md and other docs.
 *   A title containing "—" makes the separator ambiguous, corrupting state display
 *   and confusing the LLM agent that reads and writes these files.
 * - "–" (en dash, U+2013): visually similar to em dash; same ambiguity risk.
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

function buildStateMarkdown(state: Awaited<ReturnType<typeof deriveState>>): string {
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
    lines.push(`**Requirements Status:** ${state.requirements.active} active · ${state.requirements.validated} validated · ${state.requirements.deferred} deferred · ${state.requirements.outOfScope} out of scope`);
  }
  lines.push("");
  lines.push("## Milestone Registry");

  for (const entry of state.registry) {
    const glyph = entry.status === "complete" ? "✅" : entry.status === "active" ? "🔄" : "⬜";
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
  const state = await deriveState(basePath);
  const path = resolveGsdRootFile(basePath, "STATE");
  await saveFile(path, buildStateMarkdown(state));
}

async function ensureSliceSummaryStub(basePath: string, milestoneId: string, sliceId: string, fixesApplied: string[]): Promise<void> {
  const path = join(resolveSlicePath(basePath, milestoneId, sliceId) ?? relSlicePath(basePath, milestoneId, sliceId), `${sliceId}-SUMMARY.md`);
  const absolute = resolveSliceFile(basePath, milestoneId, sliceId, "SUMMARY") ?? join(resolveSlicePath(basePath, milestoneId, sliceId)!, `${sliceId}-SUMMARY.md`);
  const content = [
    "---",
    `id: ${sliceId}`,
    `parent: ${milestoneId}`,
    `milestone: ${milestoneId}`,
    "provides: []",
    "requires: []",
    "affects: []",
    "key_files: []",
    "key_decisions: []",
    "patterns_established: []",
    "observability_surfaces:",
    "  - none yet — doctor created placeholder summary; replace with real diagnostics before treating as complete",
    "drill_down_paths: []",
    "duration: unknown",
    "verification_result: unknown",
    `completed_at: ${new Date().toISOString()}`,
    "---",
    "",
    `# ${sliceId}: Recovery placeholder summary`,
    "",
    "**Doctor-created placeholder.**",
    "",
    "## What Happened",
    "Doctor detected that all tasks were complete but the slice summary was missing. Replace this with a real compressed slice summary before relying on it.",
    "",
    "## Verification",
    "Not re-run by doctor.",
    "",
    "## Deviations",
    "Recovery placeholder created to restore required artifact shape.",
    "",
    "## Known Limitations",
    "This file is intentionally incomplete and should be replaced by a real summary.",
    "",
    "## Follow-ups",
    "- Regenerate this summary from task summaries.",
    "",
    "## Files Created/Modified",
    `- \`${relSliceFile(basePath, milestoneId, sliceId, "SUMMARY")}\` — doctor-created placeholder summary`,
    "",
    "## Forward Intelligence",
    "",
    "### What the next slice should know",
    "- Doctor had to reconstruct completion artifacts; inspect task summaries before continuing.",
    "",
    "### What's fragile",
    "- Placeholder summary exists solely to unblock invariant checks.",
    "",
    "### Authoritative diagnostics",
    "- Task summaries in the slice tasks/ directory — they are the actual authoritative source until this summary is rewritten.",
    "",
    "### What assumptions changed",
    "- The system assumed completion would always write a slice summary; in practice doctor may need to restore missing artifacts.",
    "",
  ].join("\n");
  await saveFile(absolute, content);
  fixesApplied.push(`created placeholder ${absolute}`);
}

async function ensureSliceUatStub(basePath: string, milestoneId: string, sliceId: string, fixesApplied: string[]): Promise<void> {
  const sDir = resolveSlicePath(basePath, milestoneId, sliceId);
  if (!sDir) return;
  const absolute = join(sDir, `${sliceId}-UAT.md`);
  const content = [
    `# ${sliceId}: Recovery placeholder UAT`,
    "",
    `**Milestone:** ${milestoneId}`,
    `**Written:** ${new Date().toISOString()}`,
    "",
    "## Preconditions",
    "- Doctor created this placeholder because the expected UAT file was missing.",
    "",
    "## Smoke Test",
    "- Re-run the slice verification from the slice plan before shipping.",
    "",
    "## Test Cases",
    "### 1. Replace this placeholder",
    "1. Read the slice plan and task summaries.",
    "2. Write a real UAT script.",
    "3. **Expected:** This placeholder is replaced with meaningful human checks.",
    "",
    "## Edge Cases",
    "### Missing completion artifacts",
    "1. Confirm the summary, roadmap checkbox, and state file are coherent.",
    "2. **Expected:** GSD doctor reports no remaining completion drift for this slice.",
    "",
    "## Failure Signals",
    "- Placeholder content still present when treating the slice as done",
    "",
    "## Notes for Tester",
    "Doctor created this file only to restore the required artifact shape. Replace it with a real UAT script.",
    "",
  ].join("\n");
  await saveFile(absolute, content);
  fixesApplied.push(`created placeholder ${absolute}`);
}

async function markTaskDoneInPlan(basePath: string, milestoneId: string, sliceId: string, taskId: string, fixesApplied: string[]): Promise<void> {
  const planPath = resolveSliceFile(basePath, milestoneId, sliceId, "PLAN");
  if (!planPath) return;
  const content = await loadFile(planPath);
  if (!content) return;
  const updated = content.replace(new RegExp(`^-\\s+\\[ \\]\\s+\\*\\*${taskId}:`, "m"), `- [x] **${taskId}:`);
  if (updated !== content) {
    await saveFile(planPath, updated);
    fixesApplied.push(`marked ${taskId} done in ${planPath}`);
  }
}

async function markSliceDoneInRoadmap(basePath: string, milestoneId: string, sliceId: string, fixesApplied: string[]): Promise<void> {
  const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
  if (!roadmapPath) return;
  const content = await loadFile(roadmapPath);
  if (!content) return;
  const updated = content.replace(new RegExp(`^-\\s+\\[ \\]\\s+\\*\\*${sliceId}:`, "m"), `- [x] **${sliceId}:`);
  if (updated !== content) {
    await saveFile(roadmapPath, updated);
    fixesApplied.push(`marked ${sliceId} done in ${roadmapPath}`);
  }
}

function matchesScope(unitId: string, scope?: string): boolean {
  if (!scope) return true;
  return unitId === scope || unitId.startsWith(`${scope}/`) || unitId.startsWith(`${scope}`);
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
      issues.push({
        severity: "error",
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

export function summarizeDoctorIssues(issues: DoctorIssue[]): DoctorSummary {
  const errors = issues.filter(issue => issue.severity === "error").length;
  const warnings = issues.filter(issue => issue.severity === "warning").length;
  const infos = issues.filter(issue => issue.severity === "info").length;
  const fixable = issues.filter(issue => issue.fixable).length;
  const byCodeMap = new Map<DoctorIssueCode, number>();
  for (const issue of issues) {
    byCodeMap.set(issue.code, (byCodeMap.get(issue.code) ?? 0) + 1);
  }
  const byCode = [...byCodeMap.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  return { total: issues.length, errors, warnings, infos, fixable, byCode };
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
    const roadmap = parseRoadmap(roadmapContent);
    if (!isMilestoneComplete(roadmap)) return milestone.id;
  }

  return state.registry[0]?.id;
}

export function filterDoctorIssues(issues: DoctorIssue[], options?: { scope?: string; includeWarnings?: boolean; includeHistorical?: boolean }): DoctorIssue[] {
  let filtered = issues;
  if (options?.scope) filtered = filtered.filter(issue => matchesScope(issue.unitId, options.scope));
  if (!options?.includeWarnings) filtered = filtered.filter(issue => issue.severity === "error");
  return filtered;
}

export function formatDoctorReport(
  report: DoctorReport,
  options?: { scope?: string; includeWarnings?: boolean; maxIssues?: number; title?: string },
): string {
  const scopedIssues = filterDoctorIssues(report.issues, {
    scope: options?.scope,
    includeWarnings: options?.includeWarnings ?? true,
  });
  const summary = summarizeDoctorIssues(scopedIssues);
  const maxIssues = options?.maxIssues ?? 12;
  const lines: string[] = [];
  lines.push(options?.title ?? (summary.errors > 0 ? "GSD doctor found blocking issues." : "GSD doctor report."));
  lines.push(`Scope: ${options?.scope ?? "all milestones"}`);
  lines.push(`Issues: ${summary.total} total · ${summary.errors} error(s) · ${summary.warnings} warning(s) · ${summary.fixable} fixable`);

  if (summary.byCode.length > 0) {
    lines.push("Top issue types:");
    for (const item of summary.byCode.slice(0, 5)) {
      lines.push(`- ${item.code}: ${item.count}`);
    }
  }

  if (scopedIssues.length > 0) {
    lines.push("Priority issues:");
    for (const issue of scopedIssues.slice(0, maxIssues)) {
      const prefix = issue.severity === "error" ? "ERROR" : issue.severity === "warning" ? "WARN" : "INFO";
      lines.push(`- [${prefix}] ${issue.unitId}: ${issue.message}${issue.file ? ` (${issue.file})` : ""}`);
    }
    if (scopedIssues.length > maxIssues) {
      lines.push(`- ...and ${scopedIssues.length - maxIssues} more in scope`);
    }
  }

  if (report.fixesApplied.length > 0) {
    lines.push("Fixes applied:");
    for (const fix of report.fixesApplied.slice(0, maxIssues)) lines.push(`- ${fix}`);
    if (report.fixesApplied.length > maxIssues) lines.push(`- ...and ${report.fixesApplied.length - maxIssues} more`);
  }

  return lines.join("\n");
}

export function formatDoctorIssuesForPrompt(issues: DoctorIssue[]): string {
  if (issues.length === 0) return "- No remaining issues in scope.";
  return issues.map(issue => {
    const prefix = issue.severity === "error" ? "ERROR" : issue.severity === "warning" ? "WARN" : "INFO";
    return `- [${prefix}] ${issue.unitId} | ${issue.code} | ${issue.message}${issue.file ? ` | file: ${issue.file}` : ""} | fixable: ${issue.fixable ? "yes" : "no"}`;
  }).join("\n");
}

async function checkGitHealth(
  basePath: string,
  issues: DoctorIssue[],
  fixesApplied: string[],
  shouldFix: (code: DoctorIssueCode) => boolean,
): Promise<void> {
  // Degrade gracefully if not a git repo
  if (!nativeIsRepo(basePath)) {
    return; // Not a git repo — skip all git health checks
  }

  const gitDir = join(basePath, ".git");

  // ── Orphaned auto-worktrees ──────────────────────────────────────────
  try {
    const worktrees = listWorktrees(basePath);
    const milestoneWorktrees = worktrees.filter(wt => wt.branch.startsWith("milestone/"));

    // Load roadmap state once for cross-referencing
    const state = await deriveState(basePath);

    for (const wt of milestoneWorktrees) {
      // Extract milestone ID from branch name "milestone/M001" → "M001"
      const milestoneId = wt.branch.replace(/^milestone\//, "");
      const milestoneEntry = state.registry.find(m => m.id === milestoneId);

      // Check if milestone is complete via roadmap
      let isComplete = false;
      if (milestoneEntry) {
        const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
        const roadmapContent = roadmapPath ? await loadFile(roadmapPath) : null;
        if (roadmapContent) {
          const roadmap = parseRoadmap(roadmapContent);
          isComplete = isMilestoneComplete(roadmap);
        }
      }

      if (isComplete) {
        issues.push({
          severity: "warning",
          code: "orphaned_auto_worktree",
          scope: "milestone",
          unitId: milestoneId,
          message: `Worktree for completed milestone ${milestoneId} still exists at ${wt.path}`,
          fixable: true,
        });

        if (shouldFix("orphaned_auto_worktree")) {
          // Never remove a worktree matching current working directory
          const cwd = process.cwd();
          if (wt.path === cwd || cwd.startsWith(wt.path + sep)) {
            fixesApplied.push(`skipped removing worktree at ${wt.path} (is cwd)`);
          } else {
            try {
              nativeWorktreeRemove(basePath, wt.path, true);
              fixesApplied.push(`removed orphaned worktree ${wt.path}`);
            } catch {
              fixesApplied.push(`failed to remove worktree ${wt.path}`);
            }
          }
        }
      }
    }

    // ── Stale milestone branches ─────────────────────────────────────────
    try {
      const branches = nativeBranchList(basePath, "milestone/*");
      if (branches.length > 0) {
        const worktreeBranches = new Set(milestoneWorktrees.map(wt => wt.branch));

        for (const branch of branches) {
          // Skip branches that have a worktree (handled above)
          if (worktreeBranches.has(branch)) continue;

          const milestoneId = branch.replace(/^milestone\//, "");
          const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
          const roadmapContent = roadmapPath ? await loadFile(roadmapPath) : null;
          if (!roadmapContent) continue;

          const roadmap = parseRoadmap(roadmapContent);
          if (isMilestoneComplete(roadmap)) {
            issues.push({
              severity: "info",
              code: "stale_milestone_branch",
              scope: "milestone",
              unitId: milestoneId,
              message: `Branch ${branch} exists for completed milestone ${milestoneId}`,
              fixable: true,
            });

            if (shouldFix("stale_milestone_branch")) {
              try {
                nativeBranchDelete(basePath, branch, true);
                fixesApplied.push(`deleted stale branch ${branch}`);
              } catch {
                fixesApplied.push(`failed to delete branch ${branch}`);
              }
            }
          }
        }
      }
    } catch {
      // git branch list failed — skip stale branch check
    }
  } catch {
    // listWorktrees or deriveState failed — skip worktree/branch checks
  }

  // ── Corrupt merge state ────────────────────────────────────────────────
  try {
    const mergeStateFiles = ["MERGE_HEAD", "SQUASH_MSG"];
    const mergeStateDirs = ["rebase-apply", "rebase-merge"];
    const found: string[] = [];

    for (const f of mergeStateFiles) {
      if (existsSync(join(gitDir, f))) found.push(f);
    }
    for (const d of mergeStateDirs) {
      if (existsSync(join(gitDir, d))) found.push(d);
    }

    if (found.length > 0) {
      issues.push({
        severity: "error",
        code: "corrupt_merge_state",
        scope: "project",
        unitId: "project",
        message: `Corrupt merge/rebase state detected: ${found.join(", ")}`,
        fixable: true,
      });

      if (shouldFix("corrupt_merge_state")) {
        const result = abortAndReset(basePath);
        fixesApplied.push(`cleaned merge state: ${result.cleaned.join(", ")}`);
      }
    }
  } catch {
    // Can't check .git dir — skip
  }

  // ── Tracked runtime files ──────────────────────────────────────────────
  try {
    const trackedPaths: string[] = [];
    for (const exclusion of RUNTIME_EXCLUSION_PATHS) {
      try {
        const files = nativeLsFiles(basePath, exclusion);
        if (files.length > 0) {
          trackedPaths.push(...files);
        }
      } catch {
        // Individual ls-files can fail — continue
      }
    }

    if (trackedPaths.length > 0) {
      issues.push({
        severity: "warning",
        code: "tracked_runtime_files",
        scope: "project",
        unitId: "project",
        message: `${trackedPaths.length} runtime file(s) are tracked by git: ${trackedPaths.slice(0, 5).join(", ")}${trackedPaths.length > 5 ? "..." : ""}`,
        fixable: true,
      });

      if (shouldFix("tracked_runtime_files")) {
        try {
          for (const exclusion of RUNTIME_EXCLUSION_PATHS) {
            nativeRmCached(basePath, [exclusion]);
          }
          fixesApplied.push(`untracked ${trackedPaths.length} runtime file(s)`);
        } catch {
          fixesApplied.push("failed to untrack runtime files");
        }
      }
    }
  } catch {
    // git ls-files failed — skip
  }

  // ── Legacy slice branches ──────────────────────────────────────────────
  try {
    const branchList = nativeBranchList(basePath, "gsd/*/*");
    if (branchList.length > 0) {
      issues.push({
        severity: "info",
        code: "legacy_slice_branches",
        scope: "project",
        unitId: "project",
        message: `${branchList.length} legacy slice branch(es) found: ${branchList.slice(0, 3).join(", ")}${branchList.length > 3 ? "..." : ""}. These are no longer used (branchless architecture). Delete with: git branch -D ${branchList.join(" ")}`,
        fixable: false,
      });
    }
  } catch {
    // git branch list failed — skip
  }
}

export async function runGSDDoctor(basePath: string, options?: { fix?: boolean; scope?: string; fixLevel?: "task" | "all" }): Promise<DoctorReport> {
  const issues: DoctorIssue[] = [];
  const fixesApplied: string[] = [];
  const fix = options?.fix === true;
  const fixLevel = options?.fixLevel ?? "all";

  // Issue codes that represent completion state transitions — creating summary
  // stubs, marking slices/milestones done in the roadmap. These belong to the
  // dispatch lifecycle (complete-slice, complete-milestone units), not to
  // mechanical post-hook bookkeeping. When fixLevel is "task", these are
  // detected and reported but never auto-fixed.
  const completionTransitionCodes = new Set<DoctorIssueCode>([
    "all_tasks_done_missing_slice_summary",
    "all_tasks_done_missing_slice_uat",
    "all_tasks_done_roadmap_not_checked",
  ]);

  /** Whether a given issue code should be auto-fixed at the current fixLevel. */
  const shouldFix = (code: DoctorIssueCode): boolean => {
    if (!fix) return false;
    if (fixLevel === "task" && completionTransitionCodes.has(code)) return false;
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

  // Git health checks (orphaned worktrees, stale branches, corrupt merge state, tracked runtime files)
  await checkGitHealth(basePath, issues, fixesApplied, shouldFix);

  const milestonesPath = milestonesDir(basePath);
  if (!existsSync(milestonesPath)) {
    return { ok: issues.every(issue => issue.severity !== "error"), basePath, issues, fixesApplied };
  }

  const requirementsPath = resolveGsdRootFile(basePath, "REQUIREMENTS");
  const requirementsContent = await loadFile(requirementsPath);
  issues.push(...auditRequirements(requirementsContent));

  const state = await deriveState(basePath);
  for (const milestone of state.registry) {
    const milestoneId = milestone.id;
    const milestonePath = resolveMilestonePath(basePath, milestoneId);
    if (!milestonePath) continue;

    // Validate milestone title for delimiter characters that break state documents.
    const milestoneTitleIssue = validateTitle(milestone.title);
    if (milestoneTitleIssue) {
      issues.push({
        severity: "warning",
        code: "delimiter_in_title",
        scope: "milestone",
        unitId: milestoneId,
        message: `Milestone ${milestoneId} ${milestoneTitleIssue}. Rename the milestone to remove these characters to prevent state corruption.`,
        file: relMilestoneFile(basePath, milestoneId, "ROADMAP"),
        fixable: false,
      });
    }

    const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
    const roadmapContent = roadmapPath ? await loadFile(roadmapPath) : null;
    if (!roadmapContent) continue;
    const roadmap = parseRoadmap(roadmapContent);

    for (const slice of roadmap.slices) {
      const unitId = `${milestoneId}/${slice.id}`;
      if (options?.scope && !matchesScope(unitId, options.scope) && options.scope !== milestoneId) continue;

      // Validate slice title for delimiter characters.
      const sliceTitleIssue = validateTitle(slice.title);
      if (sliceTitleIssue) {
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

      const slicePath = resolveSlicePath(basePath, milestoneId, slice.id);
      if (!slicePath) continue;

      const tasksDir = resolveTasksDir(basePath, milestoneId, slice.id);
      if (!tasksDir) {
        issues.push({
          severity: "error",
          code: "missing_tasks_dir",
          scope: "slice",
          unitId,
          message: `Missing tasks directory for ${unitId}`,
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
      const plan = planContent ? parsePlan(planContent) : null;
      if (!plan) {
        issues.push({
          severity: "warning",
          code: "missing_slice_plan",
          scope: "slice",
          unitId,
          message: `Slice ${unitId} has no plan file`,
          file: relSliceFile(basePath, milestoneId, slice.id, "PLAN"),
          fixable: false,
        });
        continue;
      }

      let allTasksDone = plan.tasks.length > 0;
      for (const task of plan.tasks) {
        const taskUnitId = `${unitId}/${task.id}`;
        const summaryPath = resolveTaskFile(basePath, milestoneId, slice.id, task.id, "SUMMARY");
        const hasSummary = !!(summaryPath && await loadFile(summaryPath));

        if (task.done && !hasSummary) {
          issues.push({
            severity: "error",
            code: "task_done_missing_summary",
            scope: "task",
            unitId: taskUnitId,
            message: `Task ${task.id} is marked done but summary is missing`,
            file: relTaskFile(basePath, milestoneId, slice.id, task.id, "SUMMARY"),
            fixable: false,
          });
        }

        if (!task.done && hasSummary) {
          issues.push({
            severity: "warning",
            code: "task_summary_without_done_checkbox",
            scope: "task",
            unitId: taskUnitId,
            message: `Task ${task.id} has a summary but is not marked done in the slice plan`,
            file: relSliceFile(basePath, milestoneId, slice.id, "PLAN"),
            fixable: true,
          });
          if (fix) await markTaskDoneInPlan(basePath, milestoneId, slice.id, task.id, fixesApplied);
        }

        // Must-have verification: done task with summary — check if must-haves are addressed
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

        allTasksDone = allTasksDone && task.done;
      }

      // Blocker-without-replan detection: a completed task reported blocker_discovered
      // but no REPLAN.md exists yet — the slice is stuck
      const replanPath = resolveSliceFile(basePath, milestoneId, slice.id, "REPLAN");
      if (!replanPath) {
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
              message: `Task ${task.id} reported blocker_discovered but no REPLAN.md exists for ${slice.id} — slice may be stuck`,
              file: relSliceFile(basePath, milestoneId, slice.id, "REPLAN"),
              fixable: false,
            });
            break; // one issue per slice is sufficient
          }
        }
      }

      const sliceSummaryPath = resolveSliceFile(basePath, milestoneId, slice.id, "SUMMARY");
      const sliceUatPath = join(slicePath, `${slice.id}-UAT.md`);
      const hasSliceSummary = !!(sliceSummaryPath && await loadFile(sliceSummaryPath));
      const hasSliceUat = existsSync(sliceUatPath);

      if (allTasksDone && !hasSliceSummary) {
        issues.push({
          severity: "error",
          code: "all_tasks_done_missing_slice_summary",
          scope: "slice",
          unitId,
          message: `All tasks are done but ${slice.id}-SUMMARY.md is missing`,
          file: relSliceFile(basePath, milestoneId, slice.id, "SUMMARY"),
          fixable: true,
        });
        if (shouldFix("all_tasks_done_missing_slice_summary")) await ensureSliceSummaryStub(basePath, milestoneId, slice.id, fixesApplied);
      }

      if (allTasksDone && !hasSliceUat) {
        issues.push({
          severity: "warning",
          code: "all_tasks_done_missing_slice_uat",
          scope: "slice",
          unitId,
          message: `All tasks are done but ${slice.id}-UAT.md is missing`,
          file: `${relSlicePath(basePath, milestoneId, slice.id)}/${slice.id}-UAT.md`,
          fixable: true,
        });
        if (shouldFix("all_tasks_done_missing_slice_uat")) await ensureSliceUatStub(basePath, milestoneId, slice.id, fixesApplied);
      }

      if (allTasksDone && !slice.done) {
        issues.push({
          severity: "error",
          code: "all_tasks_done_roadmap_not_checked",
          scope: "slice",
          unitId,
          message: `All tasks are done but roadmap still shows ${slice.id} as incomplete`,
          file: relMilestoneFile(basePath, milestoneId, "ROADMAP"),
          fixable: true,
        });
        if (shouldFix("all_tasks_done_roadmap_not_checked") && (hasSliceSummary || issues.some(issue => issue.code === "all_tasks_done_missing_slice_summary" && issue.unitId === unitId))) {
          await markSliceDoneInRoadmap(basePath, milestoneId, slice.id, fixesApplied);
        }
      }

      if (slice.done && !hasSliceSummary) {
        issues.push({
          severity: "error",
          code: "slice_checked_missing_summary",
          scope: "slice",
          unitId,
          message: `Roadmap marks ${slice.id} complete but slice summary is missing`,
          file: relSliceFile(basePath, milestoneId, slice.id, "SUMMARY"),
          fixable: true,
        });
      }

      if (slice.done && !hasSliceUat) {
        issues.push({
          severity: "warning",
          code: "slice_checked_missing_uat",
          scope: "slice",
          unitId,
          message: `Roadmap marks ${slice.id} complete but UAT file is missing`,
          file: `${relSlicePath(basePath, milestoneId, slice.id)}/${slice.id}-UAT.md`,
          fixable: true,
        });
      }
    }

    // Milestone-level check: all slices done but no milestone summary
    if (isMilestoneComplete(roadmap) && !resolveMilestoneFile(basePath, milestoneId, "SUMMARY")) {
      issues.push({
        severity: "warning",
        code: "all_slices_done_missing_milestone_summary",
        scope: "milestone",
        unitId: milestoneId,
        message: `All slices are done but ${milestoneId}-SUMMARY.md is missing — milestone is stuck in completing-milestone phase`,
        file: relMilestoneFile(basePath, milestoneId, "SUMMARY"),
        fixable: false,
      });
    }
  }

  if (fix && fixesApplied.length > 0) {
    await updateStateFile(basePath, fixesApplied);
  }

  return {
    ok: issues.every(issue => issue.severity !== "error"),
    basePath,
    issues,
    fixesApplied,
  };
}

