// GSD Extension — Projection Renderers (DB -> Markdown)
// Renders PLAN.md, ROADMAP.md, SUMMARY.md, and STATE.md from database rows.
// Projections are read-only views of engine state (Layer 3 of the architecture).
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { _getAdapter } from "./gsd-db.js";
import { atomicWriteSync } from "./atomic-write.js";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

import type { MilestoneRow, SliceRow, TaskRow } from "./workflow-engine.js";
import type { GSDState, MilestoneRegistryEntry } from "./types.js";

// ─── PLAN.md Projection ──────────────────────────────────────────────────

/**
 * Render PLAN.md content from a slice row and its task rows.
 * Pure function — no side effects.
 */
export function renderPlanContent(sliceRow: SliceRow, taskRows: TaskRow[]): string {
  const lines: string[] = [];

  lines.push(`# ${sliceRow.id}: ${sliceRow.title}`);
  lines.push("");
  lines.push(`**Goal:** ${sliceRow.summary || "TBD"}`);
  lines.push(`**Demo:** After this: ${sliceRow.uat_result || "TBD"}`);
  lines.push("");
  lines.push("## Tasks");

  for (const task of taskRows) {
    const checkbox = task.status === "done" ? "[x]" : "[ ]";
    lines.push(`- ${checkbox} **${task.id}:** ${task.title} \u2014 ${task.description}`);

    // Estimate subline (always present if non-empty)
    if (task.estimate) {
      lines.push(`  - Estimate: ${task.estimate}`);
    }

    // Files subline (only if non-empty array)
    try {
      const files: string[] = JSON.parse(task.files || "[]");
      if (files.length > 0) {
        lines.push(`  - Files: ${files.join(", ")}`);
      }
    } catch {
      // Malformed JSON — skip Files line
    }

    // Verify subline (only if non-null)
    if (task.verify) {
      lines.push(`  - Verify: ${task.verify}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Render PLAN.md projection to disk for a specific slice.
 * Queries DB, renders content, writes via atomicWriteSync.
 */
export function renderPlanProjection(basePath: string, milestoneId: string, sliceId: string): void {
  const db = _getAdapter();
  if (!db) return;

  const sliceRow = db
    .prepare("SELECT * FROM slices WHERE milestone_id = ? AND id = ?")
    .get(milestoneId, sliceId) as unknown as SliceRow | undefined;
  if (!sliceRow) return;

  const taskRows = db
    .prepare("SELECT * FROM tasks WHERE milestone_id = ? AND slice_id = ? ORDER BY seq, id")
    .all(milestoneId, sliceId) as unknown as TaskRow[];

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
  lines.push(milestoneRow.title || "TBD");
  lines.push("");
  lines.push("## Slice Overview");
  lines.push("| ID | Slice | Risk | Depends | Done | After this |");
  lines.push("|----|-------|------|---------|------|------------|");

  for (const slice of sliceRows) {
    const done = slice.status === "done" ? "\u2705" : "\u2B1C";

    // Parse depends_on JSON array
    let depends = "\u2014";
    try {
      const depArr: string[] = JSON.parse(slice.depends_on || "[]");
      if (depArr.length > 0) {
        depends = depArr.join(", ");
      }
    } catch {
      // Malformed JSON — show em dash
    }

    const risk = (slice.risk || "low").toLowerCase();
    const demo = slice.uat_result || "TBD";

    lines.push(`| ${slice.id} | ${slice.title} | ${risk} | ${depends} | ${done} | ${demo} |`);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Render ROADMAP.md projection to disk for a specific milestone.
 * Queries DB, renders content, writes via atomicWriteSync.
 */
export function renderRoadmapProjection(basePath: string, milestoneId: string): void {
  const db = _getAdapter();
  if (!db) return;

  const milestoneRow = db
    .prepare("SELECT * FROM milestones WHERE id = ?")
    .get(milestoneId) as unknown as MilestoneRow | undefined;
  if (!milestoneRow) return;

  const sliceRows = db
    .prepare("SELECT * FROM slices WHERE milestone_id = ? ORDER BY seq, id")
    .all(milestoneId) as unknown as SliceRow[];

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
  lines.push("key_files: []");
  lines.push("key_decisions: []");
  lines.push("patterns_established: []");
  lines.push("drill_down_paths: []");
  lines.push("observability_surfaces: []");
  lines.push('duration: ""');
  lines.push('verification_result: ""');
  lines.push(`completed_at: ${taskRow.completed_at || ""}`);
  lines.push("blocker_discovered: false");
  lines.push("---");
  lines.push("");
  lines.push(`# ${taskRow.id}: ${taskRow.title}`);
  lines.push("");
  lines.push("## What Happened");
  lines.push(taskRow.summary || "No summary recorded.");
  lines.push("");

  return lines.join("\n");
}

/**
 * Render SUMMARY.md projection to disk for a specific task.
 * Queries DB, renders content, writes via atomicWriteSync.
 */
export function renderSummaryProjection(basePath: string, milestoneId: string, sliceId: string, taskId: string): void {
  const db = _getAdapter();
  if (!db) return;

  const taskRow = db
    .prepare("SELECT * FROM tasks WHERE milestone_id = ? AND slice_id = ? AND id = ?")
    .get(milestoneId, sliceId, taskId) as unknown as TaskRow | undefined;
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
 * Derives state from engine, renders content, writes via atomicWriteSync.
 */
export function renderStateProjection(basePath: string): void {
  try {
    // Dynamic import to avoid circular dependency at module level
    const { getEngine } = require("./workflow-engine.js") as typeof import("./workflow-engine.js");
    const engine = getEngine(basePath);
    const state = engine.deriveState();
    const content = renderStateContent(state);
    const dir = join(basePath, ".gsd");
    mkdirSync(dir, { recursive: true });
    atomicWriteSync(join(dir, "STATE.md"), content);
  } catch (err) {
    // Non-fatal per D-02 — projection failure should not block
    console.error("[projections] renderStateProjection failed:", err);
  }
}

// ─── renderAllProjections ───────────────────────────────────────────────

/**
 * Regenerate all projection files for a milestone from DB state.
 * All calls are wrapped in try/catch — projection failure is non-fatal per D-02.
 */
export function renderAllProjections(basePath: string, milestoneId: string): void {
  const db = _getAdapter();
  if (!db) return;

  // Render ROADMAP.md for the milestone
  try {
    renderRoadmapProjection(basePath, milestoneId);
  } catch (err) {
    console.error(`[projections] renderRoadmapProjection failed for ${milestoneId}:`, err);
  }

  // Query all slices for this milestone
  const sliceRows = db
    .prepare("SELECT * FROM slices WHERE milestone_id = ? ORDER BY seq, id")
    .all(milestoneId) as unknown as SliceRow[];

  for (const slice of sliceRows) {
    // Render PLAN.md for each slice
    try {
      renderPlanProjection(basePath, milestoneId, slice.id);
    } catch (err) {
      console.error(`[projections] renderPlanProjection failed for ${milestoneId}/${slice.id}:`, err);
    }

    // Render SUMMARY.md for each completed task
    const taskRows = db
      .prepare("SELECT * FROM tasks WHERE milestone_id = ? AND slice_id = ? AND status = 'done' ORDER BY seq, id")
      .all(milestoneId, slice.id) as unknown as TaskRow[];

    for (const task of taskRows) {
      try {
        renderSummaryProjection(basePath, milestoneId, slice.id, task.id);
      } catch (err) {
        console.error(`[projections] renderSummaryProjection failed for ${milestoneId}/${slice.id}/${task.id}:`, err);
      }
    }
  }

  // Render STATE.md
  try {
    renderStateProjection(basePath);
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
      const db = _getAdapter();
      if (!db) return false;
      const taskRows = db
        .prepare("SELECT * FROM tasks WHERE milestone_id = ? AND slice_id = ? AND status = 'done' ORDER BY seq, id")
        .all(milestoneId, sliceId) as unknown as TaskRow[];
      for (const task of taskRows) {
        try {
          renderSummaryProjection(basePath, milestoneId, sliceId, task.id);
        } catch (err) {
          console.error(`[projections] regenerateIfMissing SUMMARY failed for ${task.id}:`, err);
        }
      }
      return taskRows.length > 0;
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
        renderStateProjection(basePath);
        break;
    }
    return true;
  } catch (err) {
    console.error(`[projections] regenerateIfMissing ${fileType} failed:`, err);
    return false;
  }
}
