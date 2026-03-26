/**
 * Centralized verdict extraction, normalization, and schema validation.
 *
 * All verdict-related logic lives here so that normalization rules
 * (e.g. `passed` → `pass`) are applied consistently across the codebase.
 */

import { extractUatType } from "./files.js";
import type { UatType } from "./files.js";

// ── Verdict extraction ──────────────────────────────────────────────────

/**
 * Extract and normalize the `verdict` value from YAML frontmatter.
 *
 * Normalization:
 * - lowercased
 * - `passed` → `pass`
 *
 * Returns `undefined` when frontmatter is absent or has no `verdict` field.
 */
export function extractVerdict(content: string): string | undefined {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return undefined;
  const verdictMatch = fmMatch[1].match(/verdict:\s*([\w-]+)/i);
  if (!verdictMatch) return undefined;
  let v = verdictMatch[1].toLowerCase();
  if (v === "passed") v = "pass";
  return v;
}

/**
 * Returns `true` when the content's frontmatter contains a `verdict` field.
 */
export function hasVerdict(content: string): boolean {
  return /verdict:\s*[\w-]+/i.test(content);
}

// ── UAT verdict schema ──────────────────────────────────────────────────

/**
 * Base verdicts that are always acceptable for UAT results.
 */
export const UAT_ACCEPTABLE_VERDICTS: readonly string[] = ["pass", "passed"];

/**
 * UAT types whose results may legitimately produce a `partial` verdict
 * when all automatable checks pass but human-only checks remain.
 */
const PARTIAL_ELIGIBLE_UAT_TYPES: readonly UatType[] = [
  "mixed",
  "human-experience",
  "live-runtime",
];

/**
 * Check whether a verdict is acceptable for a given UAT type.
 *
 * `pass` / `passed` are always acceptable. `partial` is acceptable only for
 * UAT types that include non-automatable human checks.
 */
export function isAcceptableUatVerdict(verdict: string, uatType: UatType | undefined): boolean {
  if (UAT_ACCEPTABLE_VERDICTS.includes(verdict)) return true;
  if (verdict === "partial" && uatType && (PARTIAL_ELIGIBLE_UAT_TYPES as readonly string[]).includes(uatType)) {
    return true;
  }
  return false;
}

// ── Milestone validation verdict schema ─────────────────────────────────

/**
 * Valid verdicts for the `validate-milestone` tool.
 */
export const VALIDATION_VERDICTS = ["pass", "needs-attention", "needs-remediation"] as const;
export type ValidationVerdict = (typeof VALIDATION_VERDICTS)[number];

/**
 * Check whether a string is a valid milestone validation verdict.
 */
export function isValidMilestoneVerdict(verdict: string): verdict is ValidationVerdict {
  return (VALIDATION_VERDICTS as readonly string[]).includes(verdict);
}

// ── UAT type helper ─────────────────────────────────────────────────────

/**
 * Extract the UAT type from content, defaulting to `"artifact-driven"`.
 *
 * The `"artifact-driven"` fallback is the original default used throughout
 * the codebase when a UAT file lacks an explicit `## UAT Type` section.
 */
export function getUatType(content: string): UatType {
  return extractUatType(content) ?? "artifact-driven";
}
