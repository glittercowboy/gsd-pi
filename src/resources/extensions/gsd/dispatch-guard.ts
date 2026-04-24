// GSD Dispatch Guard — prevents out-of-order slice dispatch

import { resolveMilestoneFile } from "./paths.js";
import { findMilestoneIds } from "./guided-flow.js";
import { parseUnitId } from "./unit-id.js";
import { isDbAvailable, getMilestoneSlices, getMilestone } from "./gsd-db.js";
import { parseRoadmap } from "./parsers-legacy.js";
import { isClosedStatus } from "./status-guards.js";
import { classifyMilestoneSummaryContent } from "./milestone-summary-classifier.js";
import { readFileSync } from "node:fs";

const SLICE_DISPATCH_TYPES = new Set([
  "research-slice",
  "plan-slice",
  "replan-slice",
  "execute-task",
  "complete-slice",
]);

export function getPriorSliceCompletionBlocker(
  base: string,
  _mainBranch: string,
  unitType: string,
  unitId: string,
): string | null {
  if (!SLICE_DISPATCH_TYPES.has(unitType)) return null;

  const { milestone: targetMid, slice: targetSid } = parseUnitId(unitId);
  if (!targetMid || !targetSid) return null;

  // Parallel worker isolation: when GSD_MILESTONE_LOCK is set, this worker
  // is scoped to a single milestone. Skip the cross-milestone dependency
  // check — other milestones are being handled by their own workers.
  // Without this, the dispatch guard sees incomplete slices in M010/M011
  // (cloned into the worktree DB) and blocks M012 from ever starting. #2797
  const milestoneLock = process.env.GSD_MILESTONE_LOCK;

  // Use findMilestoneIds to respect custom queue order.
  // Only check milestones that come BEFORE the target in queue order.
  // When locked to a specific milestone, only check that milestone's
  // intra-slice dependencies — skip all cross-milestone checks.
  const allIds = milestoneLock && targetMid === milestoneLock
    ? [targetMid]
    : findMilestoneIds(base);
  const targetIdx = allIds.indexOf(targetMid);
  if (targetIdx < 0) return null;
  const milestoneIds = allIds.slice(0, targetIdx + 1);

  for (const mid of milestoneIds) {
    if (resolveMilestoneFile(base, mid, "PARKED")) continue;

    // DB/SUMMARY completion check (#4663 sibling to #4658).
    // Prior behavior treated any SUMMARY file on disk as proof of milestone
    // completion, which is wrong when the SUMMARY is a failure-path report
    // (verification FAILED, blocker placeholder, etc.). Resolve as follows:
    //   1. When DB is available and status is closed → skip (authoritative).
    //   2. When SUMMARY exists but looks like a failure/blocker report →
    //      do not short-circuit; fall through to the slice-level check so
    //      the guard can still block dependents of an active milestone.
    //   3. Otherwise (SUMMARY without failure markers) → skip. Preserves
    //      the #1716 contract where a completed milestone with unchecked
    //      remediation slices is still treated as done.
    const summaryPath = resolveMilestoneFile(base, mid, "SUMMARY");
    if (isDbAvailable()) {
      const milestoneRow = getMilestone(mid);
      if (milestoneRow && isClosedStatus(milestoneRow.status)) continue;
    }
    if (summaryPath) {
      let summaryContent: string | null = null;
      try { summaryContent = readFileSync(summaryPath, "utf-8"); } catch { /* ignore */ }
      if (!summaryContent || classifyMilestoneSummaryContent(summaryContent) !== "failure") {
        continue;
      }
    }

    // Normalised slice list from DB or file fallback
    type NormSlice = { id: string; done: boolean; depends: string[] };
    let slices: NormSlice[] | null = null;

    if (isDbAvailable()) {
      const rows = getMilestoneSlices(mid);
      if (rows.length > 0) {
        slices = rows.map((r) => ({
          id: r.id,
          done: isClosedStatus(r.status),
          depends: r.depends ?? [],
        }));
      }
    }
    if (!slices) {
      // File-based fallback: parse roadmap checkboxes
      const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
      if (!roadmapPath) continue;
      let roadmapContent: string;
      try { roadmapContent = readFileSync(roadmapPath, "utf-8"); } catch { continue; }
      const parsed = parseRoadmap(roadmapContent);
      if (parsed.slices.length === 0) continue;
      slices = parsed.slices.map((s) => ({
        id: s.id,
        done: s.done,
        depends: s.depends ?? [],
      }));
    }

    if (mid !== targetMid) {
      const incomplete = slices.find((slice) => !slice.done);
      if (incomplete) {
        return `Cannot dispatch ${unitType} ${unitId}: earlier slice ${mid}/${incomplete.id} is not complete.`;
      }
      continue;
    }

    const targetSlice = slices.find((slice) => slice.id === targetSid);
    if (!targetSlice) return null;

    // Dependency-aware ordering: if the target slice declares dependencies,
    // only require those specific slices to be complete — not all positionally
    // earlier slices.  This prevents deadlocks when a positionally-earlier
    // slice depends on a positionally-later one (e.g. S05 depends_on S06).
    //
    // When the target has NO declared dependencies, fall back to the original
    // positional ordering for backward compatibility.
    if (targetSlice.depends.length > 0) {
      const sliceMap = new Map(slices.map((s) => [s.id, s]));
      for (const depId of targetSlice.depends) {
        const dep = sliceMap.get(depId);
        if (dep && !dep.done) {
          return `Cannot dispatch ${unitType} ${unitId}: dependency slice ${targetMid}/${depId} is not complete.`;
        }
        // If dep is not found in this milestone's slices, ignore it —
        // it may be a cross-milestone reference handled elsewhere.
      }
    } else {
      const milestoneUsesExplicitDeps = slices.some((slice) => slice.depends.length > 0);
      if (milestoneUsesExplicitDeps) {
        return null;
      }

      // Positional fallback is only a heuristic for legacy slices with no
      // declared dependencies. Skip any earlier slice that depends on the
      // target, directly or transitively, or we can deadlock a valid zero-dep
      // slice behind its own downstream dependents (#3720).
      const reverseDependents = new Set<string>();
      let changed = true;
      while (changed) {
        changed = false;
        for (const slice of slices) {
          if (reverseDependents.has(slice.id)) continue;
          if (slice.depends.some((depId) => depId === targetSid || reverseDependents.has(depId))) {
            reverseDependents.add(slice.id);
            changed = true;
          }
        }
      }

      const targetIndex = slices.findIndex((slice) => slice.id === targetSid);
      const incomplete = slices
        .slice(0, targetIndex)
        .find((slice) => !slice.done && !reverseDependents.has(slice.id));
      if (incomplete) {
        return `Cannot dispatch ${unitType} ${unitId}: earlier slice ${targetMid}/${incomplete.id} is not complete.`;
      }
    }
  }

  return null;
}
