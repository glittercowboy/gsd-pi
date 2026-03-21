/**
 * Unified Execution Contract — shared prompt assembly for auto and guided modes.
 *
 * Thin coordination layer that delegates to `auto-prompts.ts` build functions
 * and post-processes output based on execution mode. For auto mode, output is
 * returned unchanged. For guided mode, the "You are executing GSD auto-mode."
 * framing line is stripped since `dispatchWorkflow()` wraps with GSD-WORKFLOW.md
 * protocol instead.
 *
 * Import direction: execution-contract → auto-prompts (never the reverse).
 */

import {
  buildExecuteTaskPrompt,
  buildCompleteSlicePrompt,
  buildPlanSlicePrompt,
  buildPlanMilestonePrompt,
  buildResearchSlicePrompt,
} from "./auto-prompts.js";
import type { InlineLevel } from "./types.js";
import { debugLog } from "./debug-logger.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExecutionMode = "auto" | "guided";

// ─── Framing Helpers ──────────────────────────────────────────────────────────

/**
 * The auto-mode framing line present at the top of every auto-mode prompt
 * template. Guided mode strips this because `dispatchWorkflow()` provides
 * its own protocol wrapper via GSD-WORKFLOW.md.
 */
const AUTO_MODE_FRAMING = "You are executing GSD auto-mode.";

/**
 * Strip the auto-mode framing line from a prompt string.
 *
 * Removes the first line if it exactly matches "You are executing GSD auto-mode."
 * (with optional leading/trailing whitespace on that line). Preserves all other
 * content unchanged.
 */
export function stripAutoModeFraming(prompt: string): string {
  const lines = prompt.split("\n");
  if (lines.length > 0 && lines[0].trim() === AUTO_MODE_FRAMING) {
    // Remove the framing line and any immediately following blank line
    const rest = lines.slice(1);
    if (rest.length > 0 && rest[0].trim() === "") {
      return rest.slice(1).join("\n");
    }
    return rest.join("\n");
  }
  return prompt;
}

/**
 * Apply mode-specific post-processing to a built prompt.
 * Auto mode: returned unchanged.
 * Guided mode: auto-mode framing line stripped.
 */
function applyMode(prompt: string, mode: ExecutionMode): string {
  if (mode === "guided") {
    return stripAutoModeFraming(prompt);
  }
  return prompt;
}

// ─── Assembly Functions ───────────────────────────────────────────────────────

/**
 * Assemble an execute-task prompt via the shared contract.
 *
 * Delegates to `buildExecuteTaskPrompt()` from auto-prompts, then strips
 * auto-mode framing for guided mode.
 */
export async function assembleExecuteTaskPrompt(
  mid: string,
  sid: string,
  sTitle: string,
  tid: string,
  tTitle: string,
  base: string,
  mode: ExecutionMode,
  level?: InlineLevel,
): Promise<string> {
  debugLog("execution-contract", {
    fn: "assembleExecuteTaskPrompt",
    mode,
    mid,
    sid,
    tid,
  });
  const prompt = await buildExecuteTaskPrompt(mid, sid, sTitle, tid, tTitle, base, level);
  return applyMode(prompt, mode);
}

/**
 * Assemble a complete-slice prompt via the shared contract.
 */
export async function assembleCompleteSlicePrompt(
  mid: string,
  midTitle: string,
  sid: string,
  sTitle: string,
  base: string,
  mode: ExecutionMode,
  level?: InlineLevel,
): Promise<string> {
  debugLog("execution-contract", {
    fn: "assembleCompleteSlicePrompt",
    mode,
    mid,
    sid,
  });
  const prompt = await buildCompleteSlicePrompt(mid, midTitle, sid, sTitle, base, level);
  return applyMode(prompt, mode);
}

/**
 * Assemble a plan-slice prompt via the shared contract.
 */
export async function assemblePlanSlicePrompt(
  mid: string,
  midTitle: string,
  sid: string,
  sTitle: string,
  base: string,
  mode: ExecutionMode,
  level?: InlineLevel,
): Promise<string> {
  debugLog("execution-contract", {
    fn: "assemblePlanSlicePrompt",
    mode,
    mid,
    sid,
  });
  const prompt = await buildPlanSlicePrompt(mid, midTitle, sid, sTitle, base, level);
  return applyMode(prompt, mode);
}

/**
 * Assemble a plan-milestone prompt via the shared contract.
 */
export async function assemblePlanMilestonePrompt(
  mid: string,
  midTitle: string,
  base: string,
  mode: ExecutionMode,
  level?: InlineLevel,
): Promise<string> {
  debugLog("execution-contract", {
    fn: "assemblePlanMilestonePrompt",
    mode,
    mid,
  });
  const prompt = await buildPlanMilestonePrompt(mid, midTitle, base, level);
  return applyMode(prompt, mode);
}

/**
 * Assemble a research-slice prompt via the shared contract.
 */
export async function assembleResearchSlicePrompt(
  mid: string,
  midTitle: string,
  sid: string,
  sTitle: string,
  base: string,
  mode: ExecutionMode,
): Promise<string> {
  debugLog("execution-contract", {
    fn: "assembleResearchSlicePrompt",
    mode,
    mid,
    sid,
  });
  const prompt = await buildResearchSlicePrompt(mid, midTitle, sid, sTitle, base);
  return applyMode(prompt, mode);
}

/**
 * Assemble a resume-task prompt via the shared contract.
 *
 * Delegates to `buildExecuteTaskPrompt()` — the resume state is handled
 * internally by that function (it reads the continue file and builds the
 * resume section automatically). The caller just needs to provide the
 * same parameters as execute-task.
 */
export async function assembleResumeTaskPrompt(
  mid: string,
  sid: string,
  sTitle: string,
  tid: string,
  tTitle: string,
  base: string,
  mode: ExecutionMode,
  level?: InlineLevel,
): Promise<string> {
  debugLog("execution-contract", {
    fn: "assembleResumeTaskPrompt",
    mode,
    mid,
    sid,
    tid,
    isResume: true,
  });
  // buildExecuteTaskPrompt already detects and includes the continue file
  // contents in its resume section — no special flag needed.
  const prompt = await buildExecuteTaskPrompt(mid, sid, sTitle, tid, tTitle, base, level);
  return applyMode(prompt, mode);
}
