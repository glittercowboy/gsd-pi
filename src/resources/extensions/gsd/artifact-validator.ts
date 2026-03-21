// Artifact content validators for GSD pipeline gates.
// Each validator checks structural contracts on a specific artifact type.
// Returns { valid, errors } — errors describe exactly what's missing,
// enabling targeted retry prompts rather than opaque rejection.
//
// All functions are synchronous — called from sync verifyExpectedArtifact().

import { extractSection } from './files.js';
import { splitFrontmatter, parseFrontmatterMap } from '../shared/frontmatter.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const PLACEHOLDER_RE = /^\{\{.*\}\}$/;

/** Check if a frontmatter array has at least one non-placeholder item. */
function hasNonPlaceholderItems(items: unknown): boolean {
  if (!Array.isArray(items) || items.length === 0) return false;
  return items.some(item => typeof item === 'string' && item.trim().length > 0 && !PLACEHOLDER_RE.test(item.trim()));
}

/** Check if a frontmatter value is a non-empty scalar string.
 *  parseFrontmatterMap returns [] for `key:` (empty value) and a string for `key: value`. */
function isNonEmptyScalar(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return false; // empty value parses as []
  if (typeof value === 'string') return value.trim().length > 0;
  return true; // numbers, booleans — treat as non-empty
}

/** Parse frontmatter from content, returning the map and any structural error. */
function parseFM(content: string): { fm: Record<string, unknown> | null; body: string; error: string | null } {
  const [fmLines, body] = splitFrontmatter(content);
  if (!fmLines) return { fm: null, body, error: 'No frontmatter found' };
  return { fm: parseFrontmatterMap(fmLines), body, error: null };
}

// ─── Validators ────────────────────────────────────────────────────────────

/**
 * Validate a task summary artifact.
 * Checks: frontmatter exists, verification_result present and non-empty,
 * provides array has non-placeholder items, key_files has non-placeholder items.
 */
export function validateTaskSummary(content: string): ValidationResult {
  const errors: string[] = [];
  const { fm, error } = parseFM(content);

  if (error || !fm) {
    errors.push(error || 'No frontmatter found');
    return { valid: false, errors };
  }

  // verification_result must exist and be non-empty
  const vr = fm['verification_result'];
  if (!isNonEmptyScalar(vr)) {
    errors.push("Missing or empty 'verification_result' in frontmatter");
  }

  // provides must have at least one non-placeholder item
  if (!hasNonPlaceholderItems(fm['provides'])) {
    errors.push("'provides' must have at least one non-placeholder item");
  }

  // key_files must have at least one non-placeholder item
  if (!hasNonPlaceholderItems(fm['key_files'])) {
    errors.push("'key_files' must have at least one non-placeholder item");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a slice plan artifact.
 * Checks: at least one task entry, Must-Haves section exists and is non-empty/non-placeholder.
 * If YAML frontmatter is present with `requirements:`, it must contain at least one non-placeholder item.
 * Plans without frontmatter pass (backward compat — D005, K004).
 */
export function validateSlicePlan(content: string): ValidationResult {
  const errors: string[] = [];

  // At least one task entry matching the checkbox format
  const taskEntryRe = /^- \[[xX ]\] \*\*T\d+:/m;
  if (!taskEntryRe.test(content)) {
    errors.push('No task entries found (expected "- [ ] **T##:" pattern)');
  }

  // Must-Haves section must exist and have real content
  const [fmLines, body] = splitFrontmatter(content);
  const mustHaves = extractSection(body, 'Must-Haves');
  if (!mustHaves || mustHaves.trim().length === 0) {
    errors.push("'Must-Haves' section is missing or empty");
  } else {
    // Check if section is placeholder-only
    const lines = mustHaves.split('\n')
      .map(l => l.replace(/^\s*[-*]\s+/, '').trim())
      .filter(l => l.length > 0 && !l.startsWith('#'));
    const allPlaceholder = lines.length === 0 || lines.every(l => PLACEHOLDER_RE.test(l));
    if (allPlaceholder) {
      errors.push("'Must-Haves' section contains only placeholders");
    }
  }

  // requirements: frontmatter gate — only enforced when frontmatter is present
  if (fmLines) {
    const fm = parseFrontmatterMap(fmLines);
    if ('requirements' in fm) {
      if (!hasNonPlaceholderItems(fm['requirements'])) {
        errors.push("'requirements' frontmatter is present but empty or contains only placeholders");
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a UAT result artifact.
 * Checks: verdict in frontmatter is present and non-empty,
 * at least one table data row in Checks section.
 */
export function validateUatResult(content: string): ValidationResult {
  const errors: string[] = [];
  const { fm, body, error } = parseFM(content);

  if (error || !fm) {
    errors.push(error || 'No frontmatter found');
    return { valid: false, errors };
  }

  // verdict must be present and non-empty (FAIL and PARTIAL are valid)
  const verdict = fm['verdict'];
  if (!isNonEmptyScalar(verdict)) {
    errors.push("Missing or empty 'verdict' in frontmatter");
  }

  // Checks section must have at least one table data row
  const checksSection = extractSection(body, 'Checks');
  if (!checksSection) {
    errors.push("'Checks' section is missing");
  } else {
    // Find pipe-delimited rows, excluding header and separator rows
    const tableRows = checksSection.split('\n').filter(line => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('|')) return false;
      // Exclude separator rows (|---|---|...)
      if (/^\|[\s-|]+\|$/.test(trimmed)) return false;
      return true;
    });
    // Need at least 2 rows: header + 1 data row
    if (tableRows.length < 2) {
      errors.push("'Checks' section has no data rows in the table");
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a reassessment artifact.
 * Checks: content has meaningful lines beyond YAML frontmatter
 * (at least 3 non-empty, non-comment, non-placeholder lines in body).
 */
export function validateReassessment(content: string): ValidationResult {
  const errors: string[] = [];
  const [, body] = splitFrontmatter(content);

  // Count meaningful lines in the body
  const meaningfulLines = body.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .filter(l => !l.startsWith('<!--'))
    .filter(l => !l.endsWith('-->'))
    .filter(l => !PLACEHOLDER_RE.test(l))
    .filter(l => !l.startsWith('#')); // headings alone aren't meaningful content

  if (meaningfulLines.length < 3) {
    errors.push(`Body has only ${meaningfulLines.length} meaningful lines (need at least 3)`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a milestone summary artifact.
 * Checks: verification_result present and non-empty, provides has non-placeholder items.
 */
export function validateMilestoneSummary(content: string): ValidationResult {
  const errors: string[] = [];
  const { fm, error } = parseFM(content);

  if (error || !fm) {
    errors.push(error || 'No frontmatter found');
    return { valid: false, errors };
  }

  // verification_result must exist and be non-empty
  const vr = fm['verification_result'];
  if (!isNonEmptyScalar(vr)) {
    errors.push("Missing or empty 'verification_result' in frontmatter");
  }

  // provides must have at least one non-placeholder item
  if (!hasNonPlaceholderItems(fm['provides'])) {
    errors.push("'provides' must have at least one non-placeholder item");
  }

  return { valid: errors.length === 0, errors };
}
