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
import { isDbAvailable, getMilestoneSlices, getPendingGates, markAllGatesOmitted, getMilestone, updateMilestoneStatus } from "./gsd-db.js";
import { isClosedStatus } from "./status-guards.js";
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
import { validateArtifact } from "./schemas/validate.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { logWarning, logError } from "./workflow-logger.js";
import { join } from "node:path";
import { hasImplementationArtifacts } from "./auto-recovery.js";
import { classifyMilestoneSummaryContent } from "./milestone-summary-classifier.js";
import {
  buildDiscussMilestonePrompt,
  buildDiscussProjectPrompt,
  buildDiscussRequirementsPrompt,
  buildResearchDecisionPrompt,
  buildResearchProjectPrompt,
  buildWorkflowPreferencesPrompt,
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
import { getMilestonePipelineVariant } from "./milestone-scope-classifier.js";
import { EXECUTION_ENTRY_PHASES, hasFinalizedMilestoneContext } from "./uok/plan-v2.js";
import { isAutoActive } from "./auto.js";
import { markDepthVerified } from "./bootstrap/write-gate.js";

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
  structuredQuestionsAvailable?: "true" | "false";
  /** Session model context window in tokens, forwarded to the budget engine's prompt builders. */
  sessionContextWindow?: number;
  /** Model registry forwarded to the budget engine so it can look up the configured executor model. */
  modelRegistry?: MinimalModelRegistry;
}

type ReassessmentChecker = typeof checkNeedsReassessment;
type ResearchProjectPromptBuilder = typeof buildResearchProjectPrompt;

let reassessmentChecker: ReassessmentChecker = checkNeedsReassessment;
let researchProjectPromptBuilder: ResearchProjectPromptBuilder = buildResearchProjectPrompt;

export function setReassessmentCheckerForTest(checker: ReassessmentChecker): () => void {
  const previous = reassessmentChecker;
  reassessmentChecker = checker;
  return () => {
    reassessmentChecker = previous;
  };
}

export function setResearchProjectPromptBuilderForTest(builder: ResearchProjectPromptBuilder): () => void {
  const previous = researchProjectPromptBuilder;
  researchProjectPromptBuilder = builder;
  return () => {
    researchProjectPromptBuilder = previous;
  };
}

export interface DispatchRule {
  /** Human-readable name for debugging and test identification */
  name: string;
  /** Return a DispatchAction if this rule matches, null to fall through */
  match: (ctx: DispatchContext) => Promise<DispatchAction | null>;
}

const PROJECT_RESEARCH_DIMENSIONS = ["STACK", "FEATURES", "ARCHITECTURE", "PITFALLS"] as const;

function isProjectResearchDimensionSatisfied(researchDir: string, name: string): boolean {
  return (
    existsSync(join(researchDir, `${name}.md`)) ||
    existsSync(join(researchDir, `${name}-BLOCKER.md`))
  );
}

function isProjectResearchComplete(researchDir: string): boolean {
  return PROJECT_RESEARCH_DIMENSIONS.every((name) =>
    isProjectResearchDimensionSatisfied(researchDir, name),
  );
}

async function readUatGateVerdict(
  basePath: string,
  mid: string,
  sliceId: string,
): Promise<{ verdict: string; uatType: UatType | undefined } | null> {
  const uatFile = resolveSliceFile(basePath, mid, sliceId, "UAT");
  const assessmentFile = resolveSliceFile(basePath, mid, sliceId, "ASSESSMENT");

  const uatContent = uatFile ? await loadFile(uatFile) : null;
  const uatType = uatContent ? extractUatType(uatContent) : undefined;

  const assessmentContent = assessmentFile ? await loadFile(assessmentFile) : null;
  if (assessmentContent) {
    const assessmentVerdict = extractVerdict(assessmentContent);
    if (assessmentVerdict) {
      return {
        verdict: assessmentVerdict,
        uatType: uatType ?? extractUatType(assessmentContent),
      };
    }
  }

  if (uatContent) {
    const legacyUatVerdict = extractVerdict(uatContent);
    if (legacyUatVerdict) {
      return { verdict: legacyUatVerdict, uatType };
    }
  }

  return null;
}

/**
 * Read the YAML frontmatter from .gsd/PREFERENCES.md and check whether the
 * deep-mode workflow-preferences wizard has run. Uses an explicit
 * `workflow_prefs_captured: true` marker so a partial frontmatter (e.g.
 * just `commit_policy: merge`) does not falsely suppress the wizard.
 */
function isWorkflowPrefsCaptured(basePath: string): boolean {
  const prefsPath = join(gsdRoot(basePath), "PREFERENCES.md");
  if (!existsSync(prefsPath)) return false;
  let content: string;
  try {
    content = readFileSync(prefsPath, "utf-8");
  } catch {
    return false;
  }
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return false;
  // Match a top-level "workflow_prefs_captured: true" line. The frontmatter is
  // YAML; this lightweight regex avoids pulling in the YAML parser at the
  // dispatch hot path. Treats only an explicit `true` value as captured.
  return /^workflow_prefs_captured:\s*true\s*$/m.test(match[1]);
}

/**
 * Deep planning mode: check whether any project-level stage gate
 * (workflow-preferences, discuss-project, discuss-requirements,
 * research-decision, research-project) still has work pending.
 *
 * Used by the milestone-level discuss rules to yield to project-level
 * deep-mode rules when the project hasn't finished its setup interview.
 * Returns false in light mode (or when prefs absent) so the milestone
 * rules behave exactly as before.
 */
function hasPendingDeepStage(prefs: GSDPreferences | undefined, basePath: string): boolean {
  if (prefs?.planning_depth !== "deep") return false;
  const root = gsdRoot(basePath);
  // 1. workflow-preferences captured (explicit marker in PREFERENCES.md frontmatter).
  if (!isWorkflowPrefsCaptured(basePath)) return true;
  // 2. PROJECT.md exists and passes validation.
  const projectPath = join(root, "PROJECT.md");
  if (!existsSync(projectPath)) return true;
  if (!validateArtifact(projectPath, "project").ok) return true;
  // 3. REQUIREMENTS.md exists and passes validation.
  const requirementsPath = join(root, "REQUIREMENTS.md");
  if (!existsSync(requirementsPath)) return true;
  if (!validateArtifact(requirementsPath, "requirements").ok) return true;
  // 4. research-decision marker exists.
  const decisionPath = join(root, "runtime", "research-decision.json");
  if (!existsSync(decisionPath)) return true;
  // 5. Decision must be one of the recognized values; if not, the
  // research-decision rule will re-ask. Any value other than "research" or
  // "skip" — including a missing field, malformed JSON, or "garbage" — must
  // be treated as pending here, otherwise this guard reports "all gates
  // passed" while the downstream research-decision rule disagrees.
  try {
    const cfg = JSON.parse(readFileSync(decisionPath, "utf-8")) as Record<string, unknown>;
    const decision = typeof cfg.decision === "string" ? cfg.decision : undefined;
    if (decision !== "research" && decision !== "skip") return true;
    if (decision === "research") {
      const researchDir = join(root, "research");
      if (!isProjectResearchComplete(researchDir)) return true;
    }
  } catch {
    return true; // malformed — research-decision rule will re-ask
  }
  return false;
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
      // H6 fix (#4973): In auto-mode there is no human to answer the
      // depth-verification ask_user_questions, so the write-gate deadlocks.
      // Pre-mark the milestone as depth-verified so gsd_summary_save({artifact_type:"CONTEXT"})
      // is not blocked. Safe ordering: session_switch fires clearDiscussionFlowState()
      // (register-hooks.ts:106) before before_agent_start, which fires before resolveDispatch
      // reaches this match fn — so this call always happens after any session-switch reset.
      // Interactive sessions (isAutoActive()===false) are unaffected.
      if (isAutoActive()) {
        markDepthVerified(mid, basePath);
      }
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

      // DB-first: prefer closed slices from DB; fall back to ROADMAP on disk.
      let closedSliceIds: string[];
      if (isDbAvailable()) {
        closedSliceIds = getMilestoneSlices(mid)
          .filter(s => isClosedStatus(s.status))
          .map(s => s.id);
      } else {
        // Filesystem fallback for degraded / unmigrated projects.
        // `slice.done` in the parsed ROADMAP is the disk-level closed signal.
        const roadmapFile = resolveMilestoneFile(basePath, mid, "ROADMAP");
        const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
        if (!roadmapContent) return null;
        const roadmap = parseRoadmap(roadmapContent);
        closedSliceIds = roadmap.slices.filter(s => s.done).map(s => s.id);
      }

      for (const sliceId of closedSliceIds) {
        const result = await readUatGateVerdict(basePath, mid, sliceId);
        if (!result) continue;
        const { verdict, uatType } = result;

        if (!isAcceptableUatVerdict(verdict, uatType)) {
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
      // Default reassess_after_slice to false per ADR-003 §4 — most reassess
      // units conclude "roadmap is fine" and burn a session for no change.
      // The plan-slice prompt now carries a reassessment preamble so the
      // next slice's planner does JIT roadmap verification at zero extra
      // cost. Opt-in via explicit `reassess_after_slice: true` (e.g.
      // burn-max profile) when you want the dedicated reassess session.
      const reassessEnabled = prefs?.phases?.reassess_after_slice ?? false;
      if (!reassessEnabled) return null;
      const needsReassess = await reassessmentChecker(basePath, mid, state);
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
    match: async ({ state, mid, midTitle, basePath, prefs, structuredQuestionsAvailable }) => {
      if (state.phase !== "needs-discussion") return null;
      // Deep mode bypass: yield to the project-level deep stage gates
      // (workflow-prefs, discuss-project, discuss-requirements,
      // research-decision, research-project) when any of them still have
      // work pending. Without this guard, the milestone discuss rule wins
      // before the deep rules ever get a chance to fire.
      if (hasPendingDeepStage(prefs, basePath)) return null;
      // H6 fix (#4973): auto-mark depth-verified so the write-gate does not
      // deadlock in non-interactive (auto-mode) runs. See ordering note at
      // "execution-entry phase (no context) → discuss-milestone" above.
      if (isAutoActive()) {
        markDepthVerified(mid, basePath);
      }
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
    // Deep mode stage gate: workflow preferences not yet captured.
    // Fires once per project, before discuss-project, when planning_depth === "deep"
    // and the .gsd/PREFERENCES.md frontmatter does NOT carry the
    // `workflow_prefs_captured: true` marker. Light mode skips entirely.
    name: "deep: pre-planning (no workflow prefs) → workflow-preferences",
    match: async ({ state, basePath, prefs, structuredQuestionsAvailable }) => {
      if (prefs?.planning_depth !== "deep") return null;
      if (state.phase !== "pre-planning" && state.phase !== "needs-discussion") return null;
      if (isWorkflowPrefsCaptured(basePath)) return null; // already captured — fall through
      return {
        action: "dispatch",
        unitType: "workflow-preferences",
        unitId: "WORKFLOW-PREFS",
        prompt: await buildWorkflowPreferencesPrompt(basePath, structuredQuestionsAvailable),
      };
    },
  },
  {
    // Deep mode stage gate: PROJECT.md missing or invalid.
    // Fires only when planning_depth === "deep" and PROJECT.md is missing/invalid.
    // Project-level interview must complete before any milestone-level discussion.
    // Light mode (default) skips this rule entirely — falls through to milestone rules.
    name: "deep: pre-planning (no PROJECT) → discuss-project",
    match: async ({ state, basePath, prefs, structuredQuestionsAvailable }) => {
      if (prefs?.planning_depth !== "deep") return null;
      if (state.phase !== "pre-planning" && state.phase !== "needs-discussion") return null;
      const projectPath = join(gsdRoot(basePath), "PROJECT.md");
      if (existsSync(projectPath) && validateArtifact(projectPath, "project").ok) return null; // PROJECT.md valid — fall through
      return {
        action: "dispatch",
        unitType: "discuss-project",
        unitId: "PROJECT",
        prompt: await buildDiscussProjectPrompt(basePath, structuredQuestionsAvailable),
      };
    },
  },
  {
    // Deep mode stage gate: REQUIREMENTS.md missing or invalid.
    // Fires only when planning_depth === "deep", PROJECT.md is valid, and
    // REQUIREMENTS.md is missing/invalid.
    // Falls through in light mode or when REQUIREMENTS.md already exists and is valid.
    name: "deep: pre-planning (no REQUIREMENTS) → discuss-requirements",
    match: async ({ state, basePath, prefs, structuredQuestionsAvailable }) => {
      if (prefs?.planning_depth !== "deep") return null;
      if (state.phase !== "pre-planning" && state.phase !== "needs-discussion") return null;
      const projectPath = join(gsdRoot(basePath), "PROJECT.md");
      if (!existsSync(projectPath) || !validateArtifact(projectPath, "project").ok) return null; // PROJECT.md missing/invalid — earlier rule handles
      const requirementsPath = join(gsdRoot(basePath), "REQUIREMENTS.md");
      if (existsSync(requirementsPath) && validateArtifact(requirementsPath, "requirements").ok) return null; // REQUIREMENTS.md valid — fall through
      return {
        action: "dispatch",
        unitType: "discuss-requirements",
        unitId: "REQUIREMENTS",
        prompt: await buildDiscussRequirementsPrompt(basePath, structuredQuestionsAvailable),
      };
    },
  },
  {
    // Deep mode research gate: capture user's research decision.
    // Fires after discuss-requirements (REQUIREMENTS.md exists) when no decision
    // marker has been written yet. Asks one yes/no question via ask_user_questions
    // and writes .gsd/runtime/research-decision.json. Downstream research-project
    // rule reads the marker to decide whether to fan out 4 parallel research subagents.
    // Light mode skips entirely.
    name: "deep: pre-planning (no research decision) → research-decision",
    match: async ({ state, basePath, prefs, structuredQuestionsAvailable }) => {
      if (prefs?.planning_depth !== "deep") return null;
      if (state.phase !== "pre-planning" && state.phase !== "needs-discussion") return null;
      const requirementsPath = join(gsdRoot(basePath), "REQUIREMENTS.md");
      if (!existsSync(requirementsPath)) return null; // earlier rule handles
      const decisionPath = join(gsdRoot(basePath), "runtime", "research-decision.json");
      if (existsSync(decisionPath)) {
        // I3: a corrupted decision marker must NOT silently fall through to
        // milestone planning — re-ask. Treat any parse error or missing
        // decision field as "not yet decided".
        try {
          const cfg = JSON.parse(readFileSync(decisionPath, "utf-8")) as Record<string, unknown>;
          const decision = typeof cfg.decision === "string" ? cfg.decision : undefined;
          if (decision === "research" || decision === "skip") return null; // valid — fall through
          logWarning("dispatch", `research-decision.json missing or has unrecognized "decision" field — re-asking`);
        } catch (err) {
          logWarning("dispatch", `malformed research-decision.json — re-asking: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return {
        action: "dispatch",
        unitType: "research-decision",
        unitId: "RESEARCH-DECISION",
        prompt: await buildResearchDecisionPrompt(basePath, structuredQuestionsAvailable),
      };
    },
  },
  {
    // Deep mode parallel research.
    // Fires when planning_depth === "deep", REQUIREMENTS.md exists,
    // research-decision marker says "research", and any of the 4 project
    // research files is missing. Spawns one orchestrator session that fans
    // out 4 parallel subagents (stack, features, architecture, pitfalls).
    // Skipped entirely when user chose "skip" at the research-decision gate.
    name: "deep: pre-planning (research approved, files missing) → research-project",
    match: async ({ state, basePath, prefs, structuredQuestionsAvailable }) => {
      if (prefs?.planning_depth !== "deep") return null;
      if (state.phase !== "pre-planning" && state.phase !== "needs-discussion") return null;
      const requirementsPath = join(gsdRoot(basePath), "REQUIREMENTS.md");
      if (!existsSync(requirementsPath)) return null; // earlier rule handles
      const decisionPath = join(gsdRoot(basePath), "runtime", "research-decision.json");
      if (!existsSync(decisionPath)) return null; // research-decision rule handles
      let decision: string | undefined;
      try {
        const cfg = JSON.parse(readFileSync(decisionPath, "utf-8")) as Record<string, unknown>;
        decision = typeof cfg.decision === "string" ? cfg.decision : undefined;
      } catch (err) {
        logWarning("dispatch", `malformed research-decision.json — leaving for research-decision rule to re-ask: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
      if (decision !== "research") return null; // user picked "skip" — fall through
      const researchDir = join(gsdRoot(basePath), "research");
      if (isProjectResearchComplete(researchDir)) return null; // already done — fall through
      // Idempotency guard: one orchestrator owns the project research fan-out
      // until guided-research-project.md deletes this marker during closeout.
      const runtimeDir = join(gsdRoot(basePath), "runtime");
      const inflightMarkerPath = join(runtimeDir, "research-project-inflight");
      if (existsSync(inflightMarkerPath)) return null; // already in flight — wait
      mkdirSync(runtimeDir, { recursive: true });
      try {
        writeFileSync(
          inflightMarkerPath,
          JSON.stringify({ started: new Date().toISOString() }) + "\n",
          { encoding: "utf-8", flag: "wx" },
        );
      } catch (err) {
        if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") return null;
        throw err;
      }
      try {
        const prompt = await researchProjectPromptBuilder(basePath, structuredQuestionsAvailable);
        return {
          action: "dispatch",
          unitType: "research-project",
          unitId: "RESEARCH-PROJECT",
          prompt,
        };
      } catch (err) {
        try {
          if (existsSync(inflightMarkerPath)) unlinkSync(inflightMarkerPath);
        } catch {
          // Preserve the prompt assembly error; marker cleanup is best-effort.
        }
        throw err;
      }
    },
  },
  {
    name: "pre-planning (no context) → discuss-milestone",
    match: async ({ state, mid, midTitle, basePath, structuredQuestionsAvailable }) => {
      if (state.phase !== "pre-planning") return null;
      const contextFile = resolveMilestoneFile(basePath, mid, "CONTEXT");
      const hasContext = !!(contextFile && (await loadFile(contextFile)));
      if (hasContext) return null; // fall through to next rule
      // H6 fix (#4973): auto-mark depth-verified so the write-gate does not
      // deadlock in non-interactive (auto-mode) runs. See ordering note at
      // "execution-entry phase (no context) → discuss-milestone" above.
      if (isAutoActive()) {
        markDepthVerified(mid, basePath);
      }
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
      // #4781 phase 2: trivial-scope milestones skip dedicated slice research.
      // plan-slice absorbs the lightweight discovery a trivial deliverable
      // needs. Null result (DB unavailable / unknown) falls through to today's
      // behavior.
      if (await getMilestonePipelineVariant(mid) === "trivial") return null;

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
      // #4781 phase 2: trivial-scope milestones skip dedicated slice research.
      if (await getMilestonePipelineVariant(mid) === "trivial") return null;
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
    name: "executing → reactive-execute (parallel dispatch)",
    match: async ({ state, mid, midTitle, basePath, prefs, sessionContextWindow, modelRegistry }) => {
      if (state.phase !== "executing" || !state.activeTask) return null;
      if (!state.activeSlice) return null; // fall through

      // Reactive dispatch is on by default when there are enough ready tasks to
      // benefit from parallelism. Users opt out explicitly via
      // `reactive_execution.enabled: false`. The downstream safety checks
      // (graph ambiguity, ready-task count, conflict-free selection) still gate
      // every actual dispatch, so the worst-case "default-on" outcome is the
      // same fall-through to sequential execution as before.
      const reactiveConfig = prefs?.reactive_execution;
      if (reactiveConfig?.enabled === false) return null;

      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;
      const maxParallel = reactiveConfig?.max_parallel ?? 2;
      const subagentModel = reactiveConfig?.subagent_model ?? resolveModelWithFallbacksForUnit("subagent")?.primary;
      // Default-on safety threshold: only activate reactive dispatch when at
      // least N tasks are ready. Users who explicitly enabled reactive_execution
      // keep the legacy threshold of 2 (matches the prior "any parallelism is
      // better than none" intent). Default-on installs require >=3 to avoid
      // surprising users with parallelism on small slices.
      const minReadyTasksForReactive = reactiveConfig?.enabled === true ? 2 : 3;

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

        // Only activate reactive dispatch when enough tasks are ready.
        // Threshold is 2 when explicitly opted in, 3 when default-on.
        if (readyIds.length < minReadyTasksForReactive) return null;

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

      // #4781 phase 2: trivial-scope milestones skip the dedicated validate
      // unit — complete-milestone's own verification steps (3/4/5 in the
      // closer prompt) are sufficient proof for contained deliverables.
      const trivialVariant = await getMilestonePipelineVariant(mid) === "trivial";

      // Skip preference OR trivial scope: write a minimal pass-through VALIDATION file.
      if (prefs?.phases?.skip_milestone_validation || trivialVariant) {
        const mDir = resolveMilestonePath(basePath, mid);
        if (mDir) {
          if (!existsSync(mDir)) mkdirSync(mDir, { recursive: true });
          const validationPath = join(
            mDir,
            buildMilestoneFileName(mid, "VALIDATION"),
          );
          const skipSource = trivialVariant
            ? "trivial-scope pipeline variant (#4781)"
            : "`skip_milestone_validation` preference";
          const content = [
            "---",
            "verdict: pass",
            "remediation_round: 0",
            "---",
            "",
            "# Milestone Validation (skipped)",
            "",
            `Milestone validation was skipped via ${skipSource}.`,
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
      const artifactCheck = hasImplementationArtifacts(basePath, mid);
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
