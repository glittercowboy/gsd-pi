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
