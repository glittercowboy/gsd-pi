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
import { isDbAvailable, getMilestoneSlices, getPendingGates, markAllGatesOmitted, getMilestone } from "./gsd-db.js";
import { extractVerdict, isAcceptableUatVerdict } from "./verdict-parser.js";

import {
  gsdRoot,
  resolveMilestoneFile,
  resolveMilestonePath,
  resolveSliceFile,
  resolveSlicePath,
  resolveTaskFile,
  relSliceFile,
  buildMilestoneFileName,
  buildSliceFileName,
} from "./paths.js";
import { parseRoadmap } from "./parsers-legacy.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { logWarning, logError } from "./workflow-logger.js";
import { join } from "node:path";
import { hasImplementationArtifacts } from "./auto-recovery.js";
import {
  buildDiscussMilestonePrompt,
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
  buildGateEvaluatePrompt,
  buildParallelResearchSlicesPrompt,
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
      /** Name of the matched dispatch rule from the unified registry (journal provenance). */
      matchedRule?: string;
    }
  | { action: "stop"; reason: string; level: "info" | "warning" | "error"; matchedRule?: string }
  | { action: "skip"; matchedRule?: string };

export interface DispatchContext {
  basePath: string;
  mid: string;
  midTitle: string;
  state: GSDState;
  prefs: GSDPreferences | undefined;
  session?: import("./auto/session.js").AutoSession;
}

export interface DispatchRule {
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

/**
 * Check for milestone slices missing SUMMARY files.
 * Returns array of missing slice IDs, or empty array if all present or DB unavailable.
 *
 * Excludes skipped slices (intentionally summary-less) and legacy-complete
 * slices whose DB status is authoritative even without on-disk SUMMARY (#3620).
 */
function findMissingSummaries(basePath: string, mid: string): string[] {
  if (!isDbAvailable()) return [];
  const slices = getMilestoneSlices(mid);
  // Skipped slices never produce SUMMARYs; legacy-complete slices may lack them
  const CLOSED_STATUSES = new Set(["skipped", "complete", "done"]);
  return slices
    .filter(s => !CLOSED_STATUSES.has(s.status))
    .filter(s => {
      const summaryPath = resolveSliceFile(basePath, mid, s.id, "SUMMARY");
      return !summaryPath || !existsSync(summaryPath);
    })
    .map(s => s.id);
}

// ─── Rewrite Circuit Breaker ──────────────────────────────────────────────

const MAX_REWRITE_ATTEMPTS = 3;

// ─── Disk-persisted rewrite attempt counter ──────────────────────────────────
// The counter must survive session restarts (crash recovery, pause/resume,
// step-mode). Storing it on the in-memory session object caused the circuit
// breaker to never trip — see https://github.com/gsd-build/gsd-2/issues/2203
function rewriteCountPath(basePath: string): string {
  return join(gsdRoot(basePath), "runtime", "rewrite-count.json");
}

export function getRewriteCount(basePath: string): number {
  try {
    const data = JSON.parse(readFileSync(rewriteCountPath(basePath), "utf-8"));
    return typeof data.count === "number" ? data.count : 0;
  } catch {
    return 0;
  }
}

export function setRewriteCount(basePath: string, count: number): void {
  const filePath = rewriteCountPath(basePath);
  mkdirSync(join(gsdRoot(basePath), "runtime"), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ count, updatedAt: new Date().toISOString() }) + "\n");
}

// ─── Run-UAT dispatch counter (per-slice) ────────────────────────────────
// Caps run-uat dispatches to prevent infinite replay when verification
// commands fail before writing a verdict (#3624).
const MAX_UAT_ATTEMPTS = 3;

function uatCountPath(basePath: string, mid: string, sid: string): string {
  return join(gsdRoot(basePath), "runtime", `uat-count-${mid}-${sid}.json`);
}

export function getUatCount(basePath: string, mid: string, sid: string): number {
  try {
    const data = JSON.parse(readFileSync(uatCountPath(basePath, mid, sid), "utf-8"));
    return typeof data.count === "number" ? data.count : 0;
  } catch {
    return 0;
  }
}

export function incrementUatCount(basePath: string, mid: string, sid: string): number {
  const count = getUatCount(basePath, mid, sid) + 1;
  const filePath = uatCountPath(basePath, mid, sid);
  mkdirSync(join(gsdRoot(basePath), "runtime"), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ count, updatedAt: new Date().toISOString() }) + "\n");
  return count;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Returns true when the verification_operational value indicates that no
 * operational verification is needed.  Covers common phrasings the planning
 * agent may use: "None", "None required", "N/A", "Not applicable", etc.
 *
 * @see https://github.com/gsd-build/gsd-2/issues/2931
 */
export function isVerificationNotApplicable(value: string): boolean {
  const v = (value ?? "").toLowerCase().trim().replace(/[.\s]+$/, "");
  if (!v || v === "none") return true;
  return /^(?:none[\s._-]*(?:required|needed|planned)?|n\/?a|not[\s._-]+(?:applicable|required|needed|provided)|no[\s._-]+operational[\s\S]*)$/i.test(v);
}

// ─── Rules ────────────────────────────────────────────────────────────────

export const DISPATCH_RULES: DispatchRule[] = [
  {
    name: "rewrite-docs (override gate)",
    match: async ({ mid, midTitle, state, basePath, session }) => {
      const pendingOverrides = await loadActiveOverrides(basePath);
      if (pendingOverrides.length === 0) return null;
      const count = getRewriteCount(basePath);
      if (count >= MAX_REWRITE_ATTEMPTS) {
        const { resolveAllOverrides } = await import("./files.js");
        await resolveAllOverrides(basePath);
        setRewriteCount(basePath, 0);
        return null;
      }
      setRewriteCount(basePath, count + 1);
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

      // Cap run-uat dispatch attempts to prevent infinite replay (#3624)
      const attempts = incrementUatCount(basePath, mid, sliceId);
      if (attempts > MAX_UAT_ATTEMPTS) {
        return {
          action: "stop" as const,
          reason: `run-uat for ${mid}/${sliceId} has been dispatched ${attempts - 1} times without producing a verdict. Verification commands may be broken — fix the UAT spec or manually write an ASSESSMENT verdict.`,
          level: "warning" as const,
        };
      }
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
        pauseAfterDispatch: !process.env.GSD_HEADLESS && uatType !== "artifact-driven" && uatType !== "browser-executable" && uatType !== "runtime-executable",
      };
    },
  },
  {
    name: "uat-verdict-gate (non-PASS blocks progression)",
    match: async ({ mid, basePath, prefs }) => {
      // Only applies when UAT dispatch is enabled
      if (!prefs?.uat_dispatch) return null;

      const roadmapFile = resolveMilestoneFile(basePath, mid, "ROADMAP");

      // DB-first: get completed slices from DB
      let completedSliceIds: string[];
      if (isDbAvailable()) {
        completedSliceIds = getMilestoneSlices(mid)
          .filter(s => s.status === "complete")
          .map(s => s.id);
      } else {
        return null;
      }

      for (const sliceId of completedSliceIds) {
        const resultFile = resolveSliceFile(basePath, mid, sliceId, "UAT");
        if (!resultFile) continue;
        const content = await loadFile(resultFile);
        if (!content) continue;
        const verdict = extractVerdict(content);
        const uatType = extractUatType(content);

        if (verdict && !isAcceptableUatVerdict(verdict, uatType)) {
          return {
            action: "stop" as const,
            reason: `UAT verdict for ${sliceId} is "${verdict}" — blocking progression until resolved.\nReview the UAT result and update the verdict to PASS, or re-run /gsd auto after fixing.`,
            level: "warning" as const,
          };
        }
      }
      return null;
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
    name: "needs-discussion → discuss-milestone",
    match: async ({ state, mid, midTitle, basePath }) => {
      if (state.phase !== "needs-discussion") return null;
      return {
        action: "dispatch",
        unitType: "discuss-milestone",
        unitId: mid,
        prompt: await buildDiscussMilestonePrompt(mid, midTitle, basePath),
      };
    },
  },
  {
    name: "pre-planning (no context) → discuss-milestone",
    match: async ({ state, mid, midTitle, basePath }) => {
      if (state.phase !== "pre-planning") return null;
      const contextFile = resolveMilestoneFile(basePath, mid, "CONTEXT");
      const hasContext = !!(contextFile && (await loadFile(contextFile)));
      if (hasContext) return null; // fall through to next rule
      return {
        action: "dispatch",
        unitType: "discuss-milestone",
        unitId: mid,
        prompt: await buildDiscussMilestonePrompt(mid, midTitle, basePath),
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
    // Keep this rule before the single-slice research rule so the multi-slice
    // path wins whenever 2+ slices are ready.
    name: "planning (multiple slices need research) → parallel-research-slices",
    match: async ({ state, mid, midTitle, basePath, prefs }) => {
      if (state.phase !== "planning") return null;
      if (prefs?.phases?.skip_research || prefs?.phases?.skip_slice_research) return null;

      // Load roadmap to find all slices
      const roadmapFile = resolveMilestoneFile(basePath, mid, "ROADMAP");
      const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
      if (!roadmapContent) return null;
      const roadmap = parseRoadmap(roadmapContent);

      // Find slices that need research (no RESEARCH file, dependencies done)
      const milestoneResearchFile = resolveMilestoneFile(basePath, mid, "RESEARCH");
      const researchReadySlices: Array<{ id: string; title: string }> = [];

      for (const slice of roadmap.slices) {
        if (slice.done) continue;
        // Skip S01 when milestone research exists
        if (milestoneResearchFile && slice.id === "S01") continue;
        // Skip if already has research
        if (resolveSliceFile(basePath, mid, slice.id, "RESEARCH")) continue;
        // Skip if dependencies aren't done (check for SUMMARY files)
        const depsComplete = (slice.depends ?? []).every((depId) =>
          !!resolveSliceFile(basePath, mid, depId, "SUMMARY"),
        );
        if (!depsComplete) continue;

        researchReadySlices.push({ id: slice.id, title: slice.title });
      }

      // Only dispatch parallel if 2+ slices are ready
      if (researchReadySlices.length < 2) return null;

      return {
        action: "dispatch",
        unitType: "research-slice",
        unitId: `${mid}/parallel-research`,
        prompt: await buildParallelResearchSlicesPrompt(
          mid,
          midTitle,
          researchReadySlices,
          basePath,
        ),
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
    name: "evaluating-gates → gate-evaluate",
    match: async ({ state, mid, midTitle, basePath, prefs }) => {
      if (state.phase !== "evaluating-gates") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;

      // Gate evaluation is opt-in via preferences
      const gateConfig = prefs?.gate_evaluation;
      if (!gateConfig?.enabled) {
        markAllGatesOmitted(mid, sid);
        return { action: "skip" };
      }

      const pending = getPendingGates(mid, sid, "slice");
      if (pending.length === 0) return { action: "skip" };

      return {
        action: "dispatch",
        unitType: "gate-evaluate",
        unitId: `${mid}/${sid}/gates+${pending.map(g => g.gate_id).join(",")}`,
        prompt: await buildGateEvaluatePrompt(
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
        logError("dispatch", "reactive graph derivation failed", { error: (err as Error).message });
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
      // allowing milestone validation.
      const missingSlices = findMissingSummaries(basePath, mid);
      if (missingSlices.length > 0) {
        return {
          action: "stop",
          reason: `Cannot validate milestone ${mid}: slices ${missingSlices.join(", ")} are missing SUMMARY files. These slices may have been skipped.`,
          level: "error",
        };
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

      // Safety guard (#2675): block completion when VALIDATION verdict is
      // needs-remediation. The state machine treats needs-remediation as
      // terminal (to prevent validate-milestone loops per #832), but
      // completing-milestone should NOT proceed — remediation work is needed.
      const validationFile = resolveMilestoneFile(basePath, mid, "VALIDATION");
      if (validationFile) {
        const validationContent = await loadFile(validationFile);
        if (validationContent) {
          const verdict = extractVerdict(validationContent);
          if (verdict === "needs-remediation") {
            return {
              action: "stop",
              reason: `Cannot complete milestone ${mid}: VALIDATION verdict is "needs-remediation". Address the remediation findings and re-run validation, or update the verdict manually.`,
              level: "warning",
            };
          }
        }
      }

      // Safety guard (#1368): verify all roadmap slices have SUMMARY files.
      const missingSlices = findMissingSummaries(basePath, mid);
      if (missingSlices.length > 0) {
        return {
          action: "stop",
          reason: `Cannot complete milestone ${mid}: slices ${missingSlices.join(", ")} are missing SUMMARY files. Run /gsd doctor to diagnose.`,
          level: "error",
        };
      }

      // Safety guard (#1703): verify the milestone produced implementation
      // artifacts (non-.gsd/ files). A milestone with only plan files and
      // zero implementation code should not be marked complete.
      const artifactCheck = hasImplementationArtifacts(basePath);
      if (artifactCheck === "absent") {
        return {
          action: "stop",
          reason: `Cannot complete milestone ${mid}: no implementation files found outside .gsd/. The milestone has only plan files — actual code changes are required.`,
          level: "error",
        };
      }
      if (artifactCheck === "unknown") {
        logWarning("dispatch", `Implementation artifact check inconclusive for ${mid} — proceeding (git context unavailable)`);
      }

      // Verification class compliance: if operational verification was planned,
      // ensure the validation output documents it before allowing completion.
      try {
        if (isDbAvailable()) {
          const milestone = getMilestone(mid);
          if (milestone?.verification_operational &&
              !isVerificationNotApplicable(milestone.verification_operational)) {
            const validationPath = resolveMilestoneFile(basePath, mid, "VALIDATION");
            if (validationPath) {
              const validationContent = await loadFile(validationPath);
              if (validationContent) {
                // Allow completion when validation was intentionally skipped by
                // preference/budget profile (#3399, #3344).
                const skippedByPreference = /skip(?:ped)?[\s\-]+(?:by|per|due to)\s+(?:preference|budget|profile)/i.test(validationContent);

                // Accept either the structured template format (table with MET/N/A/SATISFIED)
                // or prose evidence patterns the validation agent may emit.
                const structuredMatch =
                  validationContent.includes("Operational") &&
                  (validationContent.includes("MET") || validationContent.includes("N/A") || validationContent.includes("SATISFIED"));
                const proseMatch =
                  /[Oo]perational[\s\S]{0,500}?(?:✅|pass|verified|confirmed|met|complete|true|yes|addressed|covered|satisfied|partially|n\/a|not[\s-]+applicable)/i.test(validationContent);
                const hasOperationalCheck = skippedByPreference || structuredMatch || proseMatch;
                if (!hasOperationalCheck) {
                  return {
                    action: "stop" as const,
                    reason: `Milestone ${mid} has planned operational verification ("${milestone.verification_operational.substring(0, 100)}") but the validation output does not address it. Re-run validation with verification class awareness, or update the validation to document operational compliance.`,
                    level: "warning" as const,
                  };
                }
              }
            }
          }
        }
      } catch (err) { /* fall through — don't block on DB errors */
        logWarning("dispatch", `verification class check failed: ${err instanceof Error ? err.message : String(err)}`);
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

import { getRegistry } from "./rule-registry.js";

// ─── Resolver ─────────────────────────────────────────────────────────────

/**
 * Evaluate dispatch rules in order. Returns the first matching action,
 * or a "stop" action if no rule matches (unhandled phase).
 *
 * Delegates to the RuleRegistry when initialized; falls back to inline
 * loop over DISPATCH_RULES for backward compatibility (tests that import
 * resolveDispatch directly without registry initialization).
 */
export async function resolveDispatch(
  ctx: DispatchContext,
): Promise<DispatchAction> {
  // Delegate to registry when available
  try {
    const registry = getRegistry();
    return await registry.evaluateDispatch(ctx);
  } catch (err) {
    // Registry not initialized — fall back to inline loop
    logWarning("dispatch", `registry dispatch failed, falling back to inline rules: ${err instanceof Error ? err.message : String(err)}`);
  }

  for (const rule of DISPATCH_RULES) {
    const result = await rule.match(ctx);
    if (result) {
      if (result.action !== "skip") result.matchedRule = rule.name;
      return result;
    }
  }

  // No rule matched — unhandled phase
  return {
    action: "stop",
    reason: `Unhandled phase "${ctx.state.phase}" — run /gsd doctor to diagnose.`,
    level: "info",
    matchedRule: "<no-match>",
  };
}

/** Exposed for testing — returns the rule names in evaluation order. */
export function getDispatchRuleNames(): string[] {
  return DISPATCH_RULES.map((r) => r.name);
}
