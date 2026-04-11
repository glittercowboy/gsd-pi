// GSD Extension — Undo Last Unit + Targeted State Reset
// handleUndo: Rollback the most recent completed unit (revert git, remove state, uncheck plans).
// handleUndoTask: Reset a single task's DB status to "pending" and re-render markdown.
// handleResetSlice: Reset a slice and all its tasks, re-rendering plan + roadmap.

import type { ExtensionCommandContext, ExtensionAPI } from "@gsd/pi-coding-agent";
import { existsSync, readFileSync, unlinkSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { nativeRevertCommit, nativeRevertAbort } from "./native-git-bridge.js";
import { atomicWriteSync } from "./atomic-write.js";
import { parseUnitId } from "./unit-id.js";
import { deriveState } from "./state.js";
import { invalidateAllCaches } from "./cache.js";
import { gsdRoot, resolveTasksDir, resolveSlicePath, resolveTaskFile, buildTaskFileName, buildSliceFileName } from "./paths.js";
import { sendDesktopNotification } from "./notifications.js";
import { getTask, getSlice, getSliceTasks, updateTaskStatus, updateSliceStatus } from "./gsd-db.js";
import { renderPlanCheckboxes, renderRoadmapCheckboxes } from "./markdown-renderer.js";

/**
 * Undo the last completed unit: revert git commits,
 * delete summary artifacts, and uncheck the task in PLAN.
 * deriveState() handles re-derivation after revert.
 */
export async function handleUndo(args: string, ctx: ExtensionCommandContext, _pi: ExtensionAPI, basePath: string): Promise<void> {
  const force = args.includes("--force");

  // Find the last GSD-related commit from git activity logs
  const activityDir = join(gsdRoot(basePath), "activity");
  if (!existsSync(activityDir)) {
    ctx.ui.notify("Nothing to undo — no activity logs found.", "info");
    return;
  }

  // Parse activity logs to find the most recent unit
  const files = readdirSync(activityDir)
    .filter(f => f.endsWith(".jsonl"))
    .sort()
    .reverse();

  if (files.length === 0) {
    ctx.ui.notify("Nothing to undo — no activity logs found.", "info");
    return;
  }

  // Extract unit type and ID from the most recent activity log filename
  // Format: <seq>-<unitType>-<unitId>.jsonl
  const match = files[0].match(/^\d+-(.+?)-(.+)\.jsonl$/);
  if (!match) {
    ctx.ui.notify("Nothing to undo — could not parse latest activity log.", "warning");
    return;
  }

  const unitType = match[1];
  const unitId = match[2].replace(/-/g, "/");

  if (!force) {
    ctx.ui.notify(
      `Will undo: ${unitType} (${unitId})\n` +
      `This will:\n` +
      `  - Delete summary artifacts\n` +
      `  - Uncheck task in PLAN (if execute-task)\n` +
      `  - Attempt to revert associated git commits\n\n` +
      `Run /gsd undo --force to confirm.`,
      "warning",
    );
    return;
  }

  // 1. Delete summary artifact
  const { milestone, slice, task } = parseUnitId(unitId);
  let summaryRemoved = false;
  if (task !== undefined && slice !== undefined) {
    // Task-level: M001/S01/T01
    const [mid, sid, tid] = [milestone, slice, task];
    const tasksDir = resolveTasksDir(basePath, mid, sid);
    if (tasksDir) {
      const summaryFile = join(tasksDir, buildTaskFileName(tid, "SUMMARY"));
      if (existsSync(summaryFile)) {
        unlinkSync(summaryFile);
        summaryRemoved = true;
      }
    }
  } else if (slice !== undefined) {
    // Slice-level: M001/S01
    const [mid, sid] = [milestone, slice];
    const slicePath = resolveSlicePath(basePath, mid, sid);
    if (slicePath) {
      for (const suffix of ["SUMMARY", "COMPLETE"]) {
        const candidates = findFileWithPrefix(slicePath, sid, suffix);
        for (const f of candidates) {
          unlinkSync(f);
          summaryRemoved = true;
        }
      }
    }
  }

  // 2. Uncheck task in PLAN if execute-task
  let planUpdated = false;
  if (unitType === "execute-task" && task !== undefined && slice !== undefined) {
    const [mid, sid, tid] = [milestone, slice, task];
    planUpdated = uncheckTaskInPlan(basePath, mid, sid, tid);
  }

  // 3. Try to revert git commits from activity log
  let commitsReverted = 0;
  try {
    const commits = findCommitsForUnit(activityDir, unitType, unitId);
    if (commits.length > 0) {
      for (const sha of commits.reverse()) {
        try {
          nativeRevertCommit(basePath, sha);
          commitsReverted++;
        } catch {
          // Revert conflict or already reverted — skip
          try { nativeRevertAbort(basePath); } catch { /* no-op */ }
          break;
        }
      }
    }
  } finally {
    // 4. Re-derive state — always invalidate caches even if git operations fail
    invalidateAllCaches();
    await deriveState(basePath);
  }

  // Build result message
  const results: string[] = [`Undone: ${unitType} (${unitId})`];
  if (summaryRemoved) results.push(`  - Deleted summary artifact`);
  if (planUpdated) results.push(`  - Unchecked task in PLAN`);
  if (commitsReverted > 0) {
    results.push(`  - Reverted ${commitsReverted} commit(s) (staged, not committed)`);
    results.push(`  Review with 'git diff --cached' then 'git commit' or 'git reset HEAD'`);
  }

  ctx.ui.notify(results.join("\n"), "success");
  sendDesktopNotification("GSD", `Undone: ${unitType} (${unitId})`, "info", "complete", basename(basePath));
}

// ─── Targeted State Reset ────────────────────────────────────────────────────

/**
 * Parse a task identifier from args. Accepts:
 *   T01, S01/T01, M001/S01/T01
 * Resolves missing parts from current state via deriveState().
 */
async function parseTaskId(
  raw: string,
  basePath: string,
): Promise<{ mid: string; sid: string; tid: string } | string> {
  const parts = raw.split("/");
  if (parts.length === 3) {
    return { mid: parts[0], sid: parts[1], tid: parts[2] };
  }
  // Need to resolve from state
  const state = await deriveState(basePath);
  if (parts.length === 2) {
    // S01/T01 — resolve milestone
    const mid = state.activeMilestone?.id;
    if (!mid) return "Cannot resolve milestone — no active milestone in state.";
    return { mid, sid: parts[0], tid: parts[1] };
  }
  if (parts.length === 1) {
    // T01 — resolve milestone + slice
    const mid = state.activeMilestone?.id;
    const sid = state.activeSlice?.id;
    if (!mid) return "Cannot resolve milestone — no active milestone in state.";
    if (!sid) return "Cannot resolve slice — no active slice in state.";
    return { mid, sid, tid: parts[0] };
  }
  return "Invalid task ID format. Use T01, S01/T01, or M001/S01/T01.";
}

/**
 * Parse a slice identifier from args. Accepts:
 *   S01, M001/S01
 * Resolves missing milestone from current state.
 */
async function parseSliceId(
  raw: string,
  basePath: string,
): Promise<{ mid: string; sid: string } | string> {
  const parts = raw.split("/");
  if (parts.length === 2) {
    return { mid: parts[0], sid: parts[1] };
  }
  if (parts.length === 1) {
    const state = await deriveState(basePath);
    const mid = state.activeMilestone?.id;
    if (!mid) return "Cannot resolve milestone — no active milestone in state.";
    return { mid, sid: parts[0] };
  }
  return "Invalid slice ID format. Use S01 or M001/S01.";
}

/**
 * Reset a single task's completion state:
 * - Set DB status to "pending"
 * - Delete the task summary file
 * - Re-render plan checkboxes
 */
export async function handleUndoTask(
  args: string,
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI,
  basePath: string,
): Promise<void> {
  const force = args.includes("--force");
  const rawId = args.replace("--force", "").trim();

  if (!rawId) {
    ctx.ui.notify(
      "Usage: /gsd undo-task <taskId> [--force]\n\n" +
      "Accepts: T01, S01/T01, or M001/S01/T01\n" +
      "Resets the task's DB status to pending and re-renders plan checkboxes.",
      "warning",
    );
    return;
  }

  const parsed = await parseTaskId(rawId, basePath);
  if (typeof parsed === "string") {
    ctx.ui.notify(parsed, "error");
    return;
  }

  const { mid, sid, tid } = parsed;

  // Validate task exists in DB
  const task = getTask(mid, sid, tid);
  if (!task) {
    ctx.ui.notify(`Task ${mid}/${sid}/${tid} not found in database.`, "error");
    return;
  }

  if (!force) {
    ctx.ui.notify(
      `Will reset: task ${mid}/${sid}/${tid}\n` +
      `  Current status: ${task.status}\n` +
      `This will:\n` +
      `  - Set task status to "pending" in DB\n` +
      `  - Delete task summary file (if exists)\n` +
      `  - Re-render plan checkboxes\n\n` +
      `Run /gsd undo-task ${rawId} --force to confirm.`,
      "warning",
    );
    return;
  }

  // Reset DB status
  updateTaskStatus(mid, sid, tid, "pending");

  // Delete summary file
  let summaryDeleted = false;
  const summaryPath = resolveTaskFile(basePath, mid, sid, tid, "SUMMARY");
  if (summaryPath && existsSync(summaryPath)) {
    unlinkSync(summaryPath);
    summaryDeleted = true;
  }

  // Re-render plan checkboxes
  await renderPlanCheckboxes(basePath, mid, sid);

  // Invalidate caches
  invalidateAllCaches();

  const results: string[] = [`Reset task ${mid}/${sid}/${tid} to "pending".`];
  if (summaryDeleted) results.push("  - Deleted task summary file");
  results.push("  - Plan checkboxes re-rendered");

  ctx.ui.notify(results.join("\n"), "success");
}

/**
 * Reset a slice and all its tasks:
 * - Set all task DB statuses to "pending"
 * - Set slice DB status to "active"
 * - Delete task summary files, slice summary, and UAT files
 * - Re-render plan + roadmap checkboxes
 */
export async function handleResetSlice(
  args: string,
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI,
  basePath: string,
): Promise<void> {
  const force = args.includes("--force");
  const rawId = args.replace("--force", "").trim();

  if (!rawId) {
    ctx.ui.notify(
      "Usage: /gsd reset-slice <sliceId> [--force]\n\n" +
      "Accepts: S01 or M001/S01\n" +
      "Resets the slice and all its tasks, re-renders plan + roadmap checkboxes.",
      "warning",
    );
    return;
  }

  const parsed = await parseSliceId(rawId, basePath);
  if (typeof parsed === "string") {
    ctx.ui.notify(parsed, "error");
    return;
  }

  const { mid, sid } = parsed;

  // Validate slice exists in DB
  const slice = getSlice(mid, sid);
  if (!slice) {
    ctx.ui.notify(`Slice ${mid}/${sid} not found in database.`, "error");
    return;
  }

  const tasks = getSliceTasks(mid, sid);

  if (!force) {
    ctx.ui.notify(
      `Will reset: slice ${mid}/${sid}\n` +
      `  Current status: ${slice.status}\n` +
      `  Tasks to reset: ${tasks.length}\n` +
      `This will:\n` +
      `  - Set all task statuses to "pending" in DB\n` +
      `  - Set slice status to "active" in DB\n` +
      `  - Delete task summary files, slice summary, and UAT files\n` +
      `  - Re-render plan + roadmap checkboxes\n\n` +
      `Run /gsd reset-slice ${rawId} --force to confirm.`,
      "warning",
    );
    return;
  }

  // Reset all tasks
  let tasksReset = 0;
  let summariesDeleted = 0;
  for (const t of tasks) {
    updateTaskStatus(mid, sid, t.id, "pending");
    tasksReset++;
    const summaryPath = resolveTaskFile(basePath, mid, sid, t.id, "SUMMARY");
    if (summaryPath && existsSync(summaryPath)) {
      unlinkSync(summaryPath);
      summariesDeleted++;
    }
  }

  // Reset slice status
  updateSliceStatus(mid, sid, "active");

  // Delete slice summary and UAT files
  let sliceFilesDeleted = 0;
  const slicePath = resolveSlicePath(basePath, mid, sid);
  if (slicePath) {
    for (const suffix of ["SUMMARY", "UAT"]) {
      const filePath = join(slicePath, buildSliceFileName(sid, suffix));
      if (existsSync(filePath)) {
        unlinkSync(filePath);
        sliceFilesDeleted++;
      }
    }
  }

  // Re-render plan + roadmap checkboxes
  await renderPlanCheckboxes(basePath, mid, sid);
  await renderRoadmapCheckboxes(basePath, mid);

  // Invalidate caches
  invalidateAllCaches();

  const results: string[] = [
    `Reset slice ${mid}/${sid} to "active".`,
    `  - ${tasksReset} task(s) reset to "pending"`,
  ];
  if (summariesDeleted > 0) results.push(`  - ${summariesDeleted} task summary file(s) deleted`);
  if (sliceFilesDeleted > 0) results.push(`  - ${sliceFilesDeleted} slice file(s) deleted (summary/UAT)`);
  results.push("  - Plan + roadmap checkboxes re-rendered");

  ctx.ui.notify(results.join("\n"), "success");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function uncheckTaskInPlan(basePath: string, mid: string, sid: string, tid: string): boolean {
  const slicePath = resolveSlicePath(basePath, mid, sid);
  if (!slicePath) return false;

  // Find the PLAN file
  const planCandidates = findFileWithPrefix(slicePath, sid, "PLAN");
  if (planCandidates.length === 0) return false;

  const planFile = planCandidates[0];
  let content = readFileSync(planFile, "utf-8");

  // Match checked task line: - [x] **T01** or - [x] T01:
  const regex = new RegExp(`^(\\s*-\\s*)\\[x\\](\\s*\\**${tid}\\**[:\\s])`, "mi");
  if (regex.test(content)) {
    content = content.replace(regex, "$1[ ]$2");
    atomicWriteSync(planFile, content);
    return true;
  }
  return false;
}

function findFileWithPrefix(dir: string, prefix: string, suffix: string): string[] {
  try {
    const files = readdirSync(dir);
    return files
      .filter(f => f.includes(suffix) && (f.startsWith(prefix) || f.startsWith(`${prefix}-`)))
      .map(f => join(dir, f));
  } catch {
    return [];
  }
}

export function findCommitsForUnit(activityDir: string, unitType: string, unitId: string): string[] {
  const safeUnitId = unitId.replace(/\//g, "-");
  const commitSet = new Set<string>();
  const commits: string[] = [];

  try {
    const files = readdirSync(activityDir)
      .filter(f => f.includes(unitType) && f.includes(safeUnitId) && f.endsWith(".jsonl"))
      .sort()
      .reverse();

    if (files.length === 0) return [];

    // Parse the most recent activity log for this unit
    const content = readFileSync(join(activityDir, files[0]), "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        // Look for tool results containing git commit output
        if (entry?.message?.content) {
          const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
          for (const block of blocks) {
            if (block.type === "tool_result" && typeof block.content === "string") {
              for (const sha of extractCommitShas(block.content)) {
                if (!commitSet.has(sha)) {
                  commitSet.add(sha);
                  commits.push(sha);
                }
              }
            }
          }
        }
      } catch { /* malformed JSON line — skip */ }
    }
  } catch { /* activity dir issues — skip */ }

  return commits;
}

export function extractCommitShas(content: string): string[] {
  const seen = new Set<string>();
  const commits: string[] = [];
  for (const match of content.matchAll(/\[[\w/.-]+\s+([a-f0-9]{7,40})\]/g)) {
    const sha = match[1];
    if (sha && !seen.has(sha)) {
      seen.add(sha);
      commits.push(sha);
    }
  }
  return commits;
}
