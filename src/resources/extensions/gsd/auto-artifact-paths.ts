// GSD Auto-mode — Artifact Path Resolution
//
// resolveExpectedArtifactPath and diagnoseExpectedArtifact moved here from
// auto-recovery.ts (Phase 5 dead-code cleanup). The artifact verification
// function was removed entirely — callers now query WorkflowEngine directly.

import {
  gsdRoot,
  resolveMilestoneFile,
  resolveMilestonePath,
  resolveSliceFile,
  resolveSlicePath,
  relMilestoneFile,
  relSliceFile,
  buildMilestoneFileName,
  buildSliceFileName,
  buildTaskFileName,
} from "./paths.js";
import { parseUnitId } from "./unit-id.js";
import { join } from "node:path";

function resolveMilestoneArtifactPath(
  base: string,
  mid: string,
  suffix: string,
): string | null {
  const existing = resolveMilestoneFile(base, mid, suffix);
  if (existing) return existing;
  const dir = resolveMilestonePath(base, mid);
  return dir ? join(dir, buildMilestoneFileName(mid, suffix)) : null;
}

function resolveSliceArtifactPath(
  base: string,
  mid: string,
  sid: string,
  suffix: string,
): string | null {
  const existing = resolveSliceFile(base, mid, sid, suffix);
  if (existing) return existing;
  const dir = resolveSlicePath(base, mid, sid);
  return dir ? join(dir, buildSliceFileName(sid, suffix)) : null;
}

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
    case "workflow-preferences":
      return join(gsdRoot(base), "PREFERENCES.md");
    case "discuss-project":
      return join(gsdRoot(base), "PROJECT.md");
    case "discuss-requirements":
      return join(gsdRoot(base), "REQUIREMENTS.md");
    case "research-decision":
      return join(gsdRoot(base), "runtime", "research-decision.json");
    case "research-project":
      return join(gsdRoot(base), "research", "PROJECT-RESEARCH-BLOCKER.md");
    case "discuss-milestone": {
      return resolveMilestoneArtifactPath(base, mid, "CONTEXT");
    }
    case "discuss-slice": {
      return resolveSliceArtifactPath(base, mid, sid!, "CONTEXT");
    }
    case "research-milestone": {
      return resolveMilestoneArtifactPath(base, mid, "RESEARCH");
    }
    case "plan-milestone": {
      return resolveMilestoneArtifactPath(base, mid, "ROADMAP");
    }
    case "research-slice": {
      // #4414: Sentinel unitId "{mid}/parallel-research" fans out across
      // multiple slices. Resolve to a milestone-level placeholder path so
      // blocker escalation has somewhere to write. Verification for this
      // sentinel is handled directly in verifyExpectedArtifact.
      if (sid === "parallel-research") {
        return resolveMilestoneArtifactPath(base, mid, "PARALLEL-BLOCKER");
      }
      return resolveSliceArtifactPath(base, mid, sid!, "RESEARCH");
    }
    case "plan-slice": {
      return resolveSliceArtifactPath(base, mid, sid!, "PLAN");
    }
    case "refine-slice": {
      // ADR-011: refine-slice expands a sketch and writes the same PLAN.md as plan-slice.
      return resolveSliceArtifactPath(base, mid, sid!, "PLAN");
    }
    case "reassess-roadmap": {
      return resolveSliceArtifactPath(base, mid, sid!, "ASSESSMENT");
    }
    case "run-uat": {
      return resolveSliceArtifactPath(base, mid, sid!, "ASSESSMENT");
    }
    case "execute-task": {
      const dir = resolveSlicePath(base, mid, sid!);
      return dir && tid
        ? join(dir, "tasks", buildTaskFileName(tid, "SUMMARY"))
        : null;
    }
    case "complete-slice": {
      return resolveSliceArtifactPath(base, mid, sid!, "SUMMARY");
    }
    case "validate-milestone": {
      return resolveMilestoneArtifactPath(base, mid, "VALIDATION");
    }
    case "complete-milestone": {
      return resolveMilestoneArtifactPath(base, mid, "SUMMARY");
    }
    case "replan-slice": {
      return resolveSliceArtifactPath(base, mid, sid!, "REPLAN");
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
    case "workflow-preferences":
      return ".gsd/PREFERENCES.md with workflow_prefs_captured: true";
    case "discuss-project":
      return ".gsd/PROJECT.md (valid project context)";
    case "discuss-requirements":
      return ".gsd/REQUIREMENTS.md (valid requirements registry)";
    case "research-decision":
      return ".gsd/runtime/research-decision.json with decision research|skip";
    case "research-project":
      return ".gsd/research/{STACK,FEATURES,ARCHITECTURE,PITFALLS}.md with at least one real research file; blocker-only outputs stop";
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
