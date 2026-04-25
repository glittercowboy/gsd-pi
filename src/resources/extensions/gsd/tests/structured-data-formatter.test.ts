/**
 * Unit tests for structured-data-formatter.ts — compact notation for prompt injection.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  formatDecisionCompact,
  formatDecisionsCompact,
  formatRequirementCompact,
  formatRequirementsCompact,
  formatTaskPlanCompact,
  measureSavings,
} from "../structured-data-formatter.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleDecision = {
  id: "D001",
  when_context: "M001/S01",
  scope: "architecture",
  decision: "Use SQLite for storage",
  choice: "WAL mode, single-writer",
  rationale: "Built-in, no external deps",
  revisable: "yes",
};

const sampleDecision2 = {
  id: "D002",
  when_context: "M001/S02",
  scope: "testing",
  decision: "Unit test all parsers",
  choice: "node:test framework",
  rationale: "Fast, zero-dependency",
  revisable: "no",
};

const sampleRequirement = {
  id: "R001",
  class: "functional",
  status: "active",
  description: "Response latency < 200ms for API endpoints",
  why: "Critical for user experience",
  primary_owner: "S01",
  validation: "Load test confirms P99 < 200ms",
};

const sampleRequirement2 = {
  id: "R002",
  class: "non-functional",
  status: "active",
  description: "Data consistency across writes",
  why: "Prevents data loss",
  primary_owner: "S02",
  validation: "Integration test suite",
};

const sampleTaskDone = {
  id: "T01",
  title: "Database schema",
  description: "Create tables for decisions and requirements",
  done: true,
  estimate: "30m",
  files: ["src/db.ts", "src/schema.ts"],
};

const sampleTaskPending = {
  id: "T02",
  title: "API endpoints",
  description: "REST endpoints for CRUD operations",
  done: false,
  estimate: "1h",
  files: ["src/api.ts"],
  verify: "npm test",
};

// ---------------------------------------------------------------------------
// formatDecisionCompact
// ---------------------------------------------------------------------------

describe("structured-data-formatter: formatDecisionCompact", () => {
  it("produces pipe-separated single-line output", () => {
    const result = formatDecisionCompact(sampleDecision);
    assert.equal(
      result,
      "D001 | M001/S01 | architecture | Use SQLite for storage | WAL mode, single-writer | Built-in, no external deps | yes | agent",
    );
  });

  it("includes all fields in the correct order", () => {
    const result = formatDecisionCompact(sampleDecision);
    const parts = result.split(" | ");
    assert.equal(parts.length, 8);
    assert.equal(parts[0], "D001");
    assert.equal(parts[6], "yes");
    assert.equal(parts[7], "agent");
  });
});

// ---------------------------------------------------------------------------
// formatDecisionsCompact
// ---------------------------------------------------------------------------

describe("structured-data-formatter: formatDecisionsCompact", () => {
  it("includes Fields header line", () => {
    const result = formatDecisionsCompact([sampleDecision]);
    assert.ok(result.startsWith("# Decisions (compact)"));
    assert.ok(result.includes("Fields: id | when | scope | decision | choice | rationale | revisable | made_by"));
  });

  it("formats multiple decisions on separate lines", () => {
    const result = formatDecisionsCompact([sampleDecision, sampleDecision2]);
    const lines = result.split("\n");
    // header, fields, blank, D001, D002
    assert.equal(lines.length, 5);
    assert.ok(lines[3].startsWith("D001"));
    assert.ok(lines[4].startsWith("D002"));
  });

  it("returns (none) for empty array", () => {
    const result = formatDecisionsCompact([]);
    assert.ok(result.includes("(none)"));
  });

  it("formats single-item array with header", () => {
    const result = formatDecisionsCompact([sampleDecision]);
    assert.ok(result.includes("# Decisions (compact)"));
    assert.ok(result.includes("D001"));
    // Only one data line after the blank separator
    const dataLines = result.split("\n\n")[1].split("\n");
    assert.equal(dataLines.length, 1);
  });
});

// ---------------------------------------------------------------------------
// formatRequirementCompact
// ---------------------------------------------------------------------------

describe("structured-data-formatter: formatRequirementCompact", () => {
  it("produces multi-line compact format", () => {
    const result = formatRequirementCompact(sampleRequirement);
    const lines = result.split("\n");
    assert.equal(lines.length, 4);
  });

  it("first line has id, class, status, owner", () => {
    const result = formatRequirementCompact(sampleRequirement);
    const first = result.split("\n")[0];
    assert.equal(first, "R001 [functional] (active) owner:S01");
  });

  it("description is indented on second line", () => {
    const result = formatRequirementCompact(sampleRequirement);
    const second = result.split("\n")[1];
    assert.equal(second, "  Response latency < 200ms for API endpoints");
  });

  it("includes why and validate lines", () => {
    const result = formatRequirementCompact(sampleRequirement);
    assert.ok(result.includes("  why: Critical for user experience"));
    assert.ok(result.includes("  validate: Load test confirms P99 < 200ms"));
  });
});

// ---------------------------------------------------------------------------
// formatRequirementsCompact
// ---------------------------------------------------------------------------

describe("structured-data-formatter: formatRequirementsCompact", () => {
  it("includes header", () => {
    const result = formatRequirementsCompact([sampleRequirement]);
    assert.ok(result.startsWith("# Requirements (compact)"));
  });

  it("separates multiple requirements with blank lines", () => {
    const result = formatRequirementsCompact([sampleRequirement, sampleRequirement2]);
    const blocks = result.split("\n\n");
    // header block, R001 block, R002 block
    assert.equal(blocks.length, 3);
  });

  it("returns (none) for empty array", () => {
    const result = formatRequirementsCompact([]);
    assert.ok(result.includes("(none)"));
  });

  it("formats single-item array", () => {
    const result = formatRequirementsCompact([sampleRequirement]);
    assert.ok(result.includes("R001"));
    assert.ok(!result.includes("R002"));
  });
});

// ---------------------------------------------------------------------------
// formatTaskPlanCompact
// ---------------------------------------------------------------------------

describe("structured-data-formatter: formatTaskPlanCompact", () => {
  it("uses [x] for done tasks and [ ] for pending", () => {
    const result = formatTaskPlanCompact([sampleTaskDone, sampleTaskPending]);
    assert.ok(result.includes("T01 [x] Database schema (30m)"));
    assert.ok(result.includes("T02 [ ] API endpoints (1h)"));
  });

  it("includes files list when present", () => {
    const result = formatTaskPlanCompact([sampleTaskDone]);
    assert.ok(result.includes("  files: src/db.ts, src/schema.ts"));
  });

  it("includes verify when present", () => {
    const result = formatTaskPlanCompact([sampleTaskPending]);
    assert.ok(result.includes("  verify: npm test"));
  });

  it("omits files line when not provided", () => {
    const noFiles = { ...sampleTaskDone, files: undefined };
    const result = formatTaskPlanCompact([noFiles]);
    assert.ok(!result.includes("files:"));
  });

  it("omits verify line when not provided", () => {
    const noVerify = { ...sampleTaskDone, verify: undefined };
    const result = formatTaskPlanCompact([noVerify]);
    assert.ok(!result.includes("verify:"));
  });

  it("description is indented", () => {
    const result = formatTaskPlanCompact([sampleTaskDone]);
    assert.ok(result.includes("  Create tables for decisions and requirements"));
  });

  it("returns (none) for empty array", () => {
    const result = formatTaskPlanCompact([]);
    assert.ok(result.includes("(none)"));
  });

  it("formats single-item array with header", () => {
    const result = formatTaskPlanCompact([sampleTaskDone]);
    assert.ok(result.startsWith("# Tasks (compact)"));
    // Only one task block
    const blocks = result.split("\n\n");
    assert.equal(blocks.length, 2);
  });
});

// ---------------------------------------------------------------------------
// measureSavings
// ---------------------------------------------------------------------------

describe("structured-data-formatter: measureSavings", () => {
  it("returns positive savings when compact is shorter", () => {
    const compact = "short";
    const markdown = "this is a much longer markdown version";
    const savings = measureSavings(compact, markdown);
    assert.ok(savings > 0, `expected positive savings, got ${savings}`);
  });

  it("returns 0 for empty markdown", () => {
    assert.equal(measureSavings("anything", ""), 0);
  });

  it("returns negative when compact is longer", () => {
    const compact = "this is somehow longer than the original";
    const markdown = "tiny";
    const savings = measureSavings(compact, markdown);
    assert.ok(savings < 0, `expected negative savings, got ${savings}`);
  });
});

// ---------------------------------------------------------------------------
// Dropped (#4836): the previous "realistic savings" suite asserted that the
// compact formatter beat hand-authored "typical markdown" baselines by 30%+.
// Those baselines were written by the test author to make the assertion pass
// — they are not the format GSD actually emits anywhere else, so shifting
// the compact output by any amount could be absorbed by padding the baseline.
// There was no regression signal.
//
// The unit tests above already pin the compact format's structure byte for
// byte; a genuine regression changes one of those exact-string assertions.
// If a size-budget guarantee is needed later, capture a real production
// baseline into a fixture file and assert against a checked-in byte count.
// ---------------------------------------------------------------------------
