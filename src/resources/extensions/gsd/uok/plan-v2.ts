import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { GSDState, Phase } from "../types.js";
import { gsdRoot, resolveMilestoneFile, resolveSliceFile } from "../paths.js";
import { isDbAvailable, getMilestoneSlices, getSliceTasks, type SliceRow } from "../gsd-db.js";
import type { UokGraphNode } from "./contracts.js";

const PLAN_V2_CLARIFY_ROUND_LIMIT = 3;
const EXECUTION_ENTRY_PHASES: ReadonlySet<Phase> = new Set([
  "executing",
  "summarizing",
  "validating-milestone",
  "completing-milestone",
]);

export interface PlanV2CompileResult {
  ok: boolean;
  reason?: string;
  graphPath?: string;
  nodeCount?: number;
  clarifyRoundLimit?: number;
  researchSynthesized?: boolean;
  draftContextIncluded?: boolean;
  finalizedContextIncluded?: boolean;
}

function graphOutputPath(basePath: string): string {
  return join(gsdRoot(basePath), "runtime", "uok-plan-v2-graph.json");
}

function hasFileContent(path: string | null): boolean {
  if (!path || !existsSync(path)) return false;
  try {
    return readFileSync(path, "utf-8").trim().length > 0;
  } catch {
    return false;
  }
}

function getArtifactLookupBases(basePath: string): string[] {
  const bases = [basePath];
  const projectRoot = process.env.GSD_PROJECT_ROOT;
  if (projectRoot && projectRoot.trim().length > 0 && projectRoot !== basePath) {
    bases.push(projectRoot);
  }
  return bases;
}

function hasMilestoneFileContent(
  basePath: string,
  milestoneId: string,
  suffix: string,
): boolean {
  const bases = getArtifactLookupBases(basePath);
  for (const candidateBase of bases) {
    if (hasFileContent(resolveMilestoneFile(candidateBase, milestoneId, suffix))) {
      return true;
    }
  }
  return false;
}

function countSliceResearchArtifacts(basePath: string, milestoneId: string, slices: SliceRow[]): number {
  let count = 0;
  for (const slice of slices) {
    if (hasFileContent(resolveSliceFile(basePath, milestoneId, slice.id, "RESEARCH"))) {
      count += 1;
    }
  }
  return count;
}

function isExecutionEntryPhase(phase: Phase): boolean {
  return EXECUTION_ENTRY_PHASES.has(phase);
}

export function compileUnitGraphFromState(basePath: string, state: GSDState): PlanV2CompileResult {
  const mid = state.activeMilestone?.id;
  if (!mid) return { ok: false, reason: "no active milestone" };
  if (!isDbAvailable()) return { ok: false, reason: "database not available" };

  const slices = getMilestoneSlices(mid).sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0));
  const nodes: UokGraphNode[] = [];
  const clarifyRoundLimit = PLAN_V2_CLARIFY_ROUND_LIMIT;
  const draftContextIncluded = hasMilestoneFileContent(basePath, mid, "CONTEXT-DRAFT");
  const finalizedContextIncluded = hasMilestoneFileContent(basePath, mid, "CONTEXT");
  const researchSynthesized = hasMilestoneFileContent(basePath, mid, "RESEARCH")
    || countSliceResearchArtifacts(basePath, mid, slices) > 0;

  if (isExecutionEntryPhase(state.phase) && !finalizedContextIncluded) {
    const reason = draftContextIncluded
      ? "milestone context draft exists but finalized CONTEXT.md is missing"
      : "missing milestone CONTEXT.md";
    return {
      ok: false,
      reason,
      clarifyRoundLimit,
      researchSynthesized,
      draftContextIncluded,
      finalizedContextIncluded,
    };
  }

  for (const slice of slices) {
    const sid = slice.id;
    const tasks = getSliceTasks(mid, sid)
      .sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0));

    let previousTaskNodeId: string | null = null;
    for (const task of tasks) {
      const nodeId = `execute-task:${mid}:${sid}:${task.id}`;
      const dependsOn = previousTaskNodeId ? [previousTaskNodeId] : [];
      nodes.push({
        id: nodeId,
        kind: "unit",
        dependsOn,
        writes: task.key_files,
        metadata: {
          unitType: "execute-task",
          unitId: `${mid}.${sid}.${task.id}`,
          title: task.title,
          status: task.status,
        },
      });
      previousTaskNodeId = nodeId;
    }

    if (previousTaskNodeId) {
      nodes.push({
        id: `complete-slice:${mid}:${sid}`,
        kind: "verification",
        dependsOn: [previousTaskNodeId],
        metadata: {
          unitType: "complete-slice",
          unitId: `${mid}.${sid}`,
          title: slice.title,
          status: slice.status,
        },
      });
    }
  }

  const output = {
    compiledAt: new Date().toISOString(),
    milestoneId: mid,
    pipeline: {
      clarifyRoundLimit,
      researchSynthesized,
      draftContextIncluded,
      finalizedContextIncluded,
      sourcePhase: state.phase,
    },
    nodes,
  };

  const outPath = graphOutputPath(basePath);
  mkdirSync(join(gsdRoot(basePath), "runtime"), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n", "utf-8");

  return {
    ok: true,
    graphPath: outPath,
    nodeCount: nodes.length,
    clarifyRoundLimit,
    researchSynthesized: output.pipeline.researchSynthesized,
    draftContextIncluded: output.pipeline.draftContextIncluded,
    finalizedContextIncluded: output.pipeline.finalizedContextIncluded,
  };
}

export function ensurePlanV2Graph(basePath: string, state: GSDState): PlanV2CompileResult {
  const compiled = compileUnitGraphFromState(basePath, state);
  if (!compiled.ok) return compiled;
  if ((compiled.nodeCount ?? 0) <= 0) {
    return { ok: false, reason: "compiled graph is empty" };
  }
  return compiled;
}
