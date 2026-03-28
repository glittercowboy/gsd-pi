// GSD Watch — Tree data model: DB-first status, filesystem fallback, badge detection
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MilestoneNode, PhaseNode, PlanNode, NodeStatus } from "./types.js";
import { mapDbStatus } from "./types.js";

// ─── Plan Label Extraction ──────────────────────────────────────────────────

/**
 * Extract a human-readable plan label from a PLAN.md file.
 * Reads the first line of the <objective> block if present.
 * Falls back to "Plan NN" if no objective found or file unreadable.
 */
export function extractPlanLabel(planFilePath: string, fallback: string): string {
  try {
    const content = readFileSync(planFilePath, "utf-8");
    const match = content.match(/<objective>\s*\n(.+)/);
    if (match && match[1]) {
      const line = match[1].trim();
      // Strip leading markdown formatting (e.g. "## " or "### ")
      const cleaned = line.replace(/^#+\s*/, "");
      if (cleaned.length > 0) return cleaned;
    }
  } catch {
    // Fall through to fallback
  }
  return fallback;
}

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

// ─── Status Derivation (filesystem fallback) ─────────────────────────────────

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

// ─── Plan Scanning (filesystem fallback) ─────────────────────────────────────

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
    const fallback = `Plan ${planNumber}`;
    const label = extractPlanLabel(join(phaseDir, file), fallback);
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

// ─── Filesystem Tree Builder (fallback) ──────────────────────────────────────

/**
 * Build the milestone tree by scanning the .planning/phases/ directory.
 * Used when no GSD database is available.
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

// ─── DB → Phase Dir Matching ─────────────────────────────────────────────────

/**
 * Normalize a title string to match filesystem phase dir format.
 * "Test Infrastructure Foundation" → "test-infrastructure-foundation"
 */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/**
 * Build a lookup map from normalized phase dir name → dir entry for badge detection.
 * Keys are the name portion after the numeric prefix (e.g. "test-infrastructure-foundation").
 */
function buildPhaseDirMap(phasesDir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(phasesDir)) return map;
  try {
    const entries = readdirSync(phasesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && /^\d{2}-/.test(entry.name)) {
        const normalized = entry.name.replace(/^\d+-/, "");
        map.set(normalized, entry.name);
      }
    }
  } catch {
    // Non-fatal — badges will be empty
  }
  return map;
}

/**
 * Try to find the matching filesystem phase directory for a DB slice title.
 * Returns the directory name (e.g. "20-test-infrastructure-foundation") or null.
 */
function matchSliceToPhaseDir(sliceTitle: string, phaseDirMap: Map<string, string>): string | null {
  const normalized = normalizeTitle(sliceTitle);
  return phaseDirMap.get(normalized) ?? null;
}

/**
 * Get badges for a slice by finding its matching filesystem phase directory.
 * Returns 7-element boolean array, all false if no match found.
 */
function getBadgesForSlice(sliceTitle: string, phasesDir: string, phaseDirMap: Map<string, string>): boolean[] {
  const dirName = matchSliceToPhaseDir(sliceTitle, phaseDirMap);
  if (!dirName) return [false, false, false, false, false, false, false];
  try {
    const phaseDir = join(phasesDir, dirName);
    const phaseFiles = readdirSync(phaseDir);
    return detectBadges(phaseFiles);
  } catch {
    return [false, false, false, false, false, false, false];
  }
}

// ─── DB-backed Tree Builder ──────────────────────────────────────────────────

/** Interface for DB query results to avoid importing full gsd-db types. */
interface DbMilestone { id: string; title: string; status: string; }
interface DbSlice { milestone_id: string; id: string; title: string; status: string; }
interface DbTask { milestone_id: string; slice_id: string; id: string; title: string; status: string; }

/** Query callback type — injected by the renderer to avoid circular imports. */
export interface DbQueries {
  getAllMilestones(): DbMilestone[];
  getMilestoneSlices(milestoneId: string): DbSlice[];
  getSliceTasks(milestoneId: string, sliceId: string): DbTask[];
}

/**
 * Build the project tree from the GSD database.
 * Returns milestones in display order: active first, then completed (newest first).
 */
export function buildProjectTreeFromDb(
  queries: DbQueries,
  projectRoot: string
): MilestoneNode[] {
  const phasesDir = join(projectRoot, ".planning", "phases");
  const phaseDirMap = buildPhaseDirMap(phasesDir);
  const allMilestones = queries.getAllMilestones();

  // Chronological order: completed milestones first, active at bottom
  // Natural reading order — history flows downward, active work is always last

  return allMilestones.map((m) => {
    const slices = queries.getMilestoneSlices(m.id);
    const phases: PhaseNode[] = slices.map((s, idx) => {
      const tasks = queries.getSliceTasks(m.id, s.id);
      const badges = getBadgesForSlice(s.title, phasesDir, phaseDirMap);
      const dirName = matchSliceToPhaseDir(s.title, phaseDirMap) ?? `${m.id}-${s.id}`;

      const plans: PlanNode[] = tasks.map((t) => ({
        id: `${m.id}-${s.id}-${t.id}`,
        label: t.title,
        status: mapDbStatus(t.status),
        hasSummary: t.status === "complete" || t.status === "done",
      }));

      return {
        number: idx + 1,
        dirName,
        label: `${s.id}: ${s.title}`,
        status: mapDbStatus(s.status),
        badges,
        plans,
      };
    });

    return {
      label: m.title,
      status: mapDbStatus(m.status),
      phases,
    };
  });
}

/**
 * Build the full project tree.
 * Tries DB first (source of truth), falls back to filesystem scanning.
 * Returns an array of MilestoneNodes — one per milestone from DB, or a single
 * filesystem-derived milestone when no DB is available.
 */
export function buildProjectTree(
  projectRoot: string,
  dbQueries: DbQueries | null
): MilestoneNode[] {
  if (dbQueries) {
    const milestones = buildProjectTreeFromDb(dbQueries, projectRoot);
    if (milestones.length > 0) return milestones;
  }
  // Fallback: filesystem-only project
  return [buildMilestoneTree(projectRoot)];
}
