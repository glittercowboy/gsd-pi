/**
 * EVAL-FIX frontmatter schema, parser, and cross-validator.
 *
 * The fix-agent output's machine-readable contract lives entirely in YAML
 * frontmatter; the body after the closing `---` is human-only prose.
 */

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parse as parseYaml } from "yaml";

import { DIMENSION_VALUES, SEVERITY_VALUES } from "./eval-review-schema.js";

// ─── Constants ────────────────────────────────────────────────────────────────

export const EVAL_FIX_SCHEMA_VERSION = "eval-fix/v1" as const;

export const STATUS_VALUES = ["NO_OP", "PARTIAL", "COMPLETE"] as const;

export const ACTION_VALUES = [
  "code_change",
  "test_added",
  "dependency_added",
  "doc_only",
  "partial",
  "declined",
] as const;

export const FILE_CHANGE_VALUES = ["added", "modified", "deleted"] as const;

// ─── Schema ───────────────────────────────────────────────────────────────────

const severitySchema = Type.Union(SEVERITY_VALUES.map((v) => Type.Literal(v)));
const dimensionSchema = Type.Union(DIMENSION_VALUES.map((v) => Type.Literal(v)));
const actionSchema = Type.Union(ACTION_VALUES.map((v) => Type.Literal(v)));
const statusSchema = Type.Union(STATUS_VALUES.map((v) => Type.Literal(v)));
const fileChangeSchema = Type.Union(FILE_CHANGE_VALUES.map((v) => Type.Literal(v)));

export const EvalFixFileTouched = Type.Object({
  path: Type.String({ minLength: 1 }),
  change: fileChangeSchema,
});

export const EvalFixEntry = Type.Object({
  gap_id: Type.String({ pattern: "^G\\d+$" }),
  dimension: dimensionSchema,
  severity: severitySchema,
  action: actionSchema,
  files_touched: Type.Array(EvalFixFileTouched),
  // minLength enforces non-empty; `validateFixesAgainstReview` adds the
  // citation-or-test-path requirement for non-declined entries.
  evidence: Type.String({ minLength: 1 }),
  rationale: Type.String({ minLength: 1 }),
});

export const EvalFixCounts = Type.Object({
  fixed: Type.Integer({ minimum: 0 }),
  partial: Type.Integer({ minimum: 0 }),
  declined: Type.Integer({ minimum: 0 }),
  total: Type.Integer({ minimum: 0 }),
});

export const EvalFixFrontmatter = Type.Object({
  schema: Type.Literal(EVAL_FIX_SCHEMA_VERSION),
  status: statusSchema,
  generated: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$" }),
  slice: Type.String({ pattern: "^S\\d+$" }),
  milestone: Type.String({ minLength: 1 }),
  // Basename only: must start with a word char (so `.` and `..` are out) and
  // is restricted to filename-safe chars; rejects path separators, whitespace,
  // and control characters by construction.
  review_source: Type.String({ pattern: "^\\w[\\w.-]*$" }),
  review_generated: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$" }),
  fixes: Type.Array(EvalFixEntry),
  counts: EvalFixCounts,
});

export type EvalFixFrontmatterT = Static<typeof EvalFixFrontmatter>;
export type EvalFixEntryT = Static<typeof EvalFixEntry>;
export type EvalFixCountsT = Static<typeof EvalFixCounts>;
export type EvalFixFileTouchedT = Static<typeof EvalFixFileTouched>;
export type EvalFixStatus = (typeof STATUS_VALUES)[number];
export type EvalFixAction = (typeof ACTION_VALUES)[number];

// ─── Frontmatter extraction ───────────────────────────────────────────────────

/**
 * Locate the YAML block between two `---` lines and return its raw text.
 * Tolerant to CRLF.
 */
export function extractFrontmatterRaw(
  raw: string,
): { yaml: string } | { error: string } {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") {
    return { error: "Missing opening `---` frontmatter delimiter on line 1" };
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      return { yaml: lines.slice(1, i).join("\n") };
    }
  }
  return { error: "Missing closing `---` frontmatter delimiter" };
}

// ─── Parser ───────────────────────────────────────────────────────────────────

export type ParseResult =
  | { ok: true; data: EvalFixFrontmatterT }
  | { ok: false; error: string; pointer: string };

export function parseEvalFixFrontmatter(raw: string): ParseResult {
  const fm = extractFrontmatterRaw(raw);
  if ("error" in fm) {
    return { ok: false, error: fm.error, pointer: "/" };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(fm.yaml, { schema: "core" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `YAML parse error: ${msg}`, pointer: "/" };
  }

  const schema: TSchema = EvalFixFrontmatter;
  if (!Value.Check(schema, parsed)) {
    const errs = [...Value.Errors(schema, parsed)];
    const first = errs[0];
    return {
      ok: false,
      error: `Schema validation failed: ${first?.message ?? "unknown error"}`,
      pointer: first?.path ?? "/",
    };
  }

  // Re-derive counts/status from fixes[] — schema-shape alone is forgeable.
  const data = parsed as EvalFixFrontmatterT;
  const derivedCounts = deriveCounts(data.fixes);
  if (
    data.counts.fixed !== derivedCounts.fixed ||
    data.counts.partial !== derivedCounts.partial ||
    data.counts.declined !== derivedCounts.declined ||
    data.counts.total !== derivedCounts.total
  ) {
    return {
      ok: false,
      error:
        `Schema validation failed: counts must match fixes[] ` +
        `(expected fixed=${derivedCounts.fixed} partial=${derivedCounts.partial} ` +
        `declined=${derivedCounts.declined} total=${derivedCounts.total})`,
      pointer: "/counts",
    };
  }
  const derivedStatus = deriveStatus(derivedCounts);
  if (data.status !== derivedStatus) {
    return {
      ok: false,
      error: `Schema validation failed: status must be ${derivedStatus} for the supplied fixes[]`,
      pointer: "/status",
    };
  }

  return { ok: true, data };
}

// ─── Derived fields ───────────────────────────────────────────────────────────

export function deriveCounts(fixes: readonly EvalFixEntryT[]): EvalFixCountsT {
  const counts: EvalFixCountsT = { fixed: 0, partial: 0, declined: 0, total: fixes.length };
  for (const f of fixes) {
    if (f.action === "declined") counts.declined++;
    else if (f.action === "partial") counts.partial++;
    else counts.fixed++;
  }
  return counts;
}

export function deriveStatus(counts: EvalFixCountsT): EvalFixStatus {
  if (counts.total === 0) return "NO_OP";
  if (counts.fixed === counts.total) return "COMPLETE";
  return "PARTIAL";
}

// ─── Cross-validation against the source EVAL-REVIEW.md ───────────────────────

// `(?<=\w)\.[A-Za-z]\w{0,11}:\d+` matches `<name>.<alpha-ext>:<line>` shapes
// like `wrapper.ts:42` or `parser.py:9`. The fixed-width lookbehind keeps the
// pattern linear (no catastrophic backtracking). Requiring an alpha first
// character in the extension rejects `v1.2:3`-style version tokens, and the
// lookbehind rejects bare `.ts:1` substrings that lack a filename.
const CITATION_RE = /(?<=\w)\.[A-Za-z]\w{0,11}:\d+/;
const TEST_PATH_RE = /(?:(?:^|[\/])tests?[\/])|(?:\.(?:test|spec)\.(?:[jt]sx?|mjs|cjs))|(?:_test\.go$)|(?:(?:^|[\/])test_[^\/]+\.py$)/;
const MAX_EVIDENCE_BYTES = 4096;

export function isCitationEvidence(evidence: string): boolean {
  const trimmed = evidence.trim();
  if (trimmed.length < 4) return false;
  // Cap in UTF-8 bytes; .length counts code units, which under-counts emoji
  // and other 4-byte sequences and would let an attacker drive past the cap.
  if (Buffer.byteLength(trimmed, "utf8") > MAX_EVIDENCE_BYTES) return false;
  if (CITATION_RE.test(trimmed)) return true;
  if (TEST_PATH_RE.test(trimmed)) return true;
  return false;
}

export type ExpectedGapMeta = {
  dimension: EvalFixEntryT["dimension"];
  severity: EvalFixEntryT["severity"];
};

export function validateFixesAgainstReview(
  fix: EvalFixFrontmatterT,
  expectedGaps: ReadonlyMap<string, ExpectedGapMeta>,
): { ok: true } | { ok: false; pointer: string; error: string } {
  const fixIds = new Set(fix.fixes.map((f) => f.gap_id));

  for (const expected of expectedGaps.keys()) {
    if (!fixIds.has(expected)) {
      return {
        ok: false,
        pointer: "/fixes",
        error: `Audit gap ${expected} is not addressed by any entry in fixes[]`,
      };
    }
  }
  for (let i = 0; i < fix.fixes.length; i++) {
    const entry = fix.fixes[i];
    const expected = expectedGaps.get(entry.gap_id);
    if (!expected) {
      return {
        ok: false,
        pointer: `/fixes/${i}/gap_id`,
        error: `Fix references gap_id ${entry.gap_id} which was not in the audit's gaps[]`,
      };
    }
    if (entry.dimension !== expected.dimension) {
      return {
        ok: false,
        pointer: `/fixes/${i}/dimension`,
        error: `Fix ${entry.gap_id} must keep dimension=${expected.dimension} (got ${entry.dimension})`,
      };
    }
    if (entry.severity !== expected.severity) {
      return {
        ok: false,
        pointer: `/fixes/${i}/severity`,
        error: `Fix ${entry.gap_id} must keep severity=${expected.severity} (got ${entry.severity})`,
      };
    }
  }
  if (fixIds.size !== fix.fixes.length) {
    return {
      ok: false,
      pointer: "/fixes",
      error: `fixes[] contains duplicate gap_id entries`,
    };
  }
  for (let i = 0; i < fix.fixes.length; i++) {
    const entry = fix.fixes[i];
    if (entry.action === "declined") continue;
    if (!isCitationEvidence(entry.evidence)) {
      return {
        ok: false,
        pointer: `/fixes/${i}/evidence`,
        error:
          `Fix ${entry.gap_id}: evidence "${entry.evidence}" is not a file:line citation or test-file reference. ` +
          `Either cite the runtime call site as <file>:<line>, point at a test (e.g. tests/foo.test.ts), ` +
          `or set action: declined with the reason in the evidence field.`,
      };
    }
  }
  return { ok: true };
}
