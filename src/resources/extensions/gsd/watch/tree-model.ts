// GSD Watch — Tree data model: filesystem scan, status derivation, badge detection
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MilestoneNode, PhaseNode, PlanNode, NodeStatus } from "./types.js";

// ─── Badge Suffixes ───────────────────────────────────────────────────────────

/**
 * The 7 lifecycle badge suffixes in display order:
 * [CONTEXT, RESEARCH, UI-SPEC, PLAN, SUMMARY, VERIFICATION, HUMAN-UAT]
 *
 * A badge is "active" when any file in the phase directory ends with the suffix.
 */
export const BADGE_SUFFIXES = [
  "-CONTEXT.md",
  "-RESEARCH.md",
  "-UI-SPEC.md",
  "-PLAN.md",
  "-SUMMARY.md",
  "-VERIFICATION.md",
  "-HUMAN-UAT.md",
] as const;

// ─── Badge Detection ──────────────────────────────────────────────────────────

/**
 * Detect which lifecycle badges are present for a phase.
 * Returns a 7-element boolean array corresponding to BADGE_SUFFIXES.
 */
export function detectBadges(phaseFiles: string[]): boolean[] {
  return BADGE_SUFFIXES.map((suffix) =>
    phaseFiles.some((file) => file.endsWith(suffix))
  );
}

// ─── Label Humanization ───────────────────────────────────────────────────────

/**
 * Humanize the text portion of a phase dir name.
 * E.g. "03-core-renderer" -> "Core Renderer"
 */
export function humanizePhaseLabel(dirName: string): string {
  const withoutPrefix = dirName.replace(/^\d+-/, "");
  return withoutPrefix
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Format a phase dir name as a numbered label.
 * E.g. "03-core-renderer" -> "3. Core Renderer"
 */
export function formatPhaseLabel(dirName: string): string {
  const num = parseInt(dirName.split("-")[0], 10);
  return `${num}. ${humanizePhaseLabel(dirName)}`;
}

// ─── Status Derivation ────────────────────────────────────────────────────────

/**
 * Derive plan status from whether a summary file exists.
 * - If phaseFiles contains a file ending in `${planId}-SUMMARY.md` -> "done"
 * - Otherwise -> "active" (plan file exists means it's at least active)
 */
export function derivePlanStatus(
  planId: string,
  phaseFiles: string[]
): NodeStatus {
  const summaryFile = `${planId}-SUMMARY.md`;
  if (phaseFiles.some((file) => file.endsWith(summaryFile))) {
    return "done";
  }
  return "active";
}

/**
 * Derive phase status from its plans.
 * - No plans -> "pending"
 * - All plans done -> "done"
 * - Any active -> "active"
 */
export function derivePhaseStatus(
  plans: PlanNode[],
  badges: boolean[]
): NodeStatus {
  if (plans.length === 0) return "pending";
  if (plans.every((p) => p.status === "done")) return "done";
  return "active";
}

/**
 * Derive milestone status from its phases using worst-case roll-up (per D-11).
 * - No phases -> "pending"
 * - Any blocked -> "blocked"
 * - Any active -> "active"
 * - All done -> "done"
 * - Otherwise -> "pending"
 */
export function deriveMilestoneStatus(phases: PhaseNode[]): NodeStatus {
  if (phases.length === 0) return "pending";
  if (phases.some((p) => p.status === "blocked")) return "blocked";
  if (phases.some((p) => p.status === "active")) return "active";
  if (phases.every((p) => p.status === "done")) return "done";
  return "pending";
}

// ─── Plan Scanning ────────────────────────────────────────────────────────────

/**
 * Scan a phase directory for plan files and return sorted PlanNode array.
 * Only files matching /^\d{2}-\d{2}-PLAN\.md$/ are included.
 */
export function scanPlans(phaseDir: string, phaseFiles: string[]): PlanNode[] {
  const planFiles = phaseFiles
    .filter((file) => /^\d{2}-\d{2}-PLAN\.md$/.test(file))
    .sort();

  return planFiles.map((file) => {
    // Extract plan ID: "03-01" from "03-01-PLAN.md"
    const planId = file.replace(/-PLAN\.md$/, "");
    // Extract zero-padded plan number for label: "01" from "03-01"
    const planNumber = planId.split("-")[1];
    const label = `Plan ${planNumber}`;
    const status = derivePlanStatus(planId, phaseFiles);
    const hasSummary = phaseFiles.some((f) => f.endsWith(`${planId}-SUMMARY.md`));

    return { id: planId, label, status, hasSummary };
  });
}

// ─── Milestone Label ──────────────────────────────────────────────────────────

/**
 * Read the milestone label from ROADMAP.md.
 * Looks for the first heading line and extracts text after "—" or "–" if present.
 * Falls back to "Project" if file not found or parse fails.
 */
export function readMilestoneLabel(projectRoot: string): string {
  try {
    const roadmapPath = join(projectRoot, ".planning", "ROADMAP.md");
    if (!existsSync(roadmapPath)) return "Project";
    const content = readFileSync(roadmapPath, "utf-8");
    const match = content.match(/^#\s+(.+)$/m);
    if (match && match[1]) {
      const heading = match[1].trim();
      // Extract text after em-dash or en-dash if present
      const dashMatch = heading.match(/[—–]\s*(.+)$/);
      if (dashMatch && dashMatch[1]) {
        return dashMatch[1].trim();
      }
      return heading;
    }
  } catch {
    // Fall through to default
  }
  return "Project";
}

// ─── Main Export ─────────────────────────────────────────────────────────────

/**
 * Build the milestone tree by scanning the .planning/phases/ directory.
 *
 * Returns a typed MilestoneNode with:
 * - phases sorted by numeric prefix
 * - 7-element badge arrays derived from file presence
 * - plan/phase/milestone status derived from filesystem state
 */
export function buildMilestoneTree(projectRoot: string): MilestoneNode {
  const phasesDir = join(projectRoot, ".planning", "phases");
  const label = readMilestoneLabel(projectRoot);

  if (!existsSync(phasesDir)) {
    return { label, status: "pending", phases: [] };
  }

  const phaseDirents = readdirSync(phasesDir, { withFileTypes: true })
    .filter(
      (dirent) =>
        dirent.isDirectory() && /^\d{2}-/.test(dirent.name)
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  const phases: PhaseNode[] = phaseDirents.map((dirent) => {
    const phaseDir = join(phasesDir, dirent.name);
    const phaseFiles = readdirSync(phaseDir);
    const badges = detectBadges(phaseFiles);
    const plans = scanPlans(phaseDir, phaseFiles);
    const status = derivePhaseStatus(plans, badges);
    const number = parseInt(dirent.name.split("-")[0], 10);
    const phaseLabel = formatPhaseLabel(dirent.name);

    return {
      number,
      dirName: dirent.name,
      label: phaseLabel,
      status,
      badges,
      plans,
    };
  });

  const milestoneStatus = deriveMilestoneStatus(phases);

  return { label, status: milestoneStatus, phases };
}
