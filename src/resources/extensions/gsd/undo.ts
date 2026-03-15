// GSD Extension — Undo Last Unit
// Rollback the most recent completed unit: revert git, remove state, uncheck plans.
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import type { ExtensionCommandContext, ExtensionAPI } from "@gsd/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { deriveState, invalidateStateCache } from "./state.js";
import { gsdRoot, resolveTasksDir, resolveSlicePath, buildTaskFileName } from "./paths.js";
import { sendDesktopNotification } from "./notifications.js";

/**
 * Undo the last completed unit: revert git commits, remove from completed-units,
 * delete summary artifacts, and uncheck the task in PLAN.
 */
export async function handleUndo(args: string, ctx: ExtensionCommandContext, _pi: ExtensionAPI, basePath: string): Promise<void> {
  const force = args.includes("--force");

  // 1. Load completed-units.json
  const completedKeysFile = join(gsdRoot(basePath), "completed-units.json");
  if (!existsSync(completedKeysFile)) {
    ctx.ui.notify("Nothing to undo — no completed units found.", "info");
    return;
  }

  let keys: string[];
  try {
    keys = JSON.parse(readFileSync(completedKeysFile, "utf-8"));
  } catch {
    ctx.ui.notify("Nothing to undo — completed-units.json is corrupt.", "warning");
    return;
  }

  if (keys.length === 0) {
    ctx.ui.notify("Nothing to undo — no completed units.", "info");
    return;
  }

  // Get the last completed unit
  const lastKey = keys[keys.length - 1];
  const sepIdx = lastKey.indexOf("/");
  const unitType = sepIdx >= 0 ? lastKey.slice(0, sepIdx) : lastKey;
  const unitId = sepIdx >= 0 ? lastKey.slice(sepIdx + 1) : lastKey;

  if (!force) {
    ctx.ui.notify(
      `Will undo: ${unitType} (${unitId})\n` +
      `This will:\n` +
      `  - Remove from completed-units.json\n` +
      `  - Delete summary artifacts\n` +
      `  - Uncheck task in PLAN (if execute-task)\n` +
      `  - Attempt to revert associated git commits\n\n` +
      `Run /gsd undo --force to confirm.`,
      "warning",
    );
    return;
  }

  // 2. Remove from completed-units.json
  keys = keys.filter(k => k !== lastKey);
  writeFileSync(completedKeysFile, JSON.stringify(keys), "utf-8");

  // 3. Delete summary artifact
  const parts = unitId.split("/");
  let summaryRemoved = false;
  if (parts.length === 3) {
    // Task-level: M001/S01/T01
    const [mid, sid, tid] = parts;
    const tasksDir = resolveTasksDir(basePath, mid, sid);
    if (tasksDir) {
      const summaryFile = join(tasksDir, buildTaskFileName(tid, "SUMMARY"));
      if (existsSync(summaryFile)) {
        unlinkSync(summaryFile);
        summaryRemoved = true;
      }
    }
  } else if (parts.length === 2) {
    // Slice-level: M001/S01
    const [mid, sid] = parts;
    const slicePath = resolveSlicePath(basePath, mid, sid);
    if (slicePath) {
      // Try common summary filenames
      for (const suffix of ["SUMMARY", "COMPLETE"]) {
        const candidates = findFileWithPrefix(slicePath, sid, suffix);
        for (const f of candidates) {
          unlinkSync(f);
          summaryRemoved = true;
        }
      }
    }
  }

  // 4. Uncheck task in PLAN if execute-task
  let planUpdated = false;
  if (unitType === "execute-task" && parts.length === 3) {
    const [mid, sid, tid] = parts;
    planUpdated = uncheckTaskInPlan(basePath, mid, sid, tid);
  }

  // 5. Try to revert git commits from activity log
  let commitsReverted = 0;
  const activityDir = join(gsdRoot(basePath), "activity");
  if (existsSync(activityDir)) {
    const commits = findCommitsForUnit(activityDir, unitType, unitId);
    if (commits.length > 0) {
      for (const sha of commits.reverse()) {
        try {
          execFileSync("git", ["revert", "--no-commit", sha], { cwd: basePath, timeout: 10000, stdio: "ignore" });
          commitsReverted++;
        } catch {
          // Revert conflict or already reverted — skip
          try { execFileSync("git", ["revert", "--abort"], { cwd: basePath, timeout: 5000, stdio: "ignore" }); } catch { /* no-op */ }
          break;
        }
      }
    }
  }

  // 6. Re-derive state
  invalidateStateCache();
  await deriveState(basePath);

  // Build result message
  const results: string[] = [`Undone: ${unitType} (${unitId})`];
  results.push(`  - Removed from completed-units.json`);
  if (summaryRemoved) results.push(`  - Deleted summary artifact`);
  if (planUpdated) results.push(`  - Unchecked task in PLAN`);
  if (commitsReverted > 0) {
    results.push(`  - Reverted ${commitsReverted} commit(s) (staged, not committed)`);
    results.push(`  Review with 'git diff --cached' then 'git commit' or 'git reset HEAD'`);
  }

  ctx.ui.notify(results.join("\n"), "success");
  sendDesktopNotification("GSD", `Undone: ${unitType} (${unitId})`, "info", "complete");
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
    writeFileSync(planFile, content, "utf-8");
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
                if (!commits.includes(sha)) {
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
  const commits: string[] = [];
  for (const match of content.matchAll(/\[[\w/.-]+\s+([a-f0-9]{7,40})\]/g)) {
    const sha = match[1];
    if (sha && !commits.includes(sha)) {
      commits.push(sha);
    }
  }
  return commits;
}
