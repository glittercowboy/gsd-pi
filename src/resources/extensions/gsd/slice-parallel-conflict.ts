/**
 * GSD Slice Parallel Conflict Detection — File overlap analysis between slices.
 *
 * Reads PLAN.md for each slice and extracts file paths mentioned in task
 * descriptions. If two slices share more than 5 file paths, they are considered
 * conflicting and should not run in parallel.
 *
 * Conservative by default: missing PLAN = block parallel execution.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ─── File Path Extraction ─────────────────────────────────────────────────────

/**
 * Extract file paths from a PLAN.md content string.
 * Matches common patterns like `src/...`, `lib/...`, paths with extensions.
 */
function extractFilePaths(content: string): Set<string> {
  const paths = new Set<string>();

  // Match file-like patterns: word/word paths with extensions, or src/lib/etc prefixed paths
  const patterns = [
    // Paths like src/foo/bar.ts, lib/utils.js, etc.
    /(?:src|lib|test|tests|app|pkg|cmd|internal|components|pages|api|utils|config|scripts|dist|build)\/[\w./-]+\.\w+/g,
    // Generic path with at least one slash and extension
    /(?<!\w)[\w-]+\/[\w./-]+\.\w{1,5}(?!\w)/g,
  ];

  for (const pattern of patterns) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      paths.add(match[0]);
    }
  }

  return paths;
}

// ─── Conflict Detection ──────────────────────────────────────────────────────

/**
 * Check if two slices have file conflicts that would block parallel execution.
 *
 * @param basePath  Project root path.
 * @param mid       Milestone ID.
 * @param sliceA    First slice ID.
 * @param sliceB    Second slice ID.
 * @returns         true if parallel is unsafe (>5 shared files or missing plan).
 */
export function hasFileConflict(
  basePath: string,
  mid: string,
  sliceA: string,
  sliceB: string,
): boolean {
  const planPathA = join(basePath, ".gsd", "milestones", mid, sliceA, "PLAN.md");
  const planPathB = join(basePath, ".gsd", "milestones", mid, sliceB, "PLAN.md");

  // Conservative: missing PLAN = block
  if (!existsSync(planPathA) || !existsSync(planPathB)) {
    return true;
  }

  const contentA = readFileSync(planPathA, "utf-8");
  const contentB = readFileSync(planPathB, "utf-8");

  const filesA = extractFilePaths(contentA);
  const filesB = extractFilePaths(contentB);

  // If either has no files extracted, no conflict detectable → allow
  if (filesA.size === 0 || filesB.size === 0) {
    return false;
  }

  // Count shared files
  let sharedCount = 0;
  for (const file of filesA) {
    if (filesB.has(file)) {
      sharedCount++;
    }
  }

  return sharedCount > 5;
}
