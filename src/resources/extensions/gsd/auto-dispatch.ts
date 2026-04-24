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
import type { MinimalModelRegistry } from "./context-budget.js";
import { loadFile, extractUatType, loadActiveOverrides } from "./files.js";
import { isDbAvailable, getMilestoneSlices, getPendingGates, markAllGatesOmitted, getMilestone, updateMilestoneStatus, getExternalWait, incrementProbeFailureCount, updateExternalWaitStatus, resetProbeFailureCount, getAllWaitingExternalWaits, updateTaskStatus } from "./gsd-db.js";
import { exec, type ExecException } from "node:child_process";
import { isClosedStatus } from "./status-guards.js";

/** Platform-appropriate shell for probe commands. Unix → /bin/sh, Windows → %COMSPEC% or cmd.exe. */
const probeShell = process.platform === "win32"
  ? (process.env.COMSPEC || "cmd.exe")
  : "/bin/sh";

/**
 * Infrastructure exit codes that indicate the probe command itself failed to
 * run (shell not found, permission denied, command not found) — as opposed to
 * the probed process signalling completion via a non-zero exit.
 */
const INFRA_FAILURE_CODES = new Set([126, 127]);

/** Redact tokens, passwords, signed URLs, and long hex/base64 secrets from a string. */
function sanitizeForLog(value: string): string {
  // Mask environment variable assignments with secret-bearing names
  let result = value.replace(
    /\b(token|password|secret|api_key|apikey|auth|credential|bearer|signing)[=:]\s*\S+/gi,
    (match) => match.slice(0, match.indexOf("=") + 1 || match.indexOf(":") + 1) + "***",
  );
  // Mask long hex strings (>= 32 chars, likely tokens/hashes)
  result = result.replace(/\b[0-9a-f]{32,}\b/gi, "***");
  // Mask long base64-ish strings (>= 40 chars with base64 alphabet)
  result = result.replace(/\b[A-Za-z0-9+/=_-]{40,}\b/g, "***");
  // Mask URLs with signed query parameters
  result = result.replace(/(https?:\/\/\S+[?&])(sig|token|key|signature|auth|credential)=[^&\s]+/gi, "$1$2=***");
  return result;
}

/**
 * Build the `pendingExternalResume` carry-forward string for the session.
 * Centralised to avoid three near-identical copy-paste templates drifting.
 */
function buildResumeContext(
  kind: "success" | "failure" | "timeout",
  opts: { contextHint: string; timeoutMs?: number; registeredAt?: string; failureContext?: string },
): string {
  const hint = opts.contextHint ? `\n\nContext from registration: ${opts.contextHint}` : "";
  switch (kind) {
    case "success":
      return `**EXTERNAL WAIT RESOLVED — TASK RESUMING**\n\nThe external process you submitted has completed successfully.${hint}\n\nContinue with the task.`;
    case "failure":
      return `**EXTERNAL WAIT RESOLVED — JOB FAILED**\n\nThe external process completed but the success check failed.${hint}\n\nFailure details:\n${opts.failureContext ?? ""}\n\nInvestigate the failure, adjust parameters if needed, and either fix the issue or escalate.`;
    case "timeout":
      return `**EXTERNAL WAIT TIMED OUT — RESUMING WITH FAILURE**\n\nThe external process timed out after ${opts.timeoutMs}ms (registered ${opts.registeredAt}).${hint}\n\nThe onTimeout policy is "resume-with-failure" — investigate the timeout, adjust parameters if needed, and either retry or escalate.`;
  }
}
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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { logWarning, logError } from "./workflow-logger.js";
import { invalidateStateCache } from "./state.js";
import { join } from "node:path";
import { hasImplementationArtifacts } from "./auto-recovery.js";
import { classifyMilestoneSummaryContent } from "./milestone-summary-classifier.js";
import {
  buildDiscussMilestonePrompt,
  buildResearchMilestonePrompt,
  buildPlanMilestonePrompt,
  buildResearchSlicePrompt,
  buildPlanSlicePrompt,
  buildRefineSlicePrompt,
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
import { resolveModelWithFallbacksForUnit } from "./preferences-models.js";
import { resolveUokFlags } from "./uok/flags.js";
import { selectReactiveDispatchBatch } from "./uok/execution-graph.js";
import { EXECUTION_ENTRY_PHASES, hasFinalizedMilestoneContext } from "./uok/plan-v2.js";

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
  | { action: "skip"; matchedRule?: string }
  | { action: "sleep"; durationMs: number; matchedRule?: string };

export interface DispatchContext {
  basePath: string;
  mid: string;
  midTitle: string;
  state: GSDState;
  prefs: GSDPreferences | undefined;
  session?: import("./auto/session.js").AutoSession;
  structuredQuestionsAvailable?: "true" | "false";
  /** Session model context window in tokens, forwarded to the budget engine's prompt builders. */
  sessionContextWindow?: number;
  /** Model registry forwarded to the budget engine so it can look up the configured executor model. */
  modelRegistry?: MinimalModelRegistry;
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
  return /^(?:none(?:[\s._\u2014-]+[\s\S]*)?|n\/?a|not[\s._-]+(?:applicable|required|needed|provided)|no[\s._-]+operational[\s\S]*)$/i.test(v);
}

// ─── Rules ────────────────────────────────────────────────────────────────

export const DISPATCH_RULES: DispatchRule[] = [
  {
    // ADR-011 Phase 2: pause-for-escalation must evaluate FIRST so phase-
    // agnostic rules (rewrite-docs gate, UAT checks, reassess) cannot bypass
    // the user's pending decision. Only fires for continueWithDefault=false
    // escalations (those set escalation_pending=1); awaiting-review artifacts
    // never enter the 'escalating-task' phase.
    name: "escalating-task → pause-for-escalation",
    match: async ({ state, mid }) => {
      if (state.phase !== "escalating-task") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      return {
        action: "stop",
        reason:
          state.nextAction ||
          `${mid}: task escalation awaits user resolution. Run /gsd escalate list to see pending items.`,
        level: "info",
      };
    },
  },
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
    // #4671 — Recovery path for execution-entry phases with missing CONTEXT.md.
    //
    // Once `deriveStateFromDb` returns an execution-entry phase (executing /
    // summarizing / validating-milestone / completing-milestone), the
    // pre-planning guard at `pre-planning (no context) → discuss-milestone`
    // no longer fires. The plan-v2 gate correctly detects the missing context
    // but can only block — it cannot redispatch. Without this rule the
    // milestone is stuck until `/gsd doctor heal` repairs it (and heal
    // historically missed this check too).
    //
    // Fire BEFORE the execution-entry phase rules so we redispatch to
    // `discuss-milestone` instead of hitting the plan-v2 gate.
    name: "execution-entry phase (no context) → discuss-milestone",
    match: async ({ state, mid, midTitle, basePath, structuredQuestionsAvailable }) => {
      if (!EXECUTION_ENTRY_PHASES.has(state.phase)) return null;
      // Align with the plan-v2 gate's lookup semantics: whitespace-only counts
      // as missing, and an auto worktree may fall back to GSD_PROJECT_ROOT.
      if (hasFinalizedMilestoneContext(basePath, mid)) return null;
      return {
        action: "dispatch",
        unitType: "discuss-milestone",
        unitId: mid,
        prompt: await buildDiscussMilestonePrompt(
          mid,
          midTitle,
          basePath,
          structuredQuestionsAvailable,
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
      if (prefs?.phases?.skip_reassess) return null;
      // Default reassess_after_slice to true — reassessment after slice completion
      // is essential for roadmap integrity. Opt-out via explicit `false`.
      const reassessEnabled = prefs?.phases?.reassess_after_slice ?? true;
      if (!reassessEnabled) return null;
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
    match: async ({ state, mid, midTitle, basePath, structuredQuestionsAvailable }) => {
      if (state.phase !== "needs-discussion") return null;
      return {
        action: "dispatch",
        unitType: "discuss-milestone",
        unitId: mid,
        prompt: await buildDiscussMilestonePrompt(
          mid,
          midTitle,
          basePath,
          structuredQuestionsAvailable,
        ),
      };
    },
  },
  {
    name: "pre-planning (no context) → discuss-milestone",
    match: async ({ state, mid, midTitle, basePath, structuredQuestionsAvailable }) => {
      if (state.phase !== "pre-planning") return null;
      const contextFile = resolveMilestoneFile(basePath, mid, "CONTEXT");
      const hasContext = !!(contextFile && (await loadFile(contextFile)));
      if (hasContext) return null; // fall through to next rule
      return {
        action: "dispatch",
        unitType: "discuss-milestone",
        unitId: mid,
        prompt: await buildDiscussMilestonePrompt(
          mid,
          midTitle,
          basePath,
          structuredQuestionsAvailable,
        ),
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
    name: "planning (require_slice_discussion) → pause for discussion (#3454)",
    match: async ({ state, mid, basePath, prefs }) => {
      if (state.phase !== "planning") return null;
      if (!prefs?.phases?.require_slice_discussion) return null;
      if (!state.activeSlice) return null;
      // Only pause if the slice has no context file yet (discussion not done).
      // resolveSliceFile returns null when the file does not exist on disk,
      // but cachedReaddir could return a stale hit — verify with existsSync
      // so the guard is defence-in-depth and the contract is explicit at the
      // call site.
      const sliceContextFile = resolveSliceFile(basePath, mid, state.activeSlice.id, "CONTEXT");
      if (sliceContextFile && existsSync(sliceContextFile)) return null; // discussion already done, proceed
      return {
        action: "stop" as const,
        reason: `Slice ${state.activeSlice.id} requires discussion before planning (require_slice_discussion is enabled). Run /gsd discuss to discuss this slice, then /gsd auto to resume.`,
        level: "info" as const,
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

      // #4414: If a previous parallel-research attempt escalated to a blocker
      // placeholder, skip this rule and fall through to per-slice research
      // (or other rules) rather than re-dispatching the same failing unit.
      const parallelBlocker = resolveMilestoneFile(basePath, mid, "PARALLEL-BLOCKER");
      if (parallelBlocker) return null;

      return {
        action: "dispatch",
        unitType: "research-slice",
        unitId: `${mid}/parallel-research`,
        prompt: await buildParallelResearchSlicesPrompt(
          mid,
          midTitle,
          researchReadySlices,
          basePath,
          resolveModelWithFallbacksForUnit("subagent")?.primary,
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
    // ADR-011: sketch-then-refine. When `refining` phase fires, expand the
    // sketch into a full plan using the prior slice's SUMMARY and the current
    // codebase. If the user flipped `progressive_planning` off mid-milestone
    // while a slice is still `is_sketch=1`, fall through to a standard
    // plan-slice so the loop doesn't dead-end.
    //
    // Note on the flag-OFF downgrade: plan-slice does not explicitly clear
    // `is_sketch`. After it writes PLAN.md, the auto-heal in state.ts's
    // `deriveStateFromDb` (via `autoHealSketchFlags`) flips the flag on the
    // next iteration. That implicit coupling is the sole mechanism that
    // reconciles `is_sketch=1` on the plan-slice path — do not remove the
    // auto-heal without either adding an explicit `setSliceSketchFlag(..., false)`
    // call here or doing so inside the plan-slice tool handler.
    name: "refining → refine-slice",
    match: async ({ state, mid, midTitle, basePath, prefs, sessionContextWindow, modelRegistry }) => {
      if (state.phase !== "refining") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;
      const progressiveOn = prefs?.phases?.progressive_planning === true;
      if (!progressiveOn) {
        // Graceful downgrade: treat the sketch as a normal slice needing a plan,
        // but forward the stored sketch_scope as a SOFT hint so the scope
        // signal isn't silently lost. The planner may expand beyond it.
        let softScopeHint = "";
        try {
          const { isDbAvailable, getSlice } = await import("./gsd-db.js");
          if (isDbAvailable()) {
            softScopeHint = getSlice(mid, sid)?.sketch_scope ?? "";
          }
        } catch {
          softScopeHint = "";
        }
        return {
          action: "dispatch",
          unitType: "plan-slice",
          unitId: `${mid}/${sid}`,
          prompt: await buildPlanSlicePrompt(
            mid, midTitle, sid, sTitle, basePath, undefined,
            { ...(softScopeHint ? { softScopeHint } : {}), sessionContextWindow, modelRegistry },
          ),
        };
      }
      return {
        action: "dispatch",
        unitType: "refine-slice",
        unitId: `${mid}/${sid}`,
        prompt: await buildRefineSlicePrompt(
          mid, midTitle, sid, sTitle, basePath, undefined,
          { sessionContextWindow, modelRegistry },
        ),
      };
    },
  },
  {
    name: "planning → plan-slice",
    match: async ({ state, mid, midTitle, basePath, sessionContextWindow, modelRegistry, session }) => {
      if (state.phase !== "planning") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice!.id;
      const sTitle = state.activeSlice!.title;
      // #4551: Consume any persisted pre-exec failure for this slice so the
      // re-dispatched prompt includes the exact blocked references. Clear the
      // field immediately after reading to prevent stale context leaking into
      // a later, unrelated plan-slice run.
      const unitId = `${mid}/${sid}`;
      let priorPreExecFailure: { blockingFindings: string[]; verdictExcerpt: string } | undefined;
      if (session?.lastPreExecFailure?.unitId === unitId) {
        priorPreExecFailure = {
          blockingFindings: session.lastPreExecFailure.blockingFindings,
          verdictExcerpt: session.lastPreExecFailure.verdictExcerpt,
        };
        session.lastPreExecFailure = null;
      }
      return {
        action: "dispatch",
        unitType: "plan-slice",
        unitId,
        prompt: await buildPlanSlicePrompt(
          mid,
          midTitle,
          sid,
          sTitle,
          basePath,
          undefined,
          { sessionContextWindow, modelRegistry, priorPreExecFailure },
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
          resolveModelWithFallbacksForUnit("subagent")?.primary,
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
    name: "awaiting-external → probe",
    match: async (ctx) => {
      const { state, mid, basePath } = ctx;
      if (state.phase !== "awaiting-external") return null;
      if (!state.activeTask || !state.activeSlice) return null;

      const sid = state.activeSlice.id;
      const tid = state.activeTask.id;
      const waitRow = getExternalWait(mid, sid, tid);

      if (!waitRow) {
        return {
          action: "stop" as const,
          reason: `Task ${tid} has status "awaiting-external" but no external_waits record. Run /gsd doctor to diagnose.`,
          level: "warning" as const,
        };
      }

      // ── Probe exit code semantics (D029) ──────────────────────────
      // "Poll while" convention:
      //   exit 0  = condition holds, keep polling (still running)
      //   exit !0 = condition no longer holds, done → transition
      // Naming: "pollWhileCommand" makes the semantics self-documenting —
      // "keep polling while this command succeeds."
      // Example: `squeue -j ID | grep -c ID` returns 0 while job is in queue.

      const pollWhileCommand = waitRow.poll_while_command as string;
      const pollIntervalMs = (waitRow.poll_interval_ms as number) || 60000;
      const slicePath = resolveSlicePath(basePath, mid, sid);
      if (!slicePath) {
        logWarning("dispatch", `Cannot resolve slice path for ${mid}/${sid} — escalating ${tid} to manual attention.`);
        updateTaskStatus(mid, sid, tid, "manual-attention");
        updateExternalWaitStatus(mid, sid, tid, "timed-out");
        invalidateStateCache();
        return { action: "stop" as const, reason: `Cannot resolve slice path for ${mid}/${sid}/${tid}. Escalating to manual attention.`, level: "warning" as const };
      }
      const tasksDir = join(slicePath, "tasks");
      const logPath = join(tasksDir, `${tid}-EXTERNAL-WAIT.log`);

      // ── Timeout check (before probe execution) ────────────────────
      const registeredAt = waitRow.registered_at as string;
      const timeoutMs = (waitRow.timeout_ms as number) || 86400000;
      if (Date.now() > Date.parse(registeredAt) + timeoutMs) {
        const onTimeout = (waitRow.on_timeout as string) || "manual-attention";
        updateExternalWaitStatus(mid, sid, tid, "timed-out");
        try { appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), event: "timeout", registeredAt, timeoutMs, onTimeout }) + "\n"); } catch (logErr) { logWarning("dispatch", `Failed to write external wait log: ${logErr instanceof Error ? logErr.message : String(logErr)}`); }

        if (onTimeout === "resume-with-failure") {
          // Resume execution with failure context so the agent can handle the timeout
          updateTaskStatus(mid, sid, tid, "executing");
          invalidateStateCache();
          const contextHint = (waitRow.context_hint as string) || "";
          if (ctx.session) {
            ctx.session.pendingExternalResume = buildResumeContext("timeout", { contextHint, timeoutMs, registeredAt });
          }
          return { action: "skip" as const };
        }

        // Default: manual-attention
        updateTaskStatus(mid, sid, tid, "manual-attention");
        invalidateStateCache();
        return { action: "stop" as const, reason: `External wait for ${tid} timed out (registered ${registeredAt}, timeout ${timeoutMs}ms). Escalating to manual attention.`, level: "warning" as const };
      }

      // ── JSON probe spec existence check (R228) ────────────────────
      const probeSpecPath = join(tasksDir, `${tid}-EXTERNAL-WAIT.json`);
      if (!existsSync(probeSpecPath)) {
        updateTaskStatus(mid, sid, tid, "manual-attention");
        updateExternalWaitStatus(mid, sid, tid, "timed-out");
        invalidateStateCache();
        return { action: "stop" as const, reason: `Task ${tid} has external_waits DB row but no ${tid}-EXTERNAL-WAIT.json probe spec. Escalating to manual attention.`, level: "warning" as const };
      }

      // ── Helper: compute min pollInterval across all waiting waits ──
      const computeMinPoll = (): number => {
        const allWaiting = getAllWaitingExternalWaits(mid);
        const candidate = allWaiting.length > 0
          ? Math.min(...allWaiting.map(w => (w.poll_interval_ms as number) || 60000))
          : pollIntervalMs;
        // Clamp to at least 1000ms to prevent tight loops from negative/zero DB values
        return Math.max(1000, candidate);
      };

      // Probe timeout: use pollInterval (capped between 30s-120s) so slow external systems have time to respond
      const probeTimeoutMs = Math.max(30000, Math.min(pollIntervalMs, 120000));
      try {
        const { exitCode, killed, stdout, infraFailure } = await new Promise<{ exitCode: number | null; killed: boolean; stdout: string; infraFailure: boolean }>((resolve) => {
          exec(pollWhileCommand, { timeout: probeTimeoutMs, shell: probeShell }, (err: ExecException | null, stdout, _stderr) => {
            if (err) {
              const code = err.code ?? null;
              const isInfra = INFRA_FAILURE_CODES.has(code as number) || /ENOENT|EACCES/.test(err.message);
              resolve({ exitCode: code, killed: !!err.killed, stdout: stdout || "", infraFailure: isInfra });
            } else {
              resolve({ exitCode: 0, killed: false, stdout: stdout || "", infraFailure: false });
            }
          });
        });

        // ── Probe execution log (sanitized — no secrets in command/stdout) ──
        try { appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), event: "probe", command: sanitizeForLog(pollWhileCommand), exitCode, stdout: sanitizeForLog(stdout.slice(0, 500)), killed, infraFailure }) + "\n"); } catch (logErr) { logWarning("dispatch", `Failed to write external wait log: ${logErr instanceof Error ? logErr.message : String(logErr)}`); }

        // Infrastructure failure (command not found, permission denied, shell missing) —
        // treat as probe failure, NOT as "job completed"
        if (infraFailure) {
          incrementProbeFailureCount(mid, sid, tid);
          const updated = getExternalWait(mid, sid, tid);
          if (updated && (updated.probe_failure_count as number) >= 3) {
            updateTaskStatus(mid, sid, tid, "manual-attention");
            updateExternalWaitStatus(mid, sid, tid, "timed-out");
            invalidateStateCache();
            return {
              action: "stop" as const,
              reason: `Probe for ${tid} failed 3 times (infrastructure error, exit ${exitCode}). Escalating to manual attention.`,
              level: "warning" as const,
            };
          }
          return { action: "sleep" as const, durationMs: computeMinPoll(), matchedRule: "awaiting-external → probe" };
        }

        if (killed) {
          incrementProbeFailureCount(mid, sid, tid);
          const updated = getExternalWait(mid, sid, tid);
          if (updated && (updated.probe_failure_count as number) >= 3) {
            updateTaskStatus(mid, sid, tid, "manual-attention");
            updateExternalWaitStatus(mid, sid, tid, "timed-out");
            invalidateStateCache();
            return {
              action: "stop" as const,
              reason: `Probe for ${tid} timed out 3 times. Escalating to manual attention.`,
              level: "warning" as const,
            };
          }
          return { action: "sleep" as const, durationMs: computeMinPoll(), matchedRule: "awaiting-external → probe" };
        }

        if (exitCode === 0) {
          // Still running — reset failure count (R227) and sleep
          resetProbeFailureCount(mid, sid, tid);
          return { action: "sleep" as const, durationMs: computeMinPoll(), matchedRule: "awaiting-external → probe" };
        }

        // ── Non-zero exit = done — execute successCheck if present ──
        const successCheck = waitRow.success_check as string | null;
        const contextHint = (waitRow.context_hint as string) || "";
        let jobSucceeded = true;
        let failureContext = "";

        if (successCheck) {
          try {
            const scResult = await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve) => {
              exec(successCheck, { timeout: 30000, shell: probeShell }, (err: ExecException | null, scStdout, scStderr) => {
                if (err) resolve({ exitCode: err.code ?? 1, stdout: scStdout || "", stderr: scStderr || "" });
                else resolve({ exitCode: 0, stdout: scStdout || "", stderr: scStderr || "" });
              });
            });
            try { appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), event: "successCheck", exitCode: scResult.exitCode, stdout: sanitizeForLog(scResult.stdout.slice(0, 500)) }) + "\n"); } catch (logErr) { logWarning("dispatch", `Failed to write external wait log: ${logErr instanceof Error ? logErr.message : String(logErr)}`); }
            if (scResult.exitCode !== 0) {
              jobSucceeded = false;
              failureContext = `Exit code: ${scResult.exitCode}\nStderr: ${scResult.stderr.slice(0, 1000)}`;
            }
          } catch (scErr) {
            jobSucceeded = false;
            failureContext = `successCheck exec error: ${scErr instanceof Error ? scErr.message : String(scErr)}`;
          }
        }

        // ── State transition: awaiting-external → executing ────────
        updateTaskStatus(mid, sid, tid, "executing");
        updateExternalWaitStatus(mid, sid, tid, "resolved");
        resetProbeFailureCount(mid, sid, tid);
        invalidateStateCache();

        // ── Carry-forward context ─────────────────────────────────
        if (ctx.session) {
          ctx.session.pendingExternalResume = jobSucceeded
            ? buildResumeContext("success", { contextHint })
            : buildResumeContext("failure", { contextHint, failureContext });
        }

        return { action: "skip" as const };
      } catch (execErr) {
        // ── Probe execution failure log ──────────────────────────
        try { appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), event: "probe-error", error: execErr instanceof Error ? execErr.message : String(execErr) }) + "\n"); } catch (logErr) { logWarning("dispatch", `Failed to write external wait log: ${logErr instanceof Error ? logErr.message : String(logErr)}`); }

        incrementProbeFailureCount(mid, sid, tid);
        const updated = getExternalWait(mid, sid, tid);
        if (updated && (updated.probe_failure_count as number) >= 3) {
          updateTaskStatus(mid, sid, tid, "manual-attention");
          updateExternalWaitStatus(mid, sid, tid, "timed-out");
          invalidateStateCache();
          return {
            action: "stop" as const,
            reason: `Probe for ${tid} failed 3 times: ${execErr instanceof Error ? execErr.message : String(execErr)}`,
            level: "warning" as const,
          };
        }
        return { action: "sleep" as const, durationMs: computeMinPoll(), matchedRule: "awaiting-external → probe" };
      }
    },
  },
  {
    name: "executing → reactive-execute (parallel dispatch)",
    match: async ({ state, mid, midTitle, basePath, prefs, sessionContextWindow, modelRegistry }) => {
      if (state.phase !== "executing" || !state.activeTask) return null;
      if (!state.activeSlice) return null; // fall through

      // Only activate when reactive_execution is explicitly enabled
      const reactiveConfig = prefs?.reactive_execution;
      if (!reactiveConfig?.enabled) return null;

      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;
      const maxParallel = reactiveConfig.max_parallel ?? 2;
      const subagentModel = reactiveConfig.subagent_model ?? resolveModelWithFallbacksForUnit("subagent")?.primary;

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

        const uokFlags = resolveUokFlags(prefs);
        const selected = uokFlags.executionGraph
          ? selectReactiveDispatchBatch({
              graph,
              readyIds,
              maxParallel,
              inFlightOutputs: new Set(),
            }).selected
          : chooseNonConflictingSubset(
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
            subagentModel,
            { sessionContextWindow, modelRegistry },
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
    match: async ({ state, mid, midTitle, basePath, sessionContextWindow, modelRegistry }) => {
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
            undefined,
            { sessionContextWindow, modelRegistry },
          ),
        };
      }

      return null;
    },
  },
  {
    name: "executing → execute-task",
    match: async ({ state, mid, basePath, sessionContextWindow, modelRegistry }) => {
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
          { sessionContextWindow, modelRegistry },
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

      // Defense-in-depth (#4324): skip dispatch if the DB already marks
      // this milestone as complete. Prevents re-enqueue when the legacy
      // filesystem state-derivation path runs (e.g. transient DB
      // unavailability) and produces a stale completing-milestone phase.
      if (isDbAvailable()) {
        const milestone = getMilestone(mid);
        if (milestone && isClosedStatus(milestone.status)) {
          return { action: "skip" };
        }
      }

      const existingSummary = resolveMilestoneFile(basePath, mid, "SUMMARY");
      let summaryOutcome: "success" | "failure" | "unknown" = "unknown";
      if (existingSummary) {
        const summaryContent = await loadFile(existingSummary);
        if (summaryContent) {
          summaryOutcome = classifyMilestoneSummaryContent(summaryContent);
        }
      }

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

      // Disk/DB mismatch handling (#4658): SUMMARY presence alone is not enough.
      // Apply post-gate policy:
      // - success summary: reconcile DB and skip re-dispatch
      // - failure summary: pause/fail-closed
      // - unknown summary: pause/fail-closed
      if (existingSummary) {
        const milestone = isDbAvailable() ? getMilestone(mid) : null;
        const status = milestone?.status ?? (isDbAvailable() ? "missing" : "unavailable");

        if (summaryOutcome === "success") {
          if (!isDbAvailable()) {
            logWarning("dispatch", `Milestone ${mid} SUMMARY indicates completion while DB is unavailable — skipping duplicate complete-milestone dispatch`);
            return { action: "skip" };
          }
          try {
            updateMilestoneStatus(mid, "complete", new Date().toISOString());
            logWarning("dispatch", `Milestone ${mid} SUMMARY indicates completion while DB status was "${status}" — reconciled DB to complete (#4658)`);
            return { action: "skip" };
          } catch (err) {
            return {
              action: "stop",
              level: "warning",
              reason: `Milestone ${mid} SUMMARY indicates completion but DB reconciliation failed (${err instanceof Error ? err.message : String(err)}). Auto-mode paused for manual review.`,
            };
          }
        }

        if (summaryOutcome === "failure") {
          return {
            action: "stop",
            level: "warning",
            reason: `Milestone ${mid} has a failure-path SUMMARY while DB status is "${status}". Auto-mode will not promote completion from failure artifacts. Re-run complete-milestone only after blockers are resolved and verification passes.`,
          };
        }

        return {
          action: "stop",
          level: "warning",
          reason: `Milestone ${mid} has an ambiguous SUMMARY while DB status is "${status}". Auto-mode paused instead of promoting completion from file presence alone.`,
        };
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

  // No rule matched — unhandled phase.
  // Use level "warning" so the loop pauses (resumable) instead of hard-stopping.
  // Hard-stop here was causing premature termination for transient phase gaps
  // (e.g. after reassessment modifies the roadmap and state needs re-derivation).
  return {
    action: "stop",
    reason: `Unhandled phase "${ctx.state.phase}" — run /gsd doctor to diagnose.`,
    level: "warning",
    matchedRule: "<no-match>",
  };
}

/** Exposed for testing — returns the rule names in evaluation order. */
export function getDispatchRuleNames(): string[] {
  return DISPATCH_RULES.map((r) => r.name);
}
