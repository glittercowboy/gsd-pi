// GSD Extension — Projection Renderers (DB -> Markdown)
// Renders PLAN.md, ROADMAP.md, SUMMARY.md, and STATE.md from database rows.
// Projections are read-only views of engine state (Layer 3 of the architecture).

import {
  _getAdapter,
  isDbAvailable,
  getAllMilestones,
  getMilestone,
  getMilestoneSlices,
  getSliceTasks,
  getVerificationEvidence,
} from "./gsd-db.js";
import type { MilestoneRow, SliceRow, TaskRow, VerificationEvidenceRow } from "./gsd-db.js";
import { atomicWriteSync } from "./atomic-write.js";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { logWarning } from "./workflow-logger.js";
import { isClosedStatus } from "./status-guards.js";
import { deriveState } from "./state.js";
import type { GSDState } from "./types.js";
import { renderRoadmapFromDb } from "./markdown-renderer.js";

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Strip a leading ID prefix (e.g. "M001: " or "S04: ") from a title
 * to prevent double-prefixing when the renderer adds its own prefix.
 * Handles repeated prefixes (e.g. "M001: M001: M001: Title" → "Title").
 */
export function stripIdPrefix(title: string, id: string): string {
  const prefix = `${id}: `;
  let result = title;
  while (result.startsWith(prefix)) {
    result = result.slice(prefix.length);
  }
  return result.trim() || title;
}

// ─── PLAN.md Projection ──────────────────────────────────────────────────

/**
 * Render PLAN.md content from a slice row and its task rows.
 * Pure function — no side effects.
 */
export function renderPlanContent(sliceRow: SliceRow, taskRows: TaskRow[]): string {
  const lines: string[] = [];

  const displayTitle = stripIdPrefix(sliceRow.title, sliceRow.id);
  lines.push(`# ${sliceRow.id}: ${displayTitle}`);
  lines.push("");
  // #2945: never use full_summary_md/full_uat_md as display fallbacks —
  // they contain multi-line rendered markdown that corrupts single-line fields.
  lines.push(`**Goal:** ${sliceRow.goal || "TBD"}`);
  lines.push(`**Demo:** After this: ${sliceRow.demo || "TBD"}`);
  lines.push("");
  lines.push("## Tasks");

  for (const task of taskRows) {
    const checkbox = isClosedStatus(task.status) ? "[x]" : "[ ]";
    lines.push(`- ${checkbox} **${task.id}: ${task.title}** \u2014 ${task.description}`);

    // Estimate subline (always present if non-empty)
    if (task.estimate) {
      lines.push(`  - Estimate: ${task.estimate}`);
    }

    // Files subline (only if non-empty array)
    if (task.files && task.files.length > 0) {
      lines.push(`  - Files: ${task.files.join(", ")}`);
    }

    // Verify subline (only if non-null)
    if (task.verify) {
      lines.push(`  - Verify: ${task.verify}`);
    }

    // Duration subline (only if recorded)
    if (task.duration) {
      lines.push(`  - Duration: ${task.duration}`);
    }

    // Blocker subline (if discovered)
    if (task.blocker_discovered && task.known_issues) {
      lines.push(`  - Blocker: ${task.known_issues}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Render PLAN.md projection to disk for a specific slice.
 * Queries DB via helper functions, renders content, writes via atomicWriteSync.
 */
export function renderPlanProjection(basePath: string, milestoneId: string, sliceId: string): void {
  const sliceRows = getMilestoneSlices(milestoneId);
  const sliceRow = sliceRows.find(s => s.id === sliceId);
  if (!sliceRow) return;

  const taskRows = getSliceTasks(milestoneId, sliceId);

  const content = renderPlanContent(sliceRow, taskRows);
  const dir = join(basePath, ".gsd", "milestones", milestoneId, "slices", sliceId);
  mkdirSync(dir, { recursive: true });
  atomicWriteSync(join(dir, `${sliceId}-PLAN.md`), content);
}

// ─── ROADMAP.md Projection ───────────────────────────────────────────────

/**
 * Render ROADMAP.md content from a milestone row and its slice rows.
 * Pure function — no side effects.
 */
export function renderRoadmapContent(milestoneRow: MilestoneRow, sliceRows: SliceRow[]): string {
  const lines: string[] = [];

  const displayTitle = stripIdPrefix(milestoneRow.title, milestoneRow.id);
  lines.push(`# ${milestoneRow.id}: ${displayTitle}`);
  lines.push("");
  lines.push("## Vision");
  lines.push(milestoneRow.vision || milestoneRow.title || "TBD");
  lines.push("");
  lines.push("## Slice Overview");
  lines.push("| ID | Slice | Risk | Depends | Done | After this |");
  lines.push("|----|-------|------|---------|------|------------|");

  for (const slice of sliceRows) {
    const done = isClosedStatus(slice.status) ? "\u2705" : "\u2B1C";

    // depends is already parsed to string[] by rowToSlice
    let depends = "\u2014";
    if (slice.depends && slice.depends.length > 0) {
      depends = slice.depends.join(", ");
    }

    const risk = (slice.risk || "low").toLowerCase();
    // #2945 Bug 1: never use full_uat_md as a table cell fallback — it contains
    // multi-line UAT content (preconditions, steps, expected results) that
    // corrupts the markdown table and makes subsequent slices invisible.
    const demo = slice.demo || "TBD";

    lines.push(`| ${slice.id} | ${slice.title} | ${risk} | ${depends} | ${done} | ${demo} |`);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Render ROADMAP.md projection to disk for a specific milestone.
 * Queries DB via helper functions, renders content, writes via atomicWriteSync.
 */
export function renderRoadmapProjection(basePath: string, milestoneId: string): void {
  const milestoneRow = getMilestone(milestoneId);
  if (!milestoneRow) return;

  const sliceRows = getMilestoneSlices(milestoneId);

  const content = renderRoadmapContent(milestoneRow, sliceRows);
  const dir = join(basePath, ".gsd", "milestones", milestoneId);
  mkdirSync(dir, { recursive: true });
  atomicWriteSync(join(dir, `${milestoneId}-ROADMAP.md`), content);
}

// ─── SUMMARY.md Projection ──────────────────────────────────────────────

/**
 * Render SUMMARY.md content from a task row.
 * Single source of truth for summary rendering — used both at completion
 * time and at projection regeneration time (#2720).
 *
 * @param evidence - Optional verification evidence rows. When called from
 *   complete-task, these are passed directly. When called from projection
 *   regeneration, they are queried from the DB by renderSummaryProjection.
 */
export function renderSummaryContent(
  taskRow: TaskRow,
  sliceId: string,
  milestoneId: string,
  evidence?: Array<{ command: string; exitCode?: number; exit_code?: number; verdict: string; durationMs?: number; duration_ms?: number }>,
): string {
  // If the task already has a fully rendered summary (written by handleCompleteTask's
  // renderSummaryMarkdown), use it as-is. That content already includes frontmatter,
  // heading, and all sections. Re-wrapping it inside a second frontmatter/heading
  // envelope produces double frontmatter and duplicate sections.
  if (taskRow.full_summary_md && taskRow.full_summary_md.trimStart().startsWith("---")) {
    return taskRow.full_summary_md;
  }

  // ── Frontmatter (YAML list format, matches parseSummary() expectations) ──
  const keyFilesYaml = taskRow.key_files && taskRow.key_files.length > 0
    ? taskRow.key_files.map(f => `  - ${f}`).join("\n")
    : "  - (none)";
  const keyDecisionsYaml = taskRow.key_decisions && taskRow.key_decisions.length > 0
    ? taskRow.key_decisions.map(d => `  - ${d}`).join("\n")
    : "  - (none)";

  // Derive verification_result from evidence if available
  const evidenceList = evidence ?? [];
  const allPassed = evidenceList.length > 0 &&
    evidenceList.every(e => {
      const code = e.exitCode ?? e.exit_code ?? -1;
      return code === 0 || e.verdict.includes("\u2705") || e.verdict.toLowerCase().includes("pass");
    });
  const verificationResult = taskRow.verification_result
    ? (allPassed ? "passed" : (evidenceList.length === 0 ? "untested" : "mixed"))
    : (allPassed ? "passed" : (evidenceList.length === 0 ? "untested" : "mixed"));

  // Build verification evidence table
  let evidenceTable = "| # | Command | Exit Code | Verdict | Duration |\n|---|---------|-----------|---------|----------|\n";
  if (evidenceList.length > 0) {
    evidenceList.forEach((e, i) => {
      const code = e.exitCode ?? e.exit_code ?? 0;
      const dur = e.durationMs ?? e.duration_ms ?? 0;
      evidenceTable += `| ${i + 1} | \`${e.command}\` | ${code} | ${e.verdict} | ${dur}ms |\n`;
    });
  } else {
    evidenceTable += "| \u2014 | No verification commands discovered | \u2014 | \u2014 | \u2014 |\n";
  }

  const title = taskRow.one_liner || taskRow.title || taskRow.id;

  return `---
id: ${taskRow.id}
parent: ${sliceId}
milestone: ${milestoneId}
key_files:
${keyFilesYaml}
key_decisions:
${keyDecisionsYaml}
duration: ${taskRow.duration || ""}
verification_result: ${verificationResult}
completed_at: ${taskRow.completed_at || ""}
blocker_discovered: ${taskRow.blocker_discovered ? "true" : "false"}
---

# ${taskRow.id}: ${title}

**${taskRow.one_liner || ""}**

## What Happened

${taskRow.narrative || "No summary recorded."}

## Verification

${taskRow.verification_result || "No verification recorded."}

## Verification Evidence

${evidenceTable}
## Deviations

${taskRow.deviations || "None."}

## Known Issues

${taskRow.known_issues || "None."}

## Files Created/Modified

${taskRow.key_files && taskRow.key_files.length > 0 ? taskRow.key_files.map(f => `- \`${f}\``).join("\n") : "None."}
`;
}

/**
 * Render SUMMARY.md projection to disk for a specific task.
 * Queries DB via helper functions, renders content, writes via atomicWriteSync.
 */
export function renderSummaryProjection(basePath: string, milestoneId: string, sliceId: string, taskId: string): void {
  const taskRows = getSliceTasks(milestoneId, sliceId);
  const taskRow = taskRows.find(t => t.id === taskId);
  if (!taskRow) return;

  const evidenceRows = getVerificationEvidence(milestoneId, sliceId, taskId);
  const content = renderSummaryContent(taskRow, sliceId, milestoneId, evidenceRows);
  const dir = join(basePath, ".gsd", "milestones", milestoneId, "slices", sliceId, "tasks");
  mkdirSync(dir, { recursive: true });
  atomicWriteSync(join(dir, `${taskId}-SUMMARY.md`), content);
}

// ─── STATE.md Projection ────────────────────────────────────────────────

/**
 * Render STATE.md content from GSDState.
 * Matches the buildStateMarkdown output format from doctor.ts exactly.
 * Pure function — no side effects.
 */
export function renderStateContent(state: GSDState): string {
  const lines: string[] = [];
  lines.push("# GSD State", "");

  const activeSlice = state.activeSlice
    ? `${state.activeSlice.id}: ${stripIdPrefix(state.activeSlice.title, state.activeSlice.id)}`
    : "None";

  if (state.phase === 'complete' && state.lastCompletedMilestone) {
    lines.push(`**Last Completed Milestone:** ${state.lastCompletedMilestone.id}: ${state.lastCompletedMilestone.title}`);
  } else {
    const activeMilestone = state.activeMilestone
      ? `${state.activeMilestone.id}: ${stripIdPrefix(state.activeMilestone.title, state.activeMilestone.id)}`
      : "None";
    lines.push(`**Active Milestone:** ${activeMilestone}`);
  }
  lines.push(`**Active Slice:** ${activeSlice}`);
  lines.push(`**Phase:** ${state.phase}`);
  if (state.requirements) {
    lines.push(`**Requirements Status:** ${state.requirements.active} active \u00b7 ${state.requirements.validated} validated \u00b7 ${state.requirements.deferred} deferred \u00b7 ${state.requirements.outOfScope} out of scope`);
  }
  lines.push("");
  lines.push("## Milestone Registry");

  for (const entry of state.registry) {
    const glyph = entry.status === "complete" ? "\u2705" : entry.status === "active" ? "\uD83D\uDD04" : entry.status === "parked" ? "\u23F8\uFE0F" : "\u2B1C";
    lines.push(`- ${glyph} **${entry.id}:** ${stripIdPrefix(entry.title, entry.id)}`);
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

/**
 * Render STATE.md projection to disk.
 * Derives state from DB, renders content, writes via atomicWriteSync.
 */
export async function renderStateProjection(basePath: string): Promise<void> {
  try {
    if (!isDbAvailable()) return;
    // Probe DB handle — adapter may be set but underlying handle closed
    const adapter = _getAdapter();
    if (!adapter) return;
    try {
      adapter.prepare("SELECT 1").get();
    } catch (err) {
      logWarning("projection", "renderStateProjection: DB handle probe failed, skipping render", {
        error: (err as Error).message,
      });
      return;
    }
    const state = await deriveState(basePath);
    const content = renderStateContent(state);
    const dir = join(basePath, ".gsd");
    mkdirSync(dir, { recursive: true });
    atomicWriteSync(join(dir, "STATE.md"), content);
  } catch (err) {
    logWarning("projection", `renderStateProjection failed: ${(err as Error).message}`);
  }
}

// ─── renderAllProjections ───────────────────────────────────────────────

/**
 * Regenerate all projection files for a milestone from DB state.
 * All calls are wrapped in try/catch — projection failure is non-fatal per D-02.
 */
export async function renderAllProjections(basePath: string, milestoneId: string): Promise<void> {
  // Delegate to the authoritative roadmap renderer — the reduced
  // renderRoadmapProjection omits sections like ## Boundary Map and would
  // clobber the output written by plan-milestone / reassess-roadmap.
  try {
    await renderRoadmapFromDb(basePath, milestoneId);
  } catch (err) {
    logWarning("projection", `renderRoadmapFromDb failed for ${milestoneId}: ${(err as Error).message}`);
  }

  // Query all slices for this milestone
  const sliceRows = getMilestoneSlices(milestoneId);

  for (const slice of sliceRows) {
    // PLAN.md is rendered by the authoritative markdown-renderer.js in
    // plan-slice/replan-slice tools. Do NOT overwrite it here — the simplified
    // projection is missing key sections (Must-Haves, Verification, Files
    // Likely Touched) and corrupts multi-line task descriptions (#3651).

    // Render SUMMARY.md for each completed task
    const taskRows = getSliceTasks(milestoneId, slice.id);
    const doneTasks = taskRows.filter(t => t.status === "done" || t.status === "complete");

    for (const task of doneTasks) {
      try {
        renderSummaryProjection(basePath, milestoneId, slice.id, task.id);
      } catch (err) {
        logWarning("projection", `renderSummaryProjection failed for ${milestoneId}/${slice.id}/${task.id}: ${(err as Error).message}`);
      }
    }
  }

  // Render STATE.md
  try {
    await renderStateProjection(basePath);
  } catch (err) {
    logWarning("projection", `renderStateProjection failed: ${(err as Error).message}`);
  }
}

// ─── regenerateIfMissing ────────────────────────────────────────────────

/**
 * Check if a projection file exists on disk. If missing, regenerate it from DB.
 * Returns true if the file was regenerated, false if it already existed or
 * regeneration failed.
 * Satisfies PROJ-05 (corrupted/deleted projections regenerate on demand).
 */
export async function regenerateIfMissing(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  fileType: "PLAN" | "ROADMAP" | "SUMMARY" | "STATE",
): Promise<boolean> {
  let filePath: string;

  switch (fileType) {
    case "PLAN":
      filePath = join(basePath, ".gsd", "milestones", milestoneId, "slices", sliceId, `${sliceId}-PLAN.md`);
      break;
    case "ROADMAP":
      filePath = join(basePath, ".gsd", "milestones", milestoneId, `${milestoneId}-ROADMAP.md`);
      break;
    case "SUMMARY":
      // For SUMMARY, we regenerate all task summaries in the slice
      filePath = join(basePath, ".gsd", "milestones", milestoneId, "slices", sliceId, "tasks");
      break;
    case "STATE":
      filePath = join(basePath, ".gsd", "STATE.md");
      break;
  }

  if (fileType === "SUMMARY") {
    // Check each completed task's SUMMARY file individually (not just the directory)
    const taskRows = getSliceTasks(milestoneId, sliceId);
    const doneTasks = taskRows.filter(t => t.status === "done" || t.status === "complete");
    let regenerated = 0;
    for (const task of doneTasks) {
      const summaryPath = join(basePath, ".gsd", "milestones", milestoneId, "slices", sliceId, "tasks", `${task.id}-SUMMARY.md`);
      if (!existsSync(summaryPath)) {
        try {
          renderSummaryProjection(basePath, milestoneId, sliceId, task.id);
          regenerated++;
        } catch (err) {
          logWarning("projection", `regenerateIfMissing SUMMARY failed for ${task.id}: ${(err as Error).message}`);
        }
      }
    }
    return regenerated > 0;
  }

  if (existsSync(filePath)) {
    return false;
  }

  // Regenerate the missing file. Each renderer may swallow its own errors
  // (e.g. renderStateProjection), so confirm the file actually exists on
  // disk before reporting success — true must mean "file is there now".
  try {
    switch (fileType) {
      case "PLAN":
        renderPlanProjection(basePath, milestoneId, sliceId);
        return existsSync(filePath);
      case "ROADMAP":
        await renderRoadmapFromDb(basePath, milestoneId);
        return existsSync(filePath);
      case "STATE":
        await renderStateProjection(basePath);
        return existsSync(filePath);
    }
  } catch (err) {
    logWarning("projection", `regenerateIfMissing ${fileType} failed: ${(err as Error).message}`);
    return false;
  }
}
