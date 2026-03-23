// GSD Extension — Write Intercept for Agent State File Blocks
// Detects agent attempts to write authoritative state files and returns
// an error directing the agent to use the engine tool API instead.
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { realpathSync } from "node:fs";

/**
 * Patterns matching authoritative .gsd/ state files that agents must NOT write directly.
 * Agents must use engine tool calls instead (gsd_complete_task, gsd_save_decision, etc.).
 *
 * Note: ROADMAP.md and PLAN.md are NOT blocked — agents create/edit these during planning.
 * The engine renders projections into them but they are agent-authored content.
 * SUMMARY.md, KNOWLEDGE.md, and CONTEXT.md are also excluded — non-authoritative content.
 */
const BLOCKED_PATTERNS: RegExp[] = [
  // Top-level .gsd/ authoritative state files (engine-rendered, not agent-authored)
  /[/\\]\.gsd[/\\]STATE\.md$/,
  /[/\\]\.gsd[/\\]REQUIREMENTS\.md$/,
  // Also match resolved symlink paths under ~/.gsd/projects/ (Pitfall #6)
  /[/\\]\.gsd[/\\]projects[/\\][^/\\]+[/\\]STATE\.md$/,
  /[/\\]\.gsd[/\\]projects[/\\][^/\\]+[/\\]REQUIREMENTS\.md$/,
];

/**
 * Tests whether the given file path matches a blocked authoritative .gsd/ state file.
 * Also attempts to resolve symlinks (realpathSync) to catch Pitfall #6 (symlinked .gsd paths).
 */
export function isBlockedStateFile(filePath: string): boolean {
  if (matchesBlockedPattern(filePath)) return true;

  // Also try resolved symlink path — file may not exist yet, so wrap in try/catch
  try {
    const resolved = realpathSync(filePath);
    if (resolved !== filePath && matchesBlockedPattern(resolved)) return true;
  } catch {
    // File doesn't exist yet — that's fine, path matching is enough
  }

  return false;
}

function matchesBlockedPattern(path: string): boolean {
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Error message returned when an agent attempts to directly write an authoritative .gsd/ state file.
 * Directs the agent to use engine tool calls instead.
 */
export const BLOCKED_WRITE_ERROR = `Error: Direct writes to .gsd/ state files are blocked. Use engine tool calls instead:
- To complete a task: call gsd_complete_task(milestone_id, slice_id, task_id, summary)
- To complete a slice: call gsd_complete_slice(milestone_id, slice_id, summary, uat_result)
- To save a decision: call gsd_save_decision(scope, decision, choice, rationale)
- To start a task: call gsd_start_task(milestone_id, slice_id, task_id)
- To record verification: call gsd_record_verification(milestone_id, slice_id, task_id, evidence)
- To report a blocker: call gsd_report_blocker(milestone_id, slice_id, task_id, description)`;
