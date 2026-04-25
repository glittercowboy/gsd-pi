// GSD-2 — Milestone scope classifier (#4781 / ADR-003 companion).
//
// Pure heuristics over milestone planning fields. Produces a PipelineVariant
// that downstream dispatch logic can use to shape the auto-mode sequence.
// No LLM calls, no file I/O, sub-millisecond.
//
// Distinct from `complexity-classifier.ts`, which decides *model tier*
// (light/standard/heavy) for an individual unit. This module decides
// *pipeline topology* for an entire milestone at plan-milestone time.
//
// This file ships the classifier in isolation. Dispatch-side wiring
// lands in follow-up PRs so the classification contract can be reviewed
// and tested before any behavior change reaches users.

export type PipelineVariant = "trivial" | "standard" | "complex";

export interface MilestoneScopeInput {
  /** Milestone vision / elevator pitch. Free-form prose. */
  vision?: string;
  /** Success criteria, one per array entry. */
  successCriteria?: string[];
  /** Milestone title. */
  title?: string;
  /** Slice risks declared at plan-milestone time. */
  keyRisks?: Array<{ risk?: string; whyItMatters?: string }>;
  /** Definition-of-done lines. */
  definitionOfDone?: string[];
  /** Freeform "requirement coverage" marker. */
  requirementCoverage?: string;
  /** Verification hints (contract/integration/operational/uat). */
  verificationContract?: string;
  verificationIntegration?: string;
  verificationOperational?: string;
  verificationUat?: string;
}

export interface ScopeClassificationResult {
  variant: PipelineVariant;
  /** Short human-readable reasons, one per triggered signal. */
  reasons: string[];
  /** Sub-signals for telemetry / debugging. Stable across releases. */
  signals: {
    triggeredOverride: boolean;
    complexCount: number;
    trivialCount: number;
    fileCountHint: number | null;
  };
}

// ─── Keyword sets ─────────────────────────────────────────────────────────

/**
 * Override keywords that force `standard` (at minimum) regardless of
 * apparent triviality. Presence of any of these signals work that is
 * either security-sensitive, irreversible, or requires runtime verification
 * a "trivial" pipeline would skip.
 *
 * Matched as case-insensitive word-boundary substrings. Conservative — err
 * on the side of including a keyword; over-classifying to `standard` costs
 * units, under-classifying could ship broken auth/security/migration work.
 */
const OVERRIDE_KEYWORDS: ReadonlyArray<string> = [
  // Security-sensitive
  "security", "auth", "authn", "authz", "authentication", "authorization",
  "credential", "secret", "password", "token", "oauth", "encrypt", "decrypt",
  "vulnerability", "exploit", "permission", "rbac", "acl",
  // Data-migration / irreversible
  "migration", "migrate", "schema change", "data migration",
  "backfill", "drop column", "drop table",
  // Compliance / regulatory
  "compliance", "gdpr", "hipaa", "soc2", "pci",
  // Infra / deploy — runtime verification needed
  "deploy", "rollout", "canary", "production database",
];

/**
 * Keywords that contribute to `complex` classification on their own.
 * Different from OVERRIDE_KEYWORDS in that a single match bumps to
 * complex, not just to standard.
 */
const COMPLEX_KEYWORDS: ReadonlyArray<string> = [
  "multi-service", "distributed", "consensus", "saga", "eventual consistency",
  "breaking change", "api contract change", "schema redesign",
  "architect", "architecture", "refactor core",
];

/**
 * Trivial-signal keywords: presence strongly suggests a simple, contained
 * deliverable. Only effective when combined with low file count / no tests
 * / no override keywords.
 */
const TRIVIAL_KEYWORDS: ReadonlyArray<string> = [
  "single file", "one file", "static html", "static page",
  "one-page", "landing page", "readme", "docs only", "typo", "rename",
  "spelling", "comment", "changelog",
  // Browser-only / no-build deliverable shapes (b23 forensic case).
  "pure html", "browser-based", "no build step", "no build tooling",
  "localstorage", "client-only", "no backend", "no server", "no backend.",
];

// ─── Heuristics ───────────────────────────────────────────────────────────

/**
 * Estimate how many distinct files the milestone will touch, based on
 * explicit mentions in the input text. Returns `null` when no hint is
 * discoverable — callers should treat that as "unknown, no signal."
 */
function extractFileCountHint(text: string): number | null {
  // Explicit phrasing: "a single file", "two files", "3 files"
  const singleFileMatch = /\b(a|one|single)\s+(file|page)\b/i.test(text);
  if (singleFileMatch) return 1;

  const digitMatch = text.match(/\b(\d+)\s+files?\b/i);
  if (digitMatch) {
    const n = parseInt(digitMatch[1], 10);
    if (!Number.isNaN(n)) return n;
  }

  const wordMatch = text.match(/\b(two|three|four|five|six|seven|eight|nine|ten)\s+files?\b/i);
  if (wordMatch) {
    const wordMap: Record<string, number> = {
      two: 2, three: 3, four: 4, five: 5,
      six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    };
    return wordMap[wordMatch[1].toLowerCase()] ?? null;
  }

  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsAnyKeyword(haystack: string, keywords: ReadonlyArray<string>): string[] {
  const lower = haystack.toLowerCase();
  const hits: string[] = [];
  for (const kw of keywords) {
    // Word-boundary match to prevent substring collisions (e.g. "auth"
    // must not match "author", "api" must not match "capital"). Phrases
    // containing non-word characters (hyphens, slashes) still work because
    // `\b` sits at the word-char / non-word-char transition, so
    // `\bbrowser-based\b` matches "browser-based" bounded by whitespace
    // or punctuation on either side.
    const pattern = new RegExp(String.raw`\b${escapeRegExp(kw)}\b`, "i");
    if (pattern.test(lower)) hits.push(kw);
  }
  return hits;
}

/**
 * True when `term` appears in the text without an immediately preceding
 * negator (no / without / not / zero / skip) in the same clause. Used to
 * keep phrases like "no backend" or "no tests" from flipping a trivial-
 * class milestone to standard. Best-effort; imperfect English parsing,
 * biased toward false negatives (if unsure, treats term as present —
 * which routes to standard, the safe pipeline).
 */
function mentionsWithoutNegation(text: string, term: string): boolean {
  const lower = text.toLowerCase();
  const termPattern = new RegExp(String.raw`\b${term}\b`, "gi");
  const matches = Array.from(lower.matchAll(termPattern));
  for (const m of matches) {
    const start = m.index ?? 0;
    const windowStart = Math.max(0, start - 30);
    const window = lower.slice(windowStart, start);
    // Negator anywhere in the 30-char lookback window counts as negation —
    // covers "no backend", "without a server", "not using api", "zero
    // dependencies on an api". If a sentence break intervenes between the
    // negator and the term, treat as a different clause (positive mention).
    const hasNegator = /(^|[^a-z0-9])(no|without|not|zero|skip(s|ping)?|drops?)\b/i.test(window);
    const hasSentenceBreak = /[.;!?]/.test(window);
    if (hasNegator && !hasSentenceBreak) continue;
    return true;
  }
  return false;
}

function mentionsTests(haystack: string): boolean {
  return mentionsWithoutNegation(haystack, "test")
      || mentionsWithoutNegation(haystack, "tests")
      || mentionsWithoutNegation(haystack, "testing")
      || mentionsWithoutNegation(haystack, "spec")
      || mentionsWithoutNegation(haystack, "unit test")
      || mentionsWithoutNegation(haystack, "integration test");
}

function mentionsBackend(haystack: string): boolean {
  return mentionsWithoutNegation(haystack, "api")
      || mentionsWithoutNegation(haystack, "backend")
      || mentionsWithoutNegation(haystack, "server")
      || mentionsWithoutNegation(haystack, "database")
      || mentionsWithoutNegation(haystack, "endpoint");
}

// ─── DB adapter ───────────────────────────────────────────────────────────

/**
 * Shape adapter: convert a milestone DB row into the classifier input
 * object. Keeps `milestone-scope-classifier.ts` free of DB types at the
 * module boundary — callers can either use this helper or hand-build the
 * input themselves (e.g. from plan-milestone tool params before insert).
 */
export function milestoneRowToScopeInput(row: {
  title?: string;
  vision?: string;
  success_criteria?: string[];
  key_risks?: Array<{ risk?: string; whyItMatters?: string }>;
  definition_of_done?: string[];
  requirement_coverage?: string;
  verification_contract?: string;
  verification_integration?: string;
  verification_operational?: string;
  verification_uat?: string;
}): MilestoneScopeInput {
  return {
    title: row.title,
    vision: row.vision,
    successCriteria: row.success_criteria,
    keyRisks: row.key_risks,
    definitionOfDone: row.definition_of_done,
    requirementCoverage: row.requirement_coverage,
    verificationContract: row.verification_contract,
    verificationIntegration: row.verification_integration,
    verificationOperational: row.verification_operational,
    verificationUat: row.verification_uat,
  };
}

/**
 * Compute the pipeline variant for a milestone by reading its planning
 * fields from the DB and running the classifier. Returns `null` when
 * classification is unavailable (DB closed, milestone missing, unexpected
 * error) — callers MUST treat null as "run the full pipeline" so a
 * classification failure never silently downshifts dispatch.
 */
export async function getMilestonePipelineVariant(mid: string): Promise<PipelineVariant | null> {
  try {
    const { isDbAvailable, getMilestone } = await import("./gsd-db.js");
    if (!isDbAvailable()) return null;
    const row = getMilestone(mid);
    if (!row) return null;
    return classifyMilestoneScope(milestoneRowToScopeInput(row)).variant;
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Classify a milestone's pipeline variant based on its planning inputs.
 *
 * Precedence (matches implementation order — complex-first so that
 * security-sensitive architecture refactors correctly route to complex
 * rather than standard; the override hit is still recorded in
 * `signals.triggeredOverride` for telemetry):
 *  1. Complex-signal keyword OR ≥ 8 file hint OR architecture/refactor-core
 *     language → `complex`.
 *  2. Override keyword → `standard` (at minimum). Prevents trivial
 *     misclassification of security / auth / migration work.
 *  3. Trivial-signal keyword AND ≤ 2 file hint AND no tests mentioned AND
 *     no backend mentioned → `trivial`.
 *  4. Otherwise → `standard`.
 *
 * Ambiguity → `standard` (today's default). Safe to run the full pipeline.
 */
export function classifyMilestoneScope(input: MilestoneScopeInput): ScopeClassificationResult {
  const haystack = [
    input.title ?? "",
    input.vision ?? "",
    (input.successCriteria ?? []).join("\n"),
    (input.keyRisks ?? []).map(r => `${r.risk ?? ""} ${r.whyItMatters ?? ""}`).join("\n"),
    (input.definitionOfDone ?? []).join("\n"),
    input.requirementCoverage ?? "",
    input.verificationContract ?? "",
    input.verificationIntegration ?? "",
    input.verificationOperational ?? "",
    input.verificationUat ?? "",
  ].join("\n");

  const overrideHits = containsAnyKeyword(haystack, OVERRIDE_KEYWORDS);
  const complexHits = containsAnyKeyword(haystack, COMPLEX_KEYWORDS);
  const trivialHits = containsAnyKeyword(haystack, TRIVIAL_KEYWORDS);
  const fileCountHint = extractFileCountHint(haystack);
  const hasTests = mentionsTests(haystack);
  const hasBackend = mentionsBackend(haystack);

  const reasons: string[] = [];

  // Rule 2: complex-class signals. Evaluated before override because a
  // complex + override input should land in complex, not standard.
  if (complexHits.length > 0) {
    reasons.push(`complex keywords: ${complexHits.slice(0, 3).join(", ")}`);
  }
  if (fileCountHint !== null && fileCountHint >= 8) {
    reasons.push(`file count hint: ${fileCountHint}`);
  }

  const isComplex = complexHits.length > 0 || (fileCountHint !== null && fileCountHint >= 8);

  if (isComplex) {
    return {
      variant: "complex",
      reasons,
      signals: {
        triggeredOverride: overrideHits.length > 0,
        complexCount: complexHits.length,
        trivialCount: trivialHits.length,
        fileCountHint,
      },
    };
  }

  // Rule 1: override keywords force standard.
  if (overrideHits.length > 0) {
    return {
      variant: "standard",
      reasons: [`override keywords: ${overrideHits.slice(0, 3).join(", ")}`],
      signals: {
        triggeredOverride: true,
        complexCount: complexHits.length,
        trivialCount: trivialHits.length,
        fileCountHint,
      },
    };
  }

  // Rule 3: trivial signals — require ALL of: trivial-keyword, low file
  // hint (or nothing suggesting high count), no test mention, no backend
  // mention.
  const fileCountOk = fileCountHint === null || fileCountHint <= 2;
  const trivial =
    trivialHits.length > 0 &&
    fileCountOk &&
    !hasTests &&
    !hasBackend;

  if (trivial) {
    reasons.push(`trivial keywords: ${trivialHits.slice(0, 3).join(", ")}`);
    if (fileCountHint !== null) reasons.push(`file count hint: ${fileCountHint}`);
    reasons.push("no tests mentioned", "no backend mentioned");
    return {
      variant: "trivial",
      reasons,
      signals: {
        triggeredOverride: false,
        complexCount: complexHits.length,
        trivialCount: trivialHits.length,
        fileCountHint,
      },
    };
  }

  // Rule 4: fallback.
  return {
    variant: "standard",
    reasons: reasons.length > 0 ? reasons : ["no strong signals — default"],
    signals: {
      triggeredOverride: overrideHits.length > 0,
      complexCount: complexHits.length,
      trivialCount: trivialHits.length,
      fileCountHint,
    },
  };
}
