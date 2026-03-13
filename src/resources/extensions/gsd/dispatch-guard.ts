import { execSync } from "node:child_process";
import { relMilestoneFile } from "./paths.js";
import { parseRoadmapSlices } from "./roadmap-slices.ts";

const SLICE_DISPATCH_TYPES = new Set([
  "research-slice",
  "plan-slice",
  "replan-slice",
  "execute-task",
  "complete-slice",
]);

function readTrackedFileFromBranch(base: string, branch: string, relPath: string): string | null {
  try {
    return execSync(`git show ${branch}:${relPath}`, {
      cwd: base,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
}

function milestoneIdFromNumber(num: number): string {
  return `M${String(num).padStart(3, "0")}`;
}

export function getPriorSliceCompletionBlocker(base: string, mainBranch: string, unitType: string, unitId: string): string | null {
  if (!SLICE_DISPATCH_TYPES.has(unitType)) return null;

  const [targetMid, targetSid] = unitId.split("/");
  if (!targetMid || !targetSid) return null;

  const targetMidNumber = Number.parseInt(targetMid.slice(1), 10);
  if (!Number.isFinite(targetMidNumber)) return null;

  for (let milestoneNumber = 1; milestoneNumber <= targetMidNumber; milestoneNumber += 1) {
    const mid = milestoneIdFromNumber(milestoneNumber);
    const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
    if (!roadmapRel) continue;

    const roadmapContent = readTrackedFileFromBranch(base, mainBranch, roadmapRel);
    if (!roadmapContent) continue;

    const slices = parseRoadmapSlices(roadmapContent);
    if (mid !== targetMid) {
      const incomplete = slices.find(slice => !slice.done);
      if (incomplete) {
        return `Cannot dispatch ${unitType} ${unitId}: earlier slice ${mid}/${incomplete.id} is not complete on ${mainBranch}.`;
      }
      continue;
    }

    const targetIndex = slices.findIndex(slice => slice.id === targetSid);
    if (targetIndex === -1) return null;

    const incomplete = slices.slice(0, targetIndex).find(slice => !slice.done);
    if (incomplete) {
      return `Cannot dispatch ${unitType} ${unitId}: earlier slice ${targetMid}/${incomplete.id} is not complete on ${mainBranch}.`;
    }
  }

  return null;
}
