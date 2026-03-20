/**
 * Auto-mode Dispatch Table — declarative phase → unit mapping.
 *
 * Each rule maps a GSD state to the unit type, unit ID, and prompt builder
 * that should be dispatched. Rules are evaluated in order; the first match wins.
 *
 * This replaces the 130-line if-else chain in dispatchNextUnit with a
 * data structure that is inspectable, testable per-rule, and extensible
 * without modifying orchestration code.
 */

import type { GSDState } from "./types.js";
import type { GSDPreferences } from "./preferences.js";
import type { UatType } from "./files.js";
import { loadFile, extractUatType, loadActiveOverrides, parseRoadmap } from "./files.js";
import {
  resolveMilestoneFile,
  resolveMilestonePath,
  resolveSliceFile,
  resolveSlicePath,
  resolveTaskFile,
  relSliceFile,
  buildMilestoneFileName,
  buildSliceFileName,
} from "./paths.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildResearchMilestonePrompt,
  buildPlanMilestonePrompt,
  buildResearchSlicePrompt,
  buildPlanSlicePrompt,
  buildExecuteTaskPrompt,
  buildCompleteSlicePrompt,
  buildCompleteMilestonePrompt,
  buildValidateMilestonePrompt,
  buildReplanSlicePrompt,
  buildRunUatPrompt,
  buildReassessRoadmapPrompt,
  buildRewriteDocsPrompt,
  buildReactiveExecutePrompt,
  checkNeedsReassessment,
  checkNeedsRunUat,
} from "./auto-prompts.js";

// ─── Types ────────────────────────────────────────────────────────────────

export type DispatchAction =
  | {
      action: "dispatch";
      unitType: string;
      unitId: string;
      prompt: string;
      pauseAfterDispatch?: boolean;
    }
  | { action: "stop"; reason: string; level: "info" | "warning" | "error" }
  | { action: "skip" };

export interface DispatchContext {
  basePath: string;
  mid: string;
  midTitle: string;
  state: GSDState;
  prefs: GSDPreferences | undefined;
}

interface DispatchRule {
  /** Human-readable name for debugging and test identification */
  name: string;
  /** Return a DispatchAction if this rule matches, null to fall through */
  match: (ctx: DispatchContext) => Promise<DispatchAction | null>;
}

function missingSliceStop(mid: string, phase: string): DispatchAction {
  return {
    action: "stop",
    reason: `${mid}: phase "${phase}" has no active slice — run /gsd doctor.`,
    level: "error",
  };
}

// ─── Rewrite Circuit Breaker ──────────────────────────────────────────────

const MAX_REWRITE_ATTEMPTS = 3;
let rewriteAttemptCount = 0;
export function resetRewriteCircuitBreaker(): void {
  rewriteAttemptCount = 0;
}

// ─── Rules ────────────────────────────────────────────────────────────────

const DISPATCH_RULES: DispatchRule[] = [
  {
    name: "rewrite-docs (override gate)",
    match: async ({ mid, midTitle, state, basePath }) => {
      const pendingOverrides = await loadActiveOverrides(basePath);
      if (pendingOverrides.length === 0) return null;
      if (rewriteAttemptCount >= MAX_REWRITE_ATTEMPTS) {
        const { resolveAllOverrides } = await import("./files.js");
        await resolveAllOverrides(basePath);
        rewriteAttemptCount = 0;
        return null;
      }
      rewriteAttemptCount++;
      const unitId = state.activeSlice ? `${mid}/${state.activeSlice.id}` : mid;
      return {
        action: "dispatch",
        unitType: "rewrite-docs",
        unitId,
        prompt: await buildRewriteDocsPrompt(
          mid,
          midTitle,
          state.activeSlice,
          basePath,
          pendingOverrides,
        ),
      };
    },
  },
  {
    name: "summarizing → complete-slice",
    match: async ({ state, mid, midTitle, basePath }) => {
      if (state.phase !== "summarizing") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice!.id;
      const sTitle = state.activeSlice!.title;
      return {
        action: "dispatch",
        unitType: "complete-slice",
        unitId: `${mid}/${sid}`,
        prompt: await buildCompleteSlicePrompt(
          mid,
          midTitle,
          sid,
          sTitle,
          basePath,
        ),
      };
    },
  },
  {
    name: "run-uat (post-completion)",
    match: async ({ state, mid, basePath, prefs }) => {
      const needsRunUat = await checkNeedsRunUat(basePath, mid, state, prefs);
      if (!needsRunUat) return null;
      const { sliceId, uatType } = needsRunUat;
      const uatFile = resolveSliceFile(basePath, mid, sliceId, "UAT")!;
      const uatContent = await loadFile(uatFile);
      return {
        action: "dispatch",
        unitType: "run-uat",
        unitId: `${mid}/${sliceId}`,
        prompt: await buildRunUatPrompt(
          mid,
          sliceId,
          relSliceFile(basePath, mid, sliceId, "UAT"),
          uatContent ?? "",
          basePath,
        ),
        pauseAfterDispatch: uatType !== "artifact-driven",
      };
    },
  },
  {
    name: "reassess-roadmap (post-completion)",
    match: async ({ state, mid, midTitle, basePath, prefs }) => {
      if (prefs?.phases?.skip_reassess || !prefs?.phases?.reassess_after_slice)
        return null;
      const needsReassess = await checkNeedsReassessment(basePath, mid, state);
      if (!needsReassess) return null;
      return {
        action: "dispatch",
        unitType: "reassess-roadmap",
        unitId: `${mid}/${needsReassess.sliceId}`,
        prompt: await buildReassessRoadmapPrompt(
          mid,
          midTitle,
          needsReassess.sliceId,
          basePath,
        ),
      };
    },
  },
  {
    name: "needs-discussion → stop",
    match: async ({ state, mid, midTitle }) => {
      if (state.phase !== "needs-discussion") return null;
      return {
        action: "stop",
        reason: `${mid}: ${midTitle} has draft context from a prior discussion — needs its own discussion before planning.\nRun /gsd to discuss.`,
        level: "warning",
      };
    },
  },
  {
    name: "pre-planning (no context) → stop",
    match: async ({ state, mid, basePath }) => {
      if (state.phase !== "pre-planning") return null;
      const contextFile = resolveMilestoneFile(basePath, mid, "CONTEXT");
      const hasContext = !!(contextFile && (await loadFile(contextFile)));
      if (hasContext) return null; // fall through to next rule
      return {
        action: "stop",
        reason: "No context or roadmap yet. Run /gsd to discuss first.",
        level: "warning",
      };
    },
  },
  {
    name: "pre-planning (no research) → research-milestone",
    match: async ({ state, mid, midTitle, basePath, prefs }) => {
      if (state.phase !== "pre-planning") return null;
      // Phase skip: skip research when preference or profile says so
      if (prefs?.phases?.skip_research) return null;
      const researchFile = resolveMilestoneFile(basePath, mid, "RESEARCH");
      if (researchFile) return null; // has research, fall through
      return {
        action: "dispatch",
        unitType: "research-milestone",
        unitId: mid,
        prompt: await buildResearchMilestonePrompt(mid, midTitle, basePath),
      };
    },
  },
  {
    name: "pre-planning (has research) → plan-milestone",
    match: async ({ state, mid, midTitle, basePath }) => {
      if (state.phase !== "pre-planning") return null;
      return {
        action: "dispatch",
        unitType: "plan-milestone",
        unitId: mid,
        prompt: await buildPlanMilestonePrompt(mid, midTitle, basePath),
      };
    },
  },
  {
    name: "planning (no research, not S01) → research-slice",
    match: async ({ state, mid, midTitle, basePath, prefs }) => {
      if (state.phase !== "planning") return null;
      // Phase skip: skip research when preference or profile says so
      if (prefs?.phases?.skip_research || prefs?.phases?.skip_slice_research)
        return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice!.id;
      const sTitle = state.activeSlice!.title;
      const researchFile = resolveSliceFile(basePath, mid, sid, "RESEARCH");
      if (researchFile) return null; // has research, fall through
      // Skip slice research for S01 when milestone research already exists —
      // the milestone research already covers the same ground for the first slice.
      const milestoneResearchFile = resolveMilestoneFile(
        basePath,
        mid,
        "RESEARCH",
      );
      if (milestoneResearchFile && sid === "S01") return null; // fall through to plan-slice
      return {
        action: "dispatch",
        unitType: "research-slice",
        unitId: `${mid}/${sid}`,
        prompt: await buildResearchSlicePrompt(
          mid,
          midTitle,
          sid,
          sTitle,
          basePath,
        ),
      };
    },
  },
  {
    name: "planning → plan-slice",
    match: async ({ state, mid, midTitle, basePath }) => {
      if (state.phase !== "planning") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice!.id;
      const sTitle = state.activeSlice!.title;
      return {
        action: "dispatch",
        unitType: "plan-slice",
        unitId: `${mid}/${sid}`,
        prompt: await buildPlanSlicePrompt(
          mid,
          midTitle,
          sid,
          sTitle,
          basePath,
        ),
      };
    },
  },
  {
    name: "replanning-slice → replan-slice",
    match: async ({ state, mid, midTitle, basePath }) => {
      if (state.phase !== "replanning-slice") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice!.id;
      const sTitle = state.activeSlice!.title;
      return {
        action: "dispatch",
        unitType: "replan-slice",
        unitId: `${mid}/${sid}`,
        prompt: await buildReplanSlicePrompt(
          mid,
          midTitle,
          sid,
          sTitle,
          basePath,
        ),
      };
    },
  },
  {
    name: "executing → reactive-execute (parallel dispatch)",
    match: async ({ state, mid, midTitle, basePath, prefs }) => {
      if (state.phase !== "executing" || !state.activeTask) return null;
      if (!state.activeSlice) return null; // fall through

      // Only activate when reactive_execution is explicitly enabled
      const reactiveConfig = prefs?.reactive_execution;
      if (!reactiveConfig?.enabled) return null;

      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;
      const maxParallel = reactiveConfig.max_parallel ?? 2;

      // Dry-run mode: max_parallel=1 means graph is derived and logged but
      // execution remains sequential
      if (maxParallel <= 1) return null;

      try {
        const {
          loadSliceTaskIO,
          deriveTaskGraph,
          isGraphAmbiguous,
          getReadyTasks,
          chooseNonConflictingSubset,
          graphMetrics,
        } = await import("./reactive-graph.js");

        const taskIO = await loadSliceTaskIO(basePath, mid, sid);
        if (taskIO.length < 2) return null; // single task, no point

        const graph = deriveTaskGraph(taskIO);

        // Ambiguous graph → fall through to sequential
        if (isGraphAmbiguous(graph)) return null;

        const completed = new Set(graph.filter((n) => n.done).map((n) => n.id));
        const readyIds = getReadyTasks(graph, completed, new Set());

        // Only activate reactive dispatch when >1 task is ready
        if (readyIds.length <= 1) return null;

        const selected = chooseNonConflictingSubset(
          readyIds,
          graph,
          maxParallel,
          new Set(),
        );
        if (selected.length <= 1) return null;

        // Log graph metrics for observability
        const metrics = graphMetrics(graph);
        process.stderr.write(
          `gsd-reactive: ${mid}/${sid} graph — tasks:${metrics.taskCount} edges:${metrics.edgeCount} ` +
          `ready:${metrics.readySetSize} dispatching:${selected.length} ambiguous:${metrics.ambiguous}\n`,
        );

        // Persist dispatched batch so verification and recovery can check
        // exactly which tasks were sent.
        const { saveReactiveState } = await import("./reactive-graph.js");
        saveReactiveState(basePath, mid, sid, {
          sliceId: sid,
          completed: [...completed],
          dispatched: selected,
          graphSnapshot: metrics,
          updatedAt: new Date().toISOString(),
        });

        // Encode selected task IDs in unitId for artifact verification.
        // Format: M001/S01/reactive+T02,T03
        const batchSuffix = selected.join(",");

        return {
          action: "dispatch",
          unitType: "reactive-execute",
          unitId: `${mid}/${sid}/reactive+${batchSuffix}`,
          prompt: await buildReactiveExecutePrompt(
            mid,
            midTitle,
            sid,
            sTitle,
            selected,
            basePath,
          ),
        };
      } catch (err) {
        // Non-fatal — fall through to sequential execution
        process.stderr.write(`gsd-reactive: graph derivation failed: ${(err as Error).message}\n`);
        return null;
      }
    },
  },
  {
    name: "executing → execute-task (recover missing task plan → plan-slice)",
    match: async ({ state, mid, midTitle, basePath }) => {
      if (state.phase !== "executing" || !state.activeTask) return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice!.id;
      const sTitle = state.activeSlice!.title;
      const tid = state.activeTask.id;

      // Guard: if the slice plan exists but the individual task plan files are
      // missing, the planner created S##-PLAN.md with task entries but never
      // wrote the tasks/ directory files. Dispatch plan-slice to regenerate
      // them rather than hard-stopping — fixes the infinite-loop described in
      // issue #909.
      const taskPlanPath = resolveTaskFile(basePath, mid, sid, tid, "PLAN");
      if (!taskPlanPath || !existsSync(taskPlanPath)) {
        return {
          action: "dispatch",
          unitType: "plan-slice",
          unitId: `${mid}/${sid}`,
          prompt: await buildPlanSlicePrompt(
            mid,
            midTitle,
            sid,
            sTitle,
            basePath,
          ),
        };
      }

      return null;
    },
  },
  {
    name: "executing → execute-task",
    match: async ({ state, mid, basePath }) => {
      if (state.phase !== "executing" || !state.activeTask) return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice!.id;
      const sTitle = state.activeSlice!.title;
      const tid = state.activeTask.id;
      const tTitle = state.activeTask.title;

      return {
        action: "dispatch",
        unitType: "execute-task",
        unitId: `${mid}/${sid}/${tid}`,
        prompt: await buildExecuteTaskPrompt(
          mid,
          sid,
          sTitle,
          tid,
          tTitle,
          basePath,
        ),
      };
    },
  },
  {
    name: "validating-milestone → validate-milestone",
    match: async ({ state, mid, midTitle, basePath, prefs }) => {
      if (state.phase !== "validating-milestone") return null;

      // Safety guard (#1368): verify all roadmap slices have SUMMARY files before
      // allowing milestone validation. If any slice lacks a summary, the milestone
      // is not genuinely complete — something skipped earlier slices.
      const roadmapFile = resolveMilestoneFile(basePath, mid, "ROADMAP");
      const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
      if (roadmapContent) {
        const roadmap = parseRoadmap(roadmapContent);
        const missingSlices: string[] = [];
        for (const slice of roadmap.slices) {
          const summaryPath = resolveSliceFile(basePath, mid, slice.id, "SUMMARY");
          if (!summaryPath || !existsSync(summaryPath)) {
            missingSlices.push(slice.id);
          }
        }
        if (missingSlices.length > 0) {
          return {
            action: "stop",
            reason: `Cannot validate milestone ${mid}: slices ${missingSlices.join(", ")} are missing SUMMARY files. These slices may have been skipped.`,
            level: "error",
          };
        }
      }

      // Skip preference: write a minimal pass-through VALIDATION file
      if (prefs?.phases?.skip_milestone_validation) {
        const mDir = resolveMilestonePath(basePath, mid);
        if (mDir) {
          if (!existsSync(mDir)) mkdirSync(mDir, { recursive: true });
          const validationPath = join(
            mDir,
            buildMilestoneFileName(mid, "VALIDATION"),
          );
          const content = [
            "---",
            "verdict: pass",
            "remediation_round: 0",
            "---",
            "",
            "# Milestone Validation (skipped by preference)",
            "",
            "Milestone validation was skipped via `skip_milestone_validation` preference.",
          ].join("\n");
          writeFileSync(validationPath, content, "utf-8");
        }
        return { action: "skip" };
      }
      return {
        action: "dispatch",
        unitType: "validate-milestone",
        unitId: mid,
        prompt: await buildValidateMilestonePrompt(mid, midTitle, basePath),
      };
    },
  },
  {
    name: "completing-milestone → complete-milestone",
    match: async ({ state, mid, midTitle, basePath }) => {
      if (state.phase !== "completing-milestone") return null;

      // Safety guard (#1368): verify all roadmap slices have SUMMARY files.
      const roadmapFile = resolveMilestoneFile(basePath, mid, "ROADMAP");
      const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
      if (roadmapContent) {
        const roadmap = parseRoadmap(roadmapContent);
        const missingSlices: string[] = [];
        for (const slice of roadmap.slices) {
          const summaryPath = resolveSliceFile(basePath, mid, slice.id, "SUMMARY");
          if (!summaryPath || !existsSync(summaryPath)) {
            missingSlices.push(slice.id);
          }
        }
        if (missingSlices.length > 0) {
          return {
            action: "stop",
            reason: `Cannot complete milestone ${mid}: slices ${missingSlices.join(", ")} are missing SUMMARY files. Run /gsd doctor to diagnose.`,
            level: "error",
          };
        }
      }

      return {
        action: "dispatch",
        unitType: "complete-milestone",
        unitId: mid,
        prompt: await buildCompleteMilestonePrompt(mid, midTitle, basePath),
      };
    },
  },
  {
    name: "complete → stop",
    match: async ({ state }) => {
      if (state.phase !== "complete") return null;
      return {
        action: "stop",
        reason: "All milestones complete.",
        level: "info",
      };
    },
  },
];

// ─── Resolver ─────────────────────────────────────────────────────────────

/**
 * Evaluate dispatch rules in order. Returns the first matching action,
 * or a "stop" action if no rule matches (unhandled phase).
 */
export async function resolveDispatch(
  ctx: DispatchContext,
): Promise<DispatchAction> {
  for (const rule of DISPATCH_RULES) {
    const result = await rule.match(ctx);
    if (result) return result;
  }

  // No rule matched — unhandled phase
  return {
    action: "stop",
    reason: `Unhandled phase "${ctx.state.phase}" — run /gsd doctor to diagnose.`,
    level: "info",
  };
}

/** Exposed for testing — returns the rule names in evaluation order. */
export function getDispatchRuleNames(): string[] {
  return DISPATCH_RULES.map((r) => r.name);
}
