/**
 * GSD Parallel Eligibility — Milestone parallelism analysis.
 *
 * Analyzes which milestones can safely run in parallel by checking
 * dependency satisfaction and file overlap across slice plans.
 */

import { existsSync } from "node:fs";
import { deriveState } from "./state.js";
import { parseRoadmap, parsePlan, loadFile } from "./files.js";
import { resolveMilestoneFile, resolveSliceFile } from "./paths.js";
import { findMilestoneIds } from "./guided-flow.js";
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
export async function collectTouchedFiles(
  basePath: string,
  milestoneId: string,
): Promise<string[]> {
  const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
  if (!roadmapPath) return [];

  const roadmapContent = await loadFile(roadmapPath);
  if (!roadmapContent) return [];

  const roadmap = parseRoadmap(roadmapContent);
  const files = new Set<string>();

  for (const slice of roadmap.slices) {
    const planPath = resolveSliceFile(basePath, milestoneId, slice.id, "PLAN");
    if (!planPath) continue;

    const planContent = await loadFile(planPath);
    if (!planContent) continue;

    const plan = parsePlan(planContent);
    for (const f of plan.filesLikelyTouched) {
      files.add(f);
    }
  }

  return [...files];
}

// ─── Conflict Check (mid-session gate) ───────────────────────────────────────

export interface ConflictCheckResult {
  hasConflict: boolean;
  overlappingFiles: string[];
  conflictingWorkerIds: string[];
}

/**
 * Check whether a candidate milestone overlaps files with any running workers.
 * Used as a gate before `addWorkerMidSession()` in both dashboard entry points.
 */
export async function checkConflictWithRunning(
  basePath: string,
  candidateMid: string,
  runningMids: string[],
): Promise<ConflictCheckResult> {
  const candidateFiles = await collectTouchedFiles(basePath, candidateMid);
  if (candidateFiles.length === 0) {
    return { hasConflict: false, overlappingFiles: [], conflictingWorkerIds: [] };
  }
  const candidateSet = new Set(candidateFiles);
  const overlappingFiles = new Set<string>();
  const conflictingWorkerIds: string[] = [];

  for (const mid of runningMids) {
    const workerFiles = await collectTouchedFiles(basePath, mid);
    const overlap = workerFiles.filter(f => candidateSet.has(f));
    if (overlap.length > 0) {
      conflictingWorkerIds.push(mid);
      for (const f of overlap) overlappingFiles.add(f);
    }
  }

  return {
    hasConflict: overlappingFiles.size > 0,
    overlappingFiles: [...overlappingFiles],
    conflictingWorkerIds,
  };
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
  config?: { overlap_policy?: "warn" | "block" },
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

  if (config?.overlap_policy === "block" && fileOverlaps.length > 0) {
    // Build per-milestone overlap descriptions for blocking reasons
    const overlapDesc = new Map<string, string[]>();
    for (const overlap of fileOverlaps) {
      const desc1 = overlapDesc.get(overlap.mid1) ?? [];
      desc1.push(`${overlap.mid2} on ${overlap.files.length} file(s): ${overlap.files.join(", ")}`);
      overlapDesc.set(overlap.mid1, desc1);

      const desc2 = overlapDesc.get(overlap.mid2) ?? [];
      desc2.push(`${overlap.mid1} on ${overlap.files.length} file(s): ${overlap.files.join(", ")}`);
      overlapDesc.set(overlap.mid2, desc2);
    }

    // Move overlapping milestones from eligible to ineligible
    for (let i = eligible.length - 1; i >= 0; i--) {
      const result = eligible[i];
      if (overlappingIds.has(result.milestoneId)) {
        const reasons = overlapDesc.get(result.milestoneId) ?? [];
        eligible.splice(i, 1);
        ineligible.push({
          milestoneId: result.milestoneId,
          title: result.title,
          eligible: false,
          reason: `Blocked by overlap_policy: file overlap with ${reasons.join("; ")}`,
        });
      }
    }
  } else {
    // Default "warn" behavior — annotate but don't block
    for (const result of eligible) {
      if (overlappingIds.has(result.milestoneId)) {
        result.reason = "All dependencies satisfied. WARNING: has file overlap with another eligible milestone.";
      }
    }
  }

  return { eligible, ineligible, fileOverlaps };
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/**
 * Produce a human-readable report of parallel eligibility analysis.
 */
export function formatEligibilityReport(candidates: ParallelCandidates, config?: { overlap_policy?: "warn" | "block" }): string {
  const lines: string[] = [];

  lines.push("# Parallel Eligibility Report");
  if (config?.overlap_policy === "block") {
    lines.push("_Overlap policy: **block** — milestones with file overlaps are ineligible._");
  }
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

// ─── Mid-Session Candidate Types ─────────────────────────────────────────────

export interface MidSessionCandidate extends EligibilityResult {
  hasRoadmap: boolean;
  hasContext: boolean;
  /** ready = hasRoadmap — a milestone needs at least a ROADMAP to start work */
  ready: boolean;
}

export interface MidSessionCandidates {
  candidates: MidSessionCandidate[];
  atCapacity: boolean;
  currentWorkerCount: number;
  maxWorkers: number;
}

// ─── Mid-Session Eligibility ─────────────────────────────────────────────────

/**
 * Determine which milestones are eligible to be added as workers mid-session.
 *
 * Wraps `analyzeParallelEligibility()` with additional filtering:
 * 1. Excludes milestones that are already running as workers
 * 2. Annotates each candidate with ROADMAP/CONTEXT file existence
 * 3. Reports capacity status against maxWorkers
 */
export async function getMidSessionCandidates(
  basePath: string,
  runningMilestoneIds: string[],
  maxWorkers?: number,
): Promise<MidSessionCandidates> {
  const effectiveMax = maxWorkers ?? 4;
  const analysis = await analyzeParallelEligibility(basePath);

  const runningSet = new Set(runningMilestoneIds);

  const candidates: MidSessionCandidate[] = analysis.eligible
    .filter(e => !runningSet.has(e.milestoneId))
    .map(e => {
      const roadmapPath = resolveMilestoneFile(basePath, e.milestoneId, "ROADMAP");
      const contextPath = resolveMilestoneFile(basePath, e.milestoneId, "CONTEXT");
      const hasRoadmap = roadmapPath != null && existsSync(roadmapPath);
      const hasContext = contextPath != null && existsSync(contextPath);
      return {
        ...e,
        hasRoadmap,
        hasContext,
        ready: hasRoadmap,
      };
    });

  return {
    candidates,
    atCapacity: runningMilestoneIds.length >= effectiveMax,
    currentWorkerCount: runningMilestoneIds.length,
    maxWorkers: effectiveMax,
  };
}
