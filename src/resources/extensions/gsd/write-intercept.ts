// GSD Extension — Write Intercept for Agent State File Blocks
// Detects agent attempts to write authoritative state files and returns
// an error directing the agent to use the engine tool API instead.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Patterns matching authoritative .gsd/ state files that agents must NOT write directly.
 *
 * Only STATE.md is blocked — it is purely engine-rendered from DB state.
 * All other .gsd/ files are agent-authored content that agents create and
 * update during discuss, plan, and execute phases:
 * - REQUIREMENTS.md — agents create during discuss, read during planning
 * - PROJECT.md — agents create during discuss, update at milestone close
 * - ROADMAP.md / PLAN.md — agents create during planning, engine renders checkboxes
 * - SUMMARY.md, KNOWLEDGE.md, CONTEXT.md — non-authoritative content
 */
const BLOCKED_PATTERNS: RegExp[] = [
  // STATE.md is the only purely engine-rendered file.
  // Case-insensitive to prevent bypass on macOS (case-insensitive APFS).
  // (^|[/\\]) matches both absolute paths (/project/.gsd/…) and bare relative
  // paths (.gsd/STATE.md) so a path without a leading separator is also blocked.
  /(^|[/\\])\.gsd[/\\]STATE\.md$/i,
  // Also match resolved symlink paths under ~/.gsd/projects/ (Pitfall #6)
  /(^|[/\\])\.gsd[/\\]projects[/\\][^/\\]+[/\\]STATE\.md$/i,
];

/**
 * Bash command patterns that target STATE.md.
 * Covers common shell write patterns: redirect, tee, cp, mv, sed -i, etc.
 */
const BASH_STATE_PATTERNS: RegExp[] = [
  // Redirect/pipe writes: > STATE.md, >> STATE.md, >| STATE.md
  /[>|]+\s*\S*STATE\.md/i,
  // tee to STATE.md
  /\btee\b.*STATE\.md/i,
  // cp/mv targeting STATE.md
  /\b(cp|mv)\b.*STATE\.md/i,
  // sed -i editing STATE.md
  /\bsed\b.*-i.*STATE\.md/i,
  // dd output to STATE.md
  /\bdd\b.*of=\S*STATE\.md/i,
];

/**
 * Tests whether the given file path matches a blocked authoritative .gsd/ state file.
 * Resolves `..` segments via path.resolve() and attempts realpathSync for symlinks.
 */
export function isBlockedStateFile(filePath: string): boolean {
  // Check raw path first
  if (matchesBlockedPattern(filePath)) return true;

  // Resolve ".." segments (works even for non-existing files)
  const resolved = resolve(filePath);
  if (resolved !== filePath && matchesBlockedPattern(resolved)) return true;

  // Also try symlink resolution — file may not exist yet, so wrap in try/catch
  try {
    const realpath = realpathSync(filePath);
    if (realpath !== filePath && realpath !== resolved && matchesBlockedPattern(realpath)) return true;
  } catch {
    // File doesn't exist yet — path matching above is sufficient
  }

  return false;
}

/**
 * Tests whether a bash command appears to target STATE.md for writing.
 */
export function isBashWriteToStateFile(command: string): boolean {
  return BASH_STATE_PATTERNS.some((pattern) => pattern.test(command));
}

function matchesBlockedPattern(path: string): boolean {
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Error message returned when an agent attempts to directly write an authoritative .gsd/ state file.
 * Directs the agent to use engine tool calls instead.
 */
export const BLOCKED_WRITE_ERROR = `Direct writes to .gsd/STATE.md are blocked. Use engine tool calls instead:
- To complete a task: call gsd_complete_task(milestone_id, slice_id, task_id, summary)
- To complete a slice: call gsd_complete_slice(milestone_id, slice_id, summary, uat_result)
- To save a decision: call gsd_save_decision(scope, decision, choice, rationale)
- To start a task: call gsd_start_task(milestone_id, slice_id, task_id)
- To record verification: call gsd_record_verification(milestone_id, slice_id, task_id, evidence)
- To report a blocker: call gsd_report_blocker(milestone_id, slice_id, task_id, description)`;
