// GSD Dispatch Guard — prevents out-of-order slice dispatch

import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { resolveMilestoneFile, milestonesDir } from "./paths.js";
import { parseRoadmapSlices } from "./roadmap-slices.js";
import { findMilestoneIds } from "./guided-flow.js";

const SLICE_DISPATCH_TYPES = new Set([
  "research-slice",
  "plan-slice",
  "replan-slice",
  "execute-task",
  "complete-slice",
]);

/**
 * Read a roadmap file from disk (working tree) rather than from a git branch.
 *
 * Prior implementation used `git show <branch>:<path>` which read committed
 * state on a specific branch. This caused false-positive blockers when work
 * was committed on a milestone/worktree branch but the integration branch
 * (main) hadn't been updated yet — the guard would see prior slices as
 * incomplete on main even though they were done in the working tree (#530).
 *
 * Reading from disk always reflects the latest state, regardless of which
 * branch is checked out or whether changes have been committed.
 */
function readRoadmapFromDisk(base: string, milestoneId: string): string | null {
  try {
    const absPath = resolveMilestoneFile(base, milestoneId, "ROADMAP");
    if (!absPath) return null;
    return readFileSync(absPath, "utf-8").trim();
  } catch {
    return null;
  }
}

export function getPriorSliceCompletionBlocker(base: string, _mainBranch: string, unitType: string, unitId: string): string | null {
  if (!SLICE_DISPATCH_TYPES.has(unitType)) return null;

  const [targetMid, targetSid] = unitId.split("/");
  if (!targetMid || !targetSid) return null;

  // Use findMilestoneIds to respect custom queue order.
  // Only check milestones that come BEFORE the target in queue order.
  const allIds = findMilestoneIds(base);
  const targetIdx = allIds.indexOf(targetMid);
  if (targetIdx < 0) return null;
  const milestoneIds = allIds.slice(0, targetIdx + 1);

  for (const mid of milestoneIds) {
    // Skip parked milestones — they don't block dispatch of later milestones
    const parkedFile = resolveMilestoneFile(base, mid, "PARKED");
    if (parkedFile) continue;

    // Read from disk (working tree) — always has the latest state
    const roadmapContent = readRoadmapFromDisk(base, mid);
    if (!roadmapContent) continue;

    const slices = parseRoadmapSlices(roadmapContent);
    if (mid !== targetMid) {
      const incomplete = slices.find(slice => !slice.done);
      if (incomplete) {
        return `Cannot dispatch ${unitType} ${unitId}: earlier slice ${mid}/${incomplete.id} is not complete.`;
      }
      continue;
    }

    const targetIndex = slices.findIndex(slice => slice.id === targetSid);
    if (targetIndex === -1) return null;

    const incomplete = slices.slice(0, targetIndex).find(slice => !slice.done);
    if (incomplete) {
      return `Cannot dispatch ${unitType} ${unitId}: earlier slice ${targetMid}/${incomplete.id} is not complete.`;
    }
  }

  return null;
}
