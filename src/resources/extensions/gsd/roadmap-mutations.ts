/**
 * Roadmap Mutations — shared utilities for modifying roadmap checkbox state.
 *
 * Extracts the duplicated "flip slice checkbox" pattern that existed in
 * doctor.ts, mechanical-completion.ts, and auto-recovery.ts.
 */

import { readFileSync } from "node:fs";
import { atomicWriteSync } from "./atomic-write.js";
import { resolveMilestoneFile } from "./paths.js";
import { clearParseCache } from "./files.js";

/**
 * Mark a slice as done ([x]) in the milestone roadmap.
 * Idempotent — no-op if already checked or if the slice isn't found.
 *
 * @returns true if the roadmap was modified, false if no change was needed
 */
export function markSliceDoneInRoadmap(basePath: string, mid: string, sid: string): boolean {
  const roadmapFile = resolveMilestoneFile(basePath, mid, "ROADMAP");
  if (!roadmapFile) return false;

  let content: string;
  try {
    content = readFileSync(roadmapFile, "utf-8");
  } catch {
    return false;
  }

  // Try checkbox format first: "- [ ] **S01: Title**"
  let updated = content.replace(
    new RegExp(`^(\\s*-\\s+)\\[ \\]\\s+\\*\\*${sid}:`, "m"),
    `$1[x] **${sid}:`,
  );

  // If checkbox format didn't match, try prose format: "## S01: Title" -> "## S01: \u2713 Title"
  if (updated === content) {
    updated = content.replace(
      new RegExp(`^(#{1,4}\\s+(?:\\*{0,2})(?:Slice\\s+)?${sid}\\*{0,2}[:\\s.\\u2014\\u2013-]+\\s*)(.+)`, "m"),
      (match, prefix, title) => {
        // Already marked done — no-op
        if (/^[\u2713\u2705]/.test(title) || /[\u2705]\s*$/.test(title) || /\(Complete\)\s*$/i.test(title)) return match;
        return `${prefix}\u2713 ${title}`;
      },
    );
  }

  if (updated === content) return false;

  atomicWriteSync(roadmapFile, updated);
  clearParseCache();
  return true;
}

/**
 * Mark a slice as not done ([ ]) in the milestone roadmap.
 * Idempotent — no-op if already unchecked or if the slice isn't found.
 *
 * @returns true if the roadmap was modified, false if no change was needed
 */
export function markSliceUndoneInRoadmap(basePath: string, mid: string, sid: string): boolean {
  const roadmapFile = resolveMilestoneFile(basePath, mid, "ROADMAP");
  if (!roadmapFile) return false;

  let content: string;
  try {
    content = readFileSync(roadmapFile, "utf-8");
  } catch {
    return false;
  }

  const updated = content.replace(
    new RegExp(`^(\\s*-\\s+)\\[x\\]\\s+\\*\\*${sid}:`, "m"),
    `$1[ ] **${sid}:`,
  );

  if (updated === content) return false;

  atomicWriteSync(roadmapFile, updated);
  clearParseCache();
  return true;
}

/**
 * Mark a task as done ([x]) in the slice plan.
 * Idempotent — no-op if already checked or if the task isn't found.
 *
 * @returns true if the plan was modified, false if no change was needed
 */
export function markTaskDoneInPlan(basePath: string, planPath: string, tid: string): boolean {
  let content: string;
  try {
    content = readFileSync(planPath, "utf-8");
  } catch {
    return false;
  }

  const updated = content.replace(
    new RegExp(`^(\\s*-\\s+)\\[ \\]\\s+\\*\\*${tid}:`, "m"),
    `$1[x] **${tid}:`,
  );

  if (updated === content) return false;

  atomicWriteSync(planPath, updated);
  clearParseCache();
  return true;
}

/**
 * Mark a task as not done ([ ]) in the slice plan.
 * Idempotent — no-op if already unchecked or if the task isn't found.
 *
 * @returns true if the plan was modified, false if no change was needed
 */
export function markTaskUndoneInPlan(basePath: string, planPath: string, tid: string): boolean {
  let content: string;
  try {
    content = readFileSync(planPath, "utf-8");
  } catch {
    return false;
  }

  const updated = content.replace(
    new RegExp(`^(\\s*-\\s+)\\[x\\]\\s+\\*\\*${tid}:`, "mi"),
    `$1[ ] **${tid}:`,
  );

  if (updated === content) return false;

  atomicWriteSync(planPath, updated);
  clearParseCache();
  return true;
}
