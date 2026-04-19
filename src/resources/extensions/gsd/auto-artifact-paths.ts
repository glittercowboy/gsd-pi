// GSD Auto-mode — Artifact Path Resolution
//
// resolveExpectedArtifactPath and diagnoseExpectedArtifact moved here from
// auto-recovery.ts (Phase 5 dead-code cleanup). The artifact verification
// function was removed entirely — callers now query WorkflowEngine directly.

import {
  resolveMilestonePath,
  resolveSlicePath,
  relMilestoneFile,
  relSliceFile,
  buildMilestoneFileName,
  buildSliceFileName,
  buildTaskFileName,
} from "./paths.js";
import { parseUnitId } from "./unit-id.js";
import { join } from "node:path";

/**
 * Resolve the expected artifact for a unit to an absolute path.
 */
export function resolveExpectedArtifactPath(
  unitType: string,
  unitId: string,
  base: string,
): string | null {
  const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
  switch (unitType) {
    case "discuss-milestone": {
      const dir = resolveMilestonePath(base, mid);
      return dir ? join(dir, buildMilestoneFileName(mid, "CONTEXT")) : null;
    }
    case "discuss-slice": {
      const dir = resolveSlicePath(base, mid, sid!);
      return dir ? join(dir, buildSliceFileName(sid!, "CONTEXT")) : null;
    }
    case "research-milestone": {
      const dir = resolveMilestonePath(base, mid);
      return dir ? join(dir, buildMilestoneFileName(mid, "RESEARCH")) : null;
    }
    case "plan-milestone": {
      const dir = resolveMilestonePath(base, mid);
      return dir ? join(dir, buildMilestoneFileName(mid, "ROADMAP")) : null;
    }
    case "research-slice": {
      // #4414: Sentinel unitId "{mid}/parallel-research" fans out across
      // multiple slices. Resolve to a milestone-level placeholder path so
      // blocker escalation has somewhere to write. Verification for this
      // sentinel is handled directly in verifyExpectedArtifact.
      if (sid === "parallel-research") {
        const mdir = resolveMilestonePath(base, mid);
        return mdir
          ? join(mdir, buildMilestoneFileName(mid, "PARALLEL-BLOCKER"))
          : null;
      }
      const dir = resolveSlicePath(base, mid, sid!);
      return dir ? join(dir, buildSliceFileName(sid!, "RESEARCH")) : null;
    }
    case "plan-slice": {
      const dir = resolveSlicePath(base, mid, sid!);
      return dir ? join(dir, buildSliceFileName(sid!, "PLAN")) : null;
    }
    case "refine-slice": {
      // ADR-011: refine-slice expands a sketch and writes the same PLAN.md as plan-slice.
      const dir = resolveSlicePath(base, mid, sid!);
      return dir ? join(dir, buildSliceFileName(sid!, "PLAN")) : null;
    }
    case "reassess-roadmap": {
      const dir = resolveSlicePath(base, mid, sid!);
      return dir ? join(dir, buildSliceFileName(sid!, "ASSESSMENT")) : null;
    }
    case "run-uat": {
      const dir = resolveSlicePath(base, mid, sid!);
      return dir ? join(dir, buildSliceFileName(sid!, "ASSESSMENT")) : null;
    }
    case "execute-task": {
      const dir = resolveSlicePath(base, mid, sid!);
      return dir && tid
        ? join(dir, "tasks", buildTaskFileName(tid, "SUMMARY"))
        : null;
    }
    case "complete-slice": {
      const dir = resolveSlicePath(base, mid, sid!);
      return dir ? join(dir, buildSliceFileName(sid!, "SUMMARY")) : null;
    }
    case "validate-milestone": {
      const dir = resolveMilestonePath(base, mid);
      return dir ? join(dir, buildMilestoneFileName(mid, "VALIDATION")) : null;
    }
    case "complete-milestone": {
      const dir = resolveMilestonePath(base, mid);
      return dir ? join(dir, buildMilestoneFileName(mid, "SUMMARY")) : null;
    }
    case "replan-slice": {
      const dir = resolveSlicePath(base, mid, sid!);
      return dir ? join(dir, buildSliceFileName(sid!, "REPLAN")) : null;
    }
    case "rewrite-docs":
      return null;
    case "gate-evaluate":
      // Gate evaluate writes to DB quality_gates table — verified via state derivation
      return null;
    case "reactive-execute":
      // Reactive execute produces multiple task summaries — verified separately
      return null;
    default:
      return null;
  }
}

export function diagnoseExpectedArtifact(
  unitType: string,
  unitId: string,
  base: string,
): string | null {
  const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
  switch (unitType) {
    case "discuss-milestone":
      return `${relMilestoneFile(base, mid, "CONTEXT")} (milestone context from discussion)`;
    case "discuss-slice":
      return `${relSliceFile(base, mid, sid!, "CONTEXT")} (slice context from discussion)`;
    case "research-milestone":
      return `${relMilestoneFile(base, mid, "RESEARCH")} (milestone research)`;
    case "plan-milestone":
      return `${relMilestoneFile(base, mid, "ROADMAP")} (milestone roadmap)`;
    case "research-slice":
      if (sid === "parallel-research") {
        return `${relMilestoneFile(base, mid, "PARALLEL-BLOCKER")} (parallel slice research sentinel)`;
      }
      return `${relSliceFile(base, mid, sid!, "RESEARCH")} (slice research)`;
    case "plan-slice":
      return `${relSliceFile(base, mid, sid!, "PLAN")} (slice plan)`;
    case "refine-slice":
      return `${relSliceFile(base, mid, sid!, "PLAN")} (refined slice plan from sketch)`;
    case "execute-task": {
      return `Task ${tid} marked [x] in ${relSliceFile(base, mid, sid!, "PLAN")} + summary written`;
    }
    case "complete-slice":
      return `Slice ${sid} marked [x] in ${relMilestoneFile(base, mid, "ROADMAP")} + summary + UAT written`;
    case "replan-slice":
      return `${relSliceFile(base, mid, sid!, "REPLAN")} + updated ${relSliceFile(base, mid, sid!, "PLAN")}`;
    case "rewrite-docs":
      return "Active overrides resolved in .gsd/OVERRIDES.md + plan documents updated";
    case "reassess-roadmap":
      return `${relSliceFile(base, mid, sid!, "ASSESSMENT")} (roadmap reassessment)`;
    case "run-uat":
      return `${relSliceFile(base, mid, sid!, "ASSESSMENT")} (UAT assessment result)`;
    case "validate-milestone":
      return `${relMilestoneFile(base, mid, "VALIDATION")} (milestone validation report)`;
    case "complete-milestone":
      return `${relMilestoneFile(base, mid, "SUMMARY")} (milestone summary)`;
    default:
      return null;
  }
}
