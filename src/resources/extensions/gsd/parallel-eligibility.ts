/**
 * GSD Parallel Eligibility — Milestone parallelism analysis.
 *
 * Analyzes which milestones can safely run in parallel by checking
 * dependency satisfaction and file overlap across slice plans.
 */

import { deriveState } from "./state.js";
import { resolveMilestoneFile, resolveSliceFile } from "./paths.js";
import { findMilestoneIds } from "./guided-flow.js";
import { isDbAvailable, getMilestoneSlices, getSliceTasks } from "./gsd-db.js";
import type { MilestoneRegistryEntry } from "./types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EligibilityResult {
  milestoneId: string;
  title: string;
  eligible: boolean;
  reason: string;
}

export interface ParallelCandidates {
  eligible: EligibilityResult[];
  ineligible: EligibilityResult[];
  fileOverlaps: Array<{ mid1: string; mid2: string; files: string[] }>;
}

// ─── File Collection ─────────────────────────────────────────────────────────

/**
 * Collect all `filesLikelyTouched` across every slice plan in a milestone.
 * Returns a deduplicated list of file paths.
 */
async function collectTouchedFiles(
  basePath: string,
  milestoneId: string,
): Promise<string[]> {
  const files = new Set<string>();

  if (isDbAvailable()) {
    // DB path: query slices and their tasks for file lists
    const slices = getMilestoneSlices(milestoneId);
    for (const slice of slices) {
      const tasks = getSliceTasks(milestoneId, slice.id);
      for (const task of tasks) {
        if (Array.isArray(task.files)) {
          for (const f of task.files) {
            files.add(f);
          }
        }
      }
    }
  }
  // When DB unavailable, return empty file set — parallel eligibility cannot be determined

  return [...files];
}

// ─── Overlap Detection ──────────────────────────────────────────────────────

/**
 * Compare file sets across milestones and return pairs with overlapping files.
 */
function detectFileOverlaps(
  fileSets: Map<string, string[]>,
): Array<{ mid1: string; mid2: string; files: string[] }> {
  const overlaps: Array<{ mid1: string; mid2: string; files: string[] }> = [];
  const ids = [...fileSets.keys()];

  for (let i = 0; i < ids.length; i++) {
    const files1 = new Set(fileSets.get(ids[i])!);
    for (let j = i + 1; j < ids.length; j++) {
      const files2 = fileSets.get(ids[j])!;
      const shared = files2.filter(f => files1.has(f));
      if (shared.length > 0) {
        overlaps.push({ mid1: ids[i], mid2: ids[j], files: shared.sort() });
      }
    }
  }

  return overlaps;
}

// ─── Analysis ────────────────────────────────────────────────────────────────

/**
 * Analyze milestones for parallel execution eligibility.
 *
 * A milestone is eligible if:
 * 1. It is not complete
 * 2. Its dependencies (`dependsOn`) are all complete
 * 3. It does not have file overlap with other eligible milestones
 *    (overlaps are flagged as warnings but do not disqualify)
 */
export async function analyzeParallelEligibility(
  basePath: string,
): Promise<ParallelCandidates> {
  const milestoneIds = findMilestoneIds(basePath);
  const state = await deriveState(basePath);
  const registry = state.registry;

  // Build a lookup for quick status checks
  const registryMap = new Map<string, MilestoneRegistryEntry>();
  for (const entry of registry) {
    registryMap.set(entry.id, entry);
  }

  const eligible: EligibilityResult[] = [];
  const ineligible: EligibilityResult[] = [];

  for (const mid of milestoneIds) {
    const entry = registryMap.get(mid);
    const title = entry?.title ?? mid;
    const status = entry?.status ?? "pending";

    // Rule 1: skip complete and parked milestones
    if (status === "complete" || status === "parked") {
      ineligible.push({
        milestoneId: mid,
        title,
        eligible: false,
        reason: status === "parked" ? "Milestone is parked." : "Already complete.",
      });
      continue;
    }

    // Rule 2: check dependency satisfaction
    const deps = entry?.dependsOn ?? [];
    const unsatisfied = deps.filter(dep => {
      const depEntry = registryMap.get(dep);
      return !depEntry || depEntry.status !== "complete";
    });

    if (unsatisfied.length > 0) {
      ineligible.push({
        milestoneId: mid,
        title,
        eligible: false,
        reason: `Blocked by incomplete dependencies: ${unsatisfied.join(", ")}.`,
      });
      continue;
    }

    eligible.push({
      milestoneId: mid,
      title,
      eligible: true,
      reason: "All dependencies satisfied.",
    });
  }

  // Rule 3: check file overlap among eligible milestones
  const fileSets = new Map<string, string[]>();
  for (const result of eligible) {
    const files = await collectTouchedFiles(basePath, result.milestoneId);
    fileSets.set(result.milestoneId, files);
  }

  const fileOverlaps = detectFileOverlaps(fileSets);

  // Annotate eligible milestones that have file overlaps
  const overlappingIds = new Set<string>();
  for (const overlap of fileOverlaps) {
    overlappingIds.add(overlap.mid1);
    overlappingIds.add(overlap.mid2);
  }

  for (const result of eligible) {
    if (overlappingIds.has(result.milestoneId)) {
      result.reason = "All dependencies satisfied. WARNING: has file overlap with another eligible milestone.";
    }
  }

  return { eligible, ineligible, fileOverlaps };
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/**
 * Produce a human-readable report of parallel eligibility analysis.
 */
export function formatEligibilityReport(candidates: ParallelCandidates): string {
  const lines: string[] = [];

  lines.push("# Parallel Eligibility Report");
  lines.push("");

  // Eligible milestones
  lines.push(`## Eligible for Parallel Execution (${candidates.eligible.length})`);
  lines.push("");
  if (candidates.eligible.length === 0) {
    lines.push("No milestones are currently eligible for parallel execution.");
  } else {
    for (const e of candidates.eligible) {
      lines.push(`- **${e.milestoneId}** — ${e.title}`);
      lines.push(`  ${e.reason}`);
    }
  }
  lines.push("");

  // Ineligible milestones
  lines.push(`## Ineligible (${candidates.ineligible.length})`);
  lines.push("");
  if (candidates.ineligible.length === 0) {
    lines.push("All milestones are eligible.");
  } else {
    for (const e of candidates.ineligible) {
      lines.push(`- **${e.milestoneId}** — ${e.title}`);
      lines.push(`  ${e.reason}`);
    }
  }
  lines.push("");

  // File overlap warnings
  if (candidates.fileOverlaps.length > 0) {
    lines.push(`## File Overlap Warnings (${candidates.fileOverlaps.length})`);
    lines.push("");
    for (const overlap of candidates.fileOverlaps) {
      lines.push(`- **${overlap.mid1}** <-> **${overlap.mid2}** — ${overlap.files.length} shared file(s):`);
      for (const f of overlap.files) {
        lines.push(`  - \`${f}\``);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
