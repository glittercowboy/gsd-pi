/**
 * GSD Prompt Validation — Validates enhanced context and turn output
 * artifacts before writing.
 *
 * Implements R109 validation requirement: CONTEXT.md must have required
 * sections before being written to disk. Additionally, per-turn validators
 * check that artifacts produced by gate-owning turns contain the gate
 * sections declared in gate-registry.ts, so a malformed summary/validation
 * markdown file cannot silently drop a quality gate.
 */

import { getGatesForTurn, type OwnerTurn } from "./gate-registry.js";

/**
 * Result of validating enhanced context output.
 */
export interface ValidationResult {
  /** Whether all required sections are present. */
  valid: boolean;
  /** List of missing required sections. */
  missing: string[];
}

/**
 * Validate that enhanced context content has all required sections.
 *
 * Required sections per R109:
 * - Scope section (## Scope, ## Milestone Scope, or ## Why This Milestone)
 * - Architectural Decisions section (## Architectural Decisions)
 * - Acceptance Criteria section (## Acceptance Criteria or ## Final Integrated Acceptance)
 *
 * Additionally validates that the Architectural Decisions section contains
 * at least one decision entry (### heading or **Decision marker).
 *
 * @param content - The enhanced context markdown content
 * @returns ValidationResult with valid flag and list of missing sections
 */
export function validateEnhancedContext(content: string): ValidationResult {
  const missing: string[] = [];

  // Required section 1: Scope (multiple acceptable header variants)
  const hasScopeSection =
    /^## Scope\b/m.test(content) ||
    /^## Milestone Scope\b/m.test(content) ||
    /^## Why This Milestone\b/m.test(content);

  if (!hasScopeSection) {
    missing.push("Milestone Scope or Why This Milestone");
  }

  // Required section 2: Architectural Decisions
  const hasArchitecturalDecisions = /^## Architectural Decisions\b/m.test(content);
  if (!hasArchitecturalDecisions) {
    missing.push("Architectural Decisions");
  }

  // Required section 3: Acceptance Criteria (multiple acceptable header variants)
  const hasAcceptanceCriteria =
    /^## Acceptance Criteria\b/m.test(content) ||
    /^## Final Integrated Acceptance\b/m.test(content);

  if (!hasAcceptanceCriteria) {
    missing.push("Acceptance Criteria");
  }

  // Additional validation: Architectural Decisions must have at least one entry
  if (hasArchitecturalDecisions) {
    // Extract the section content between ## Architectural Decisions and the next ## heading.
    // Uses indexOf-based extraction instead of regex with \z (which is invalid in JavaScript
    // regex — it's PCRE/Ruby syntax and JS treats it as literal 'z').
    const sectionStart = content.indexOf("## Architectural Decisions");
    if (sectionStart === -1) {
      missing.push("Architectural Decisions");
    } else {
      const afterHeading = content.slice(sectionStart + "## Architectural Decisions".length);
      const nextSection = afterHeading.search(/^## /m);
      const sectionContent = nextSection === -1 ? afterHeading : afterHeading.slice(0, nextSection);

      // Check for actual decision entries:
      // - ### heading (subsection per decision)
      // - **Decision marker (inline decision format)
      const hasDecisionEntry = /^### /m.test(sectionContent) || /^\*\*Decision/m.test(sectionContent);

      if (!hasDecisionEntry) {
        missing.push("At least one architectural decision entry");
      }
    }
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}

// ─── Per-Turn Gate Section Validators ─────────────────────────────────────
//
// Each validator checks that the artifact written by a turn contains a
// heading for every gate owned by that turn. The registry is the source
// of truth for which sections must exist; adding a new gate automatically
// flows through via `getGatesForTurn(turn)`.

/**
 * Escape a string so it can be embedded safely inside a regular expression.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Validate that an artifact contains an `## H2` heading for every gate the
 * named turn owns. Returns the list of missing gate section headers.
 *
 * Soft rule: a section counts as "present" if it is declared (H2 heading
 * exists) — empty-body sections are allowed and handled by the tool
 * handler, which will record such gates as `omitted`.
 */
export function validateGateSections(
  content: string,
  turn: OwnerTurn,
): ValidationResult {
  const missing: string[] = [];
  for (const def of getGatesForTurn(turn)) {
    const pattern = new RegExp(`^##\\s+${escapeRegExp(def.promptSection)}\\b`, "m");
    if (!pattern.test(content)) {
      missing.push(`${def.id} (## ${def.promptSection})`);
    }
  }
  return { valid: missing.length === 0, missing };
}

/**
 * Validate a SUMMARY.md produced by the complete-slice turn. Requires
 * an H2 heading for every gate owned by complete-slice (e.g. Q8 →
 * "## Operational Readiness"). Intended for use in the tool handler's
 * pre-write checks or in the post-unit validation sweep.
 */
export function validateSliceSummaryOutput(content: string): ValidationResult {
  return validateGateSections(content, "complete-slice");
}

/**
 * Validate a task SUMMARY.md produced by the execute-task turn. Only
 * flags gates that are still pending for the task; skips the check
 * when no rows are seeded (simple task).
 */
export function validateTaskSummaryOutput(content: string): ValidationResult {
  return validateGateSections(content, "execute-task");
}

/**
 * Validate a VALIDATION.md produced by the validate-milestone turn.
 * Requires an H2 heading for every MV gate declared in the registry.
 */
export function validateMilestoneValidationOutput(content: string): ValidationResult {
  return validateGateSections(content, "validate-milestone");
}
