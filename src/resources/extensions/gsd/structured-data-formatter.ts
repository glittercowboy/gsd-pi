/**
 * Structured Data Formatter — compact notation for prompt injection.
 *
 * Converts GSD data structures into a token-efficient format that removes
 * markdown table overhead, redundant labels, and formatting while remaining
 * perfectly readable by LLMs.
 *
 * Format rules:
 * - No table pipes, dashes, or header rows
 * - Use indentation (2 spaces) for structure instead of delimiters
 * - Omit field names when the pattern is clear from a header
 * - Use single-line entries for simple records
 * - Use multi-line with indentation for complex records
 */

// ---------------------------------------------------------------------------
// Types (inline — no imports from other GSD modules)
// ---------------------------------------------------------------------------

interface DecisionInput {
  id: string;
  when_context: string;
  scope: string;
  decision: string;
  choice: string;
  rationale: string;
  revisable: string;
}

interface RequirementInput {
  id: string;
  class: string;
  status: string;
  description: string;
  why: string;
  primary_owner: string;
  validation: string;
}

interface TaskPlanInput {
  id: string;
  title: string;
  description: string;
  done: boolean;
  estimate: string;
  files?: string[];
  verify?: string;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** Compact format for a single decision record (pipe-separated, no padding). */
export function formatDecisionCompact(decision: DecisionInput): string {
  return [
    decision.id,
    decision.when_context,
    decision.scope,
    decision.decision,
    decision.choice,
    decision.rationale,
    decision.revisable,
  ].join(" | ");
}

/** Format multiple decisions in compact notation with a Fields header. */
export function formatDecisionsCompact(decisions: DecisionInput[]): string {
  if (decisions.length === 0) {
    return "# Decisions (compact)\n(none)";
  }

  const header = "# Decisions (compact)\nFields: id | when | scope | decision | choice | rationale | revisable";
  const lines = decisions.map(formatDecisionCompact);
  return `${header}\n\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

/** Compact format for a single requirement record (multi-line). */
export function formatRequirementCompact(req: RequirementInput): string {
  const lines: string[] = [];
  lines.push(`${req.id} [${req.class}] (${req.status}) owner:${req.primary_owner}`);
  lines.push(`  ${req.description}`);
  lines.push(`  why: ${req.why}`);
  lines.push(`  validate: ${req.validation}`);
  return lines.join("\n");
}

/** Format multiple requirements in compact notation. */
export function formatRequirementsCompact(requirements: RequirementInput[]): string {
  if (requirements.length === 0) {
    return "# Requirements (compact)\n(none)";
  }

  const header = "# Requirements (compact)";
  const blocks = requirements.map(formatRequirementCompact);
  return `${header}\n\n${blocks.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Task Plans
// ---------------------------------------------------------------------------

/** Compact format for task plan entries. */
export function formatTaskPlanCompact(tasks: TaskPlanInput[]): string {
  if (tasks.length === 0) {
    return "# Tasks (compact)\n(none)";
  }

  const header = "# Tasks (compact)";
  const blocks = tasks.map((t) => {
    const check = t.done ? "x" : " ";
    const lines: string[] = [];
    lines.push(`${t.id} [${check}] ${t.title} (${t.estimate})`);
    if (t.files && t.files.length > 0) {
      lines.push(`  files: ${t.files.join(", ")}`);
    }
    if (t.verify) {
      lines.push(`  verify: ${t.verify}`);
    }
    lines.push(`  ${t.description}`);
    return lines.join("\n");
  });

  return `${header}\n\n${blocks.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Savings measurement
// ---------------------------------------------------------------------------

/**
 * Measure the token savings of compact format vs markdown format.
 * Returns savings as a percentage (0-100).
 * A positive number means compact is smaller (saves tokens).
 */
export function measureSavings(compactContent: string, markdownContent: string): number {
  if (markdownContent.length === 0) return 0;
  const saved = markdownContent.length - compactContent.length;
  return (saved / markdownContent.length) * 100;
}
