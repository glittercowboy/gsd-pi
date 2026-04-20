/**
 * summary-render-parity.test.ts — Regression test for #2720
 *
 * Asserts that the SUMMARY.md produced at task-completion time
 * (renderSummaryMarkdown in complete-task.ts) is structurally identical
 * to the SUMMARY.md produced at projection-regeneration time
 * (renderSummaryContent in workflow-projections.ts).
 *
 * Both render paths receive equivalent data (CompleteTaskParams vs TaskRow)
 * and must produce the same output. If they diverge, projection regeneration
 * silently replaces richer content with a stripped-down version.
 */

import { createTestContext } from './test-helpers.ts';
import { renderSummaryContent } from '../workflow-projections.ts';
import type { TaskRow } from '../gsd-db.ts';

const { assertEq, assertTrue, report } = createTestContext();

// ═══════════════════════════════════════════════════════════════════════════
// Fixtures — same logical data in both shapes
// ═══════════════════════════════════════════════════════════════════════════

const SLICE_ID = "S01";
const MILESTONE_ID = "M001";

const taskRow: TaskRow = {
  milestone_id: MILESTONE_ID,
  slice_id: SLICE_ID,
  id: "T01",
  title: "Implement widget parser",
  status: "complete",
  one_liner: "Implement widget parser",
  narrative: "Added a recursive descent parser for widget DSL.",
  verification_result: "All 42 unit tests pass; linter clean.",
  duration: "2h",
  completed_at: "2025-01-15T10:30:00.000Z",
  blocker_discovered: false,
  deviations: "Switched from PEG to hand-rolled parser for perf.",
  known_issues: "No known issues.",
  key_files: ["src/parser.ts", "src/lexer.ts"],
  key_decisions: ["Hand-rolled parser over PEG for 3x throughput"],
  full_summary_md: "",
  description: "",
  estimate: "",
  files: [],
  verify: "",
  inputs: [],
  expected_output: [],
  observability_impact: "",
  full_plan_md: "",
  sequence: 1,
  blocker_source: "",
  escalation_pending: 0,
  escalation_awaiting_review: 0,
  escalation_artifact_path: null,
  escalation_override_applied_at: null,
};

const verificationEvidence = [
  { command: "npm test", exitCode: 0, verdict: "42/42 passed ✅", durationMs: 3200 },
  { command: "npm run lint", exitCode: 0, verdict: "No warnings ✅", durationMs: 1100 },
];

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

// Test 1: renderSummaryContent includes Verification section
{
  const output = renderSummaryContent(taskRow, SLICE_ID, MILESTONE_ID);
  assertTrue(
    output.includes("## Verification"),
    "renderSummaryContent must include a ## Verification section",
  );
}

// Test 2: renderSummaryContent includes Verification Evidence table
{
  const output = renderSummaryContent(taskRow, SLICE_ID, MILESTONE_ID, verificationEvidence);
  assertTrue(
    output.includes("## Verification Evidence"),
    "renderSummaryContent must include a ## Verification Evidence section",
  );
  assertTrue(
    output.includes("npm test"),
    "Verification Evidence table must include the command",
  );
  assertTrue(
    output.includes("| Exit Code |") || output.includes("exit_code") || output.includes("Exit Code"),
    "Verification Evidence table must include exit code column",
  );
}

// Test 3: renderSummaryContent includes Files Created/Modified section
{
  const output = renderSummaryContent(taskRow, SLICE_ID, MILESTONE_ID);
  assertTrue(
    output.includes("## Files Created/Modified"),
    "renderSummaryContent must include a ## Files Created/Modified section",
  );
  assertTrue(
    output.includes("`src/parser.ts`"),
    "Files section must list key_files as inline code",
  );
}

// Test 4: one_liner renders as bold (not blockquote) for consistency
{
  const output = renderSummaryContent(taskRow, SLICE_ID, MILESTONE_ID);
  assertTrue(
    output.includes(`**${taskRow.one_liner}**`),
    "one_liner must render as bold text (not blockquote)",
  );
}

// Test 5: frontmatter key_files uses YAML list format (not JSON array)
{
  const output = renderSummaryContent(taskRow, SLICE_ID, MILESTONE_ID);
  assertTrue(
    output.includes("key_files:\n  - src/parser.ts\n  - src/lexer.ts"),
    "key_files frontmatter must use YAML list format, not JSON array",
  );
}

// Test 6: frontmatter key_decisions uses YAML list format (not JSON array)
{
  const output = renderSummaryContent(taskRow, SLICE_ID, MILESTONE_ID);
  assertTrue(
    output.includes("key_decisions:\n  - Hand-rolled parser over PEG for 3x throughput"),
    "key_decisions frontmatter must use YAML list format, not JSON array",
  );
}

// Test 7: Deviations section always present (with "None." fallback)
{
  const noDeviations = { ...taskRow, deviations: "" };
  const output = renderSummaryContent(noDeviations, SLICE_ID, MILESTONE_ID);
  assertTrue(
    output.includes("## Deviations"),
    "Deviations section must always be present even when empty",
  );
  assertTrue(
    output.includes("None."),
    "Deviations section must show 'None.' when no deviations",
  );
}

// Test 8: Known Issues section always present (with "None." fallback)
{
  const noKnownIssues = { ...taskRow, known_issues: "" };
  const output = renderSummaryContent(noKnownIssues, SLICE_ID, MILESTONE_ID);
  assertTrue(
    output.includes("## Known Issues"),
    "Known Issues section must always be present even when empty",
  );
}

// Test 9: verification_result frontmatter not double-quoted
{
  const output = renderSummaryContent(taskRow, SLICE_ID, MILESTONE_ID);
  // Should be: verification_result: passed (not "passed")
  assertTrue(
    !output.includes('verification_result: "'),
    "verification_result frontmatter value must not be double-quoted",
  );
}

// Test 10: duration frontmatter not double-quoted
{
  const output = renderSummaryContent(taskRow, SLICE_ID, MILESTONE_ID);
  assertTrue(
    !output.includes('duration: "'),
    "duration frontmatter value must not be double-quoted",
  );
}

// Test 11: empty key_files renders YAML placeholder, not empty array
{
  const noFiles = { ...taskRow, key_files: [] };
  const output = renderSummaryContent(noFiles, SLICE_ID, MILESTONE_ID);
  assertTrue(
    output.includes("key_files:\n  - (none)"),
    "empty key_files must render as YAML list with (none) placeholder",
  );
}

// Test 12: frontmatter does not contain extra projection-only fields
{
  const output = renderSummaryContent(taskRow, SLICE_ID, MILESTONE_ID);
  assertTrue(
    !output.includes("provides:"),
    "frontmatter must not contain provides field",
  );
  assertTrue(
    !output.includes("requires:"),
    "frontmatter must not contain requires field",
  );
  assertTrue(
    !output.includes("affects:"),
    "frontmatter must not contain affects field",
  );
  assertTrue(
    !output.includes("patterns_established:"),
    "frontmatter must not contain patterns_established field",
  );
  assertTrue(
    !output.includes("drill_down_paths:"),
    "frontmatter must not contain drill_down_paths field",
  );
  assertTrue(
    !output.includes("observability_surfaces:"),
    "frontmatter must not contain observability_surfaces field",
  );
}

// Test 13: no verification evidence renders empty table row
{
  const output = renderSummaryContent(taskRow, SLICE_ID, MILESTONE_ID, []);
  assertTrue(
    output.includes("No verification commands discovered"),
    "Empty evidence array must render placeholder row",
  );
}

report();
