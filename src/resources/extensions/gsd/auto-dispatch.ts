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
import { loadFile, extractUatType, loadActiveOverrides } from "./files.js";
import {
  resolveMilestoneFile, resolveMilestonePath, resolveSliceFile, resolveTaskFile,
  relSliceFile, buildMilestoneFileName,
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
  checkNeedsReassessment,
  checkNeedsRunUat,
} from "./auto-prompts.js";

// ─── Types ────────────────────────────────────────────────────────────────

export type DispatchAction =
  | { action: "dispatch"; unitType: string; unitId: string; prompt: string; pauseAfterDispatch?: boolean }
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
        prompt: await buildRewriteDocsPrompt(mid, midTitle, state.activeSlice, basePath, pendingOverrides),
      };
    },
  },
  {
    name: "summarizing → complete-slice",
    match: async ({ state, mid, midTitle, basePath }) => {
      if (state.phase !== "summarizing") return null;
      const sid = state.activeSlice!.id;
      const sTitle = state.activeSlice!.title;
      return {
        action: "dispatch",
        unitType: "complete-slice",
        unitId: `${mid}/${sid}`,
        prompt: await buildCompleteSlicePrompt(mid, midTitle, sid, sTitle, basePath),
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
          mid, sliceId, relSliceFile(basePath, mid, sliceId, "UAT"), uatContent ?? "", basePath,
        ),
        pauseAfterDispatch: uatType !== "artifact-driven",
      };
    },
  },
  {
    name: "reassess-roadmap (post-completion)",
    match: async ({ state, mid, midTitle, basePath, prefs }) => {
      // Phase skip: skip reassess when preference or profile says so
      if (prefs?.phases?.skip_reassess) return null;
      const needsReassess = await checkNeedsReassessment(basePath, mid, state);
      if (!needsReassess) return null;
      return {
        action: "dispatch",
        unitType: "reassess-roadmap",
        unitId: `${mid}/${needsReassess.sliceId}`,
        prompt: await buildReassessRoadmapPrompt(mid, midTitle, needsReassess.sliceId, basePath),
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
      const hasContext = !!(contextFile && await loadFile(contextFile));
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
      if (prefs?.phases?.skip_research || prefs?.phases?.skip_slice_research) return null;
      const sid = state.activeSlice!.id;
      const sTitle = state.activeSlice!.title;
      const researchFile = resolveSliceFile(basePath, mid, sid, "RESEARCH");
      if (researchFile) return null; // has research, fall through
      // Skip slice research for S01 when milestone research already exists —
      // the milestone research already covers the same ground for the first slice.
      const milestoneResearchFile = resolveMilestoneFile(basePath, mid, "RESEARCH");
      if (milestoneResearchFile && sid === "S01") return null; // fall through to plan-slice
      return {
        action: "dispatch",
        unitType: "research-slice",
        unitId: `${mid}/${sid}`,
        prompt: await buildResearchSlicePrompt(mid, midTitle, sid, sTitle, basePath),
      };
    },
  },
  {
    name: "planning → plan-slice",
    match: async ({ state, mid, midTitle, basePath }) => {
      if (state.phase !== "planning") return null;
      const sid = state.activeSlice!.id;
      const sTitle = state.activeSlice!.title;
      return {
        action: "dispatch",
        unitType: "plan-slice",
        unitId: `${mid}/${sid}`,
        prompt: await buildPlanSlicePrompt(mid, midTitle, sid, sTitle, basePath),
      };
    },
  },
  {
    name: "replanning-slice → replan-slice",
    match: async ({ state, mid, midTitle, basePath }) => {
      if (state.phase !== "replanning-slice") return null;
      const sid = state.activeSlice!.id;
      const sTitle = state.activeSlice!.title;
      return {
        action: "dispatch",
        unitType: "replan-slice",
        unitId: `${mid}/${sid}`,
        prompt: await buildReplanSlicePrompt(mid, midTitle, sid, sTitle, basePath),
      };
    },
  },
  {
    name: "executing → execute-task (recover missing task plan → plan-slice)",
    match: async ({ state, mid, midTitle, basePath }) => {
      if (state.phase !== "executing" || !state.activeTask) return null;
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
          prompt: await buildPlanSlicePrompt(mid, midTitle, sid, sTitle, basePath),
        };
      }

      return null;
    },
  },
  {
    name: "executing → execute-task",
    match: async ({ state, mid, basePath }) => {
      if (state.phase !== "executing" || !state.activeTask) return null;
      const sid = state.activeSlice!.id;
      const sTitle = state.activeSlice!.title;
      const tid = state.activeTask.id;
      const tTitle = state.activeTask.title;

      return {
        action: "dispatch",
        unitType: "execute-task",
        unitId: `${mid}/${sid}/${tid}`,
        prompt: await buildExecuteTaskPrompt(mid, sid, sTitle, tid, tTitle, basePath),
      };
    },
  },
  {
    name: "validating-milestone → validate-milestone",
    match: async ({ state, mid, midTitle, basePath, prefs }) => {
      if (state.phase !== "validating-milestone") return null;
      // Skip preference: write a minimal pass-through VALIDATION file
      if (prefs?.phases?.skip_milestone_validation) {
        const mDir = resolveMilestonePath(basePath, mid);
        if (mDir) {
          if (!existsSync(mDir)) mkdirSync(mDir, { recursive: true });
          const validationPath = join(mDir, buildMilestoneFileName(mid, "VALIDATION"));
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
      return {
        action: "dispatch",
        unitType: "complete-milestone",
        unitId: mid,
        prompt: await buildCompleteMilestonePrompt(mid, midTitle, basePath),
      };
    },
  },
];

// ─── Resolver ─────────────────────────────────────────────────────────────

/**
 * Evaluate dispatch rules in order. Returns the first matching action,
 * or a "stop" action if no rule matches (unhandled phase).
 */
export async function resolveDispatch(ctx: DispatchContext): Promise<DispatchAction> {
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
  return DISPATCH_RULES.map(r => r.name);
}

// ============================================================================
// Pipeline Dispatch (Component System Integration)
// ============================================================================

/**
 * Dispatch a pipeline from auto-mode.
 * Resolves the pipeline from the ComponentRegistry, validates inputs,
 * and returns a dispatch action for the pipeline runtime.
 *
 * This is called externally (not via DISPATCH_RULES) because pipeline
 * dispatch is triggered by explicit pipeline invocation, not by GSD phase state.
 */
export async function dispatchPipeline(
  pipelineName: string,
  inputs: Record<string, string | number | boolean>,
  basePath: string,
): Promise<DispatchAction> {
  try {
    const { getComponentRegistry } = await import("./component-registry.js");
    const registry = getComponentRegistry();
    const comp = registry.resolve(pipelineName);

    if (!comp) {
      return {
        action: "stop",
        reason: `Pipeline "${pipelineName}" not found in component registry.`,
        level: "error",
      };
    }

    if (comp.kind !== "pipeline") {
      return {
        action: "stop",
        reason: `Component "${pipelineName}" is a ${comp.kind}, not a pipeline.`,
        level: "error",
      };
    }

    const spec = comp.spec as { steps: Array<{ id: string; component: string; task: string }>; inputs?: Record<string, { type: string; default?: unknown }> };

    // Validate required inputs
    if (spec.inputs) {
      for (const [key, def] of Object.entries(spec.inputs)) {
        if (def.default === undefined && inputs[key] === undefined) {
          return {
            action: "stop",
            reason: `Pipeline "${pipelineName}" requires input "${key}" (${def.type}).`,
            level: "error",
          };
        }
      }
    }

    // Build the pipeline execution prompt
    const stepList = spec.steps
      .map((s, i) => `  ${i + 1}. [${s.id}] ${s.component}: ${s.task}`)
      .join("\n");

    const inputList = Object.entries(inputs)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");

    const prompt = [
      `## Pipeline: ${comp.metadata.name}`,
      `${comp.metadata.description}`,
      "",
      "### Steps",
      stepList,
      "",
      inputList ? `### Inputs\n${inputList}` : "",
      "",
      "Execute each step in order, passing outputs between steps as specified.",
      `Pipeline definition: ${comp.filePath}`,
    ].filter(Boolean).join("\n");

    return {
      action: "dispatch",
      unitType: "pipeline",
      unitId: `pipeline/${pipelineName}`,
      prompt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return {
      action: "stop",
      reason: `Failed to dispatch pipeline "${pipelineName}": ${message}`,
      level: "error",
    };
  }
}
