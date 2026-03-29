/**
 * Input sanitization for gsd_complete_milestone parameters.
 *
 * The Claude SDK deserializes tool-call JSON before the handler runs.
 * When an LLM (especially smaller models like haiku) generates large markdown
 * parameters, the JSON can arrive with subtly wrong types — numbers where
 * strings are expected, null where arrays belong, string "true" instead of
 * boolean true, etc.  This sanitizer normalizes all fields so
 * handleCompleteMilestone never crashes on type mismatches.
 *
 * See: https://github.com/gsd-build/gsd-2/issues/3013
 */

import type { CompleteMilestoneParams } from "../tools/complete-milestone.js";

/**
 * Coerce an unknown value to a trimmed string.
 * Returns "" for null / undefined.
 */
function toStr(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

/**
 * Coerce an unknown value to an array of trimmed, non-empty strings.
 * - If already an array, filter/trim each element.
 * - Otherwise return [].
 */
function toStrArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((item) => (item == null ? "" : String(item).trim()))
    .filter((s) => s.length > 0);
}

/**
 * Sanitize raw params from the tool-call framework into well-typed
 * CompleteMilestoneParams, tolerating type mismatches from LLM JSON quirks.
 */
export function sanitizeCompleteMilestoneParams(raw: Record<string, unknown>): CompleteMilestoneParams {
  return {
    milestoneId: toStr(raw.milestoneId),
    title: toStr(raw.title),
    oneLiner: toStr(raw.oneLiner),
    narrative: toStr(raw.narrative),
    successCriteriaResults: toStr(raw.successCriteriaResults),
    definitionOfDoneResults: toStr(raw.definitionOfDoneResults),
    requirementOutcomes: toStr(raw.requirementOutcomes),
    keyDecisions: toStrArray(raw.keyDecisions),
    keyFiles: toStrArray(raw.keyFiles),
    lessonsLearned: toStrArray(raw.lessonsLearned),
    followUps: toStr(raw.followUps),
    deviations: toStr(raw.deviations),
    verificationPassed: raw.verificationPassed === true || raw.verificationPassed === "true",
  };
}
