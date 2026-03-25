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
} from "./gsd-db.js";
import type { MilestoneRow, SliceRow, TaskRow } from "./gsd-db.js";
import { atomicWriteSync } from "./atomic-write.js";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { logWarning } from "./workflow-logger.js";
import { deriveState } from "./state.js";
import type { GSDState } from "./types.js";

// ─── PLAN.md Projection ──────────────────────────────────────────────────

/**
 * Render PLAN.md content from a slice row and its task rows.
 * Pure function — no side effects.
 */
export function renderPlanContent(sliceRow: SliceRow, taskRows: TaskRow[]): string {
  const lines: string[] = [];

  lines.push(`# ${sliceRow.id}: ${sliceRow.title}`);
  lines.push("");
  lines.push(`**Goal:** ${sliceRow.goal || sliceRow.full_summary_md || "TBD"}`);
  lines.push(`**Demo:** After this: ${sliceRow.demo || sliceRow.full_uat_md || "TBD"}`);
  lines.push("");
  lines.push("## Tasks");

  for (const task of taskRows) {
    const checkbox = task.status === "done" || task.status === "complete" ? "[x]" : "[ ]";
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

  lines.push(`# ${milestoneRow.id}: ${milestoneRow.title}`);
  lines.push("");
  lines.push("## Vision");
  lines.push(milestoneRow.vision || milestoneRow.title || "TBD");
  lines.push("");
  lines.push("## Slice Overview");
  lines.push("| ID | Slice | Risk | Depends | Done | After this |");
  lines.push("|----|-------|------|---------|------|------------|");

  for (const slice of sliceRows) {
    const done = slice.status === "done" || slice.status === "complete" ? "\u2705" : "\u2B1C";

    // depends is already parsed to string[] by rowToSlice
    let depends = "\u2014";
    if (slice.depends && slice.depends.length > 0) {
      depends = slice.depends.join(", ");
    }

    const risk = (slice.risk || "low").toLowerCase();
    const demo = slice.demo || slice.full_uat_md || "TBD";

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
 * Pure function — no side effects.
 */
export function renderSummaryContent(taskRow: TaskRow, sliceId: string, milestoneId: string): string {
  const lines: string[] = [];

  // Frontmatter
  lines.push("---");
  lines.push(`id: ${taskRow.id}`);
  lines.push(`parent: ${sliceId}`);
  lines.push(`milestone: ${milestoneId}`);
  lines.push("provides: []");
  lines.push("requires: []");
  lines.push("affects: []");

  // key_files is already parsed to string[]
  if (taskRow.key_files && taskRow.key_files.length > 0) {
    lines.push(`key_files: [${taskRow.key_files.map(f => `"${f}"`).join(", ")}]`);
  } else {
    lines.push("key_files: []");
  }

  // key_decisions is already parsed to string[]
  if (taskRow.key_decisions && taskRow.key_decisions.length > 0) {
    lines.push(`key_decisions: [${taskRow.key_decisions.map(d => `"${d}"`).join(", ")}]`);
  } else {
    lines.push("key_decisions: []");
  }

  lines.push("patterns_established: []");
  lines.push("drill_down_paths: []");
  lines.push("observability_surfaces: []");
  lines.push(`duration: "${taskRow.duration || ""}"`);
  lines.push(`verification_result: "${taskRow.verification_result || ""}"`);
  lines.push(`completed_at: ${taskRow.completed_at || ""}`);
  lines.push(`blocker_discovered: ${taskRow.blocker_discovered ? "true" : "false"}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${taskRow.id}: ${taskRow.title}`);
  lines.push("");

  // One-liner (if present)
  if (taskRow.one_liner) {
    lines.push(`> ${taskRow.one_liner}`);
    lines.push("");
  }

  lines.push("## What Happened");
  lines.push(taskRow.full_summary_md || taskRow.narrative || "No summary recorded.");
  lines.push("");

  // Deviations (if present)
  if (taskRow.deviations) {
    lines.push("## Deviations");
    lines.push(taskRow.deviations);
    lines.push("");
  }

  // Known issues (if present)
  if (taskRow.known_issues) {
    lines.push("## Known Issues");
    lines.push(taskRow.known_issues);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Render SUMMARY.md projection to disk for a specific task.
 * Queries DB via helper functions, renders content, writes via atomicWriteSync.
 */
export function renderSummaryProjection(basePath: string, milestoneId: string, sliceId: string, taskId: string): void {
  const taskRows = getSliceTasks(milestoneId, sliceId);
  const taskRow = taskRows.find(t => t.id === taskId);
  if (!taskRow) return;

  const content = renderSummaryContent(taskRow, sliceId, milestoneId);
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
    try { adapter.prepare("SELECT 1").get(); } catch { return; }
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
  // Render ROADMAP.md for the milestone
  try {
    renderRoadmapProjection(basePath, milestoneId);
  } catch (err) {
    console.error(`[projections] renderRoadmapProjection failed for ${milestoneId}:`, err);
  }

  // Query all slices for this milestone
  const sliceRows = getMilestoneSlices(milestoneId);

  for (const slice of sliceRows) {
    // Render PLAN.md for each slice
    try {
      renderPlanProjection(basePath, milestoneId, slice.id);
    } catch (err) {
      console.error(`[projections] renderPlanProjection failed for ${milestoneId}/${slice.id}:`, err);
    }

    // Render SUMMARY.md for each completed task
    const taskRows = getSliceTasks(milestoneId, slice.id);
    const doneTasks = taskRows.filter(t => t.status === "done");

    for (const task of doneTasks) {
      try {
        renderSummaryProjection(basePath, milestoneId, slice.id, task.id);
      } catch (err) {
        console.error(`[projections] renderSummaryProjection failed for ${milestoneId}/${slice.id}/${task.id}:`, err);
      }
    }
  }

  // Render STATE.md
  try {
    await renderStateProjection(basePath);
  } catch (err) {
    console.error("[projections] renderStateProjection failed:", err);
  }
}

// ─── regenerateIfMissing ────────────────────────────────────────────────

/**
 * Check if a projection file exists on disk. If missing, regenerate it from DB.
 * Returns true if the file was regenerated, false if it already existed.
 * Satisfies PROJ-05 (corrupted/deleted projections regenerate on demand).
 */
export function regenerateIfMissing(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  fileType: "PLAN" | "ROADMAP" | "SUMMARY" | "STATE",
): boolean {
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
    // Special handling: check if the tasks directory exists and has summary files
    if (!existsSync(filePath)) {
      // Regenerate all task summaries for this slice
      const taskRows = getSliceTasks(milestoneId, sliceId);
      const doneTasks = taskRows.filter(t => t.status === "done");
      for (const task of doneTasks) {
        try {
          renderSummaryProjection(basePath, milestoneId, sliceId, task.id);
        } catch (err) {
          console.error(`[projections] regenerateIfMissing SUMMARY failed for ${task.id}:`, err);
        }
      }
      return doneTasks.length > 0;
    }
    return false;
  }

  if (existsSync(filePath)) {
    return false;
  }

  // Regenerate the missing file
  try {
    switch (fileType) {
      case "PLAN":
        renderPlanProjection(basePath, milestoneId, sliceId);
        break;
      case "ROADMAP":
        renderRoadmapProjection(basePath, milestoneId);
        break;
      case "STATE":
        // renderStateProjection is async but regenerateIfMissing is sync.
        // Fire-and-forget the async render; STATE.md will appear shortly.
        void renderStateProjection(basePath);
        break;
    }
    return true;
  } catch (err) {
    console.error(`[projections] regenerateIfMissing ${fileType} failed:`, err);
    return false;
  }
}
