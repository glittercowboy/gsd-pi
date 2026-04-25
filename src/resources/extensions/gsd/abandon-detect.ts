/**
 * Abandon-milestone detection for rewrite-docs overrides (#3490).
 *
 * Isolated from auto-post-unit.ts so behavioral tests can import this module
 * without pulling in the full post-unit handler graph (which transitively
 * loads model-router, workflow engine, etc.).
 */

import type { Override } from "./files.js";

// Detect when a rewrite-docs override is about abandoning THE CURRENT
// MILESTONE — not just any override containing an abandon verb. Naively
// matching `/\b(abandon|cancel|drop|...)\b/` against override text produces
// false positives on scope-change prose ("cancel the standup reminder",
// "drop the dependency on X", "scrap the v1 design for the landing page").
//
// To qualify as an abandon-milestone signal, an override must contain both:
//   1. An abandon-family verb (abandon|descope|cancel|shelve|drop|scrap)
//   2. A milestone reference — either the literal word "milestone" or the
//      current milestone ID — in the same override text.

// Verb variants cover both US and UK inflections:
//   cancel / canceled / canceling / cancelled / cancelling / cancels
//   travel-style "l"-doubling also applies to shelve/drop/scrap.
// "descope" also accepts "de-scope" and "de scope" (hyphen / space forms).
const ABANDON_VERB_RE = /\b(abandon(?:ed|ing|s)?|de[-\s]?scope(?:d|s|ing)?|cancel(?:led|ling|ed|ing|s)?|shelve(?:d|s)?|shelving|drop(?:ped|ping|s)?|scrap(?:ped|ping|s)?)\b/i;

export interface AbandonDecision {
  shouldPark: boolean;
  reason: string;
  matched: string[];
}

/**
 * Decide whether a set of active overrides indicates the current milestone
 * should be parked. Pure function — no I/O, no imports beyond types.
 */
export function detectAbandonMilestone(
  overrides: Override[],
  currentMilestoneId: string | null | undefined,
): AbandonDecision {
  if (!currentMilestoneId) {
    return { shouldPark: false, reason: "", matched: [] };
  }

  const escapedId = currentMilestoneId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const milestoneRefRe = new RegExp(`\\b(?:milestone|${escapedId})\\b`, "i");

  const matched = overrides
    .filter(o => ABANDON_VERB_RE.test(o.change) && milestoneRefRe.test(o.change))
    .map(o => o.change);

  if (matched.length === 0) {
    return { shouldPark: false, reason: "", matched: [] };
  }

  return {
    shouldPark: true,
    reason: matched.join("; "),
    matched,
  };
}
