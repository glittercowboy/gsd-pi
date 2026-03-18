/**
 * Tests for summary-distiller.ts — the summary distillation module.
 * Verifies frontmatter extraction, compact formatting, budget enforcement,
 * and progressive field dropping.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { distillSingle, distillSummaries } from "../summary-distiller.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const REALISTIC_SUMMARY = `---
id: S01
parent: M001
milestone: M001
provides:
  - Core type definitions
  - File I/O utilities
requires: []
affects:
  - All downstream slices
key_files:
  - src/types.ts
  - src/files.ts
  - src/paths.ts
key_decisions:
  - D001
  - D003
patterns_established:
  - Pure function modules
  - Dependency injection via parameters
drill_down_paths:
  - src/types.ts for interface contracts
observability_surfaces:
  - Unit test coverage > 90%
duration: 45m
verification_result: pass
completed_at: 2025-03-15T10:00:00Z
blocker_discovered: false
---

# S01: Core Type Definitions and File I/O

Foundation types and file operations for the GSD extension.

## What Happened

Implemented 12 core interfaces spanning roadmap parsing, slice plans, summaries,
and continuation state. Added file I/O utilities for reading, parsing, and writing
GSD artifact files. Established the path resolution module for computing absolute
and relative paths to milestone, slice, and task artifacts.

## Deviations

Minor deviation from plan: added \`filesModified\` field to Summary interface that
was not in the original design, based on the realization that tracking modified
files in summaries enables better diff-context prioritization.

## Files Modified

- \`src/types.ts\` — 12 interfaces, 4 type aliases
- \`src/files.ts\` — 8 parser functions, 3 writer functions
- \`src/paths.ts\` — 14 path resolver functions
`;

const SECOND_SUMMARY = `---
id: S02
parent: M001
milestone: M001
provides:
  - Roadmap parser
  - Slice dependency resolver
requires:
  - Core type definitions
key_files:
  - src/roadmap.ts
  - src/deps.ts
key_decisions:
  - D004
patterns_established:
  - DAG-based ordering
drill_down_paths:
  - src/deps.ts for topological sort
duration: 30m
verification_result: pass
completed_at: 2025-03-15T11:00:00Z
---

# S02: Roadmap Parser and Dependency Resolution

Built the roadmap parser and DAG-based dependency resolver.

## What Happened

Created a Markdown-based roadmap parser that extracts slice metadata from
structured headings and bullet lists. Implemented a topological sort for
resolving slice execution order based on declared dependencies.

## Files Modified

- \`src/roadmap.ts\` — parser with regex-based extraction
- \`src/deps.ts\` — DAG builder and topological sort
`;

const NO_FRONTMATTER = `# S99: Quick Fix

A quick patch with no frontmatter at all.

## What Happened

Fixed a typo.
`;

const EMPTY_ARRAYS_SUMMARY = `---
id: S03
provides: []
requires: []
key_files: []
key_decisions: []
patterns_established: []
---

# S03: Empty Slice

Nothing to provide or require.
`;

// ─── distillSingle ──────────────────────────────────────────────────────────

describe("summary-distiller: distillSingle", () => {
  it("extracts frontmatter fields from a realistic summary", () => {
    const result = distillSingle(REALISTIC_SUMMARY);
    assert.ok(result.includes("## S01:"), "should include the id header");
    assert.ok(result.includes("provides: Core type definitions, File I/O utilities"),
      "should list provides");
    assert.ok(result.includes("key_files: src/types.ts, src/files.ts, src/paths.ts"),
      "should list key_files");
    assert.ok(result.includes("key_decisions: D001, D003"),
      "should list key_decisions");
    assert.ok(result.includes("patterns: Pure function modules, Dependency injection via parameters"),
      "should list patterns");
  });

  it("extracts the one-liner from the title line", () => {
    const result = distillSingle(REALISTIC_SUMMARY);
    // The title line "# S01: Core Type Definitions and File I/O" provides the one-liner
    assert.ok(
      result.includes("Core Type Definitions and File I/O"),
      "should include one-liner from title",
    );
  });

  it("falls back to first paragraph when title has no inline text", () => {
    const summary = `---
id: S10
provides:
  - Widget API
---

# S10:

Widget API for rendering dashboard components.

## What Happened

Built the widget system.
`;
    const result = distillSingle(summary);
    assert.ok(
      result.includes("Widget API for rendering"),
      "should use first paragraph as one-liner when title text is empty",
    );
  });

  it("drops verbose prose sections", () => {
    const result = distillSingle(REALISTIC_SUMMARY);
    assert.ok(!result.includes("What Happened"), "should not include What Happened heading");
    assert.ok(!result.includes("Implemented 12 core"), "should not include prose body");
    assert.ok(!result.includes("Deviations"), "should not include Deviations");
    assert.ok(!result.includes("filesModified"), "should not include deviation details");
    assert.ok(!result.includes("drill_down_paths"), "should not include drill_down_paths label");
    assert.ok(!result.includes("duration"), "should not include duration");
    assert.ok(!result.includes("verification_result"), "should not include verification_result");
    assert.ok(!result.includes("completed_at"), "should not include completed_at");
  });

  it("handles array fields in provides/requires", () => {
    const result = distillSingle(SECOND_SUMMARY);
    assert.ok(result.includes("provides: Roadmap parser, Slice dependency resolver"),
      "should join provides array");
    assert.ok(result.includes("requires: Core type definitions"),
      "should join requires array");
  });

  it("omits empty requires when none declared", () => {
    const result = distillSingle(REALISTIC_SUMMARY);
    assert.ok(!result.includes("requires:"), "should omit requires when empty");
  });

  it("handles missing frontmatter gracefully", () => {
    const result = distillSingle(NO_FRONTMATTER);
    assert.ok(result.includes("## S99:"), "should extract id from title");
    assert.ok(result.includes("Quick Fix"), "should include title text");
  });

  it("handles empty array frontmatter fields", () => {
    const result = distillSingle(EMPTY_ARRAYS_SUMMARY);
    assert.ok(result.includes("## S03:"), "should have the id");
    assert.ok(!result.includes("provides:"), "should omit empty provides");
    assert.ok(!result.includes("requires:"), "should omit empty requires");
    assert.ok(!result.includes("key_files:"), "should omit empty key_files");
    assert.ok(!result.includes("key_decisions:"), "should omit empty key_decisions");
    assert.ok(!result.includes("patterns:"), "should omit empty patterns");
  });

  it("produces significantly shorter output than input", () => {
    const result = distillSingle(REALISTIC_SUMMARY);
    assert.ok(
      result.length < REALISTIC_SUMMARY.length * 0.5,
      `distilled (${result.length}) should be <50% of original (${REALISTIC_SUMMARY.length})`,
    );
  });
});

// ─── distillSummaries ────────────────────────────────────────────────────────

describe("summary-distiller: distillSummaries", () => {
  it("combines multiple summaries into structured blocks", () => {
    const result = distillSummaries([REALISTIC_SUMMARY, SECOND_SUMMARY], 10_000);
    assert.equal(result.summaryCount, 2);
    assert.ok(result.content.includes("## S01:"), "should include first summary");
    assert.ok(result.content.includes("## S02:"), "should include second summary");
  });

  it("reports positive savings percentage", () => {
    const result = distillSummaries([REALISTIC_SUMMARY, SECOND_SUMMARY], 10_000);
    assert.ok(result.savingsPercent > 0, `savings should be positive, got ${result.savingsPercent}%`);
    assert.ok(result.distilledChars < result.originalChars,
      "distilled chars should be less than original");
  });

  it("fits content within budgetChars when budget is generous", () => {
    const result = distillSummaries([REALISTIC_SUMMARY, SECOND_SUMMARY], 10_000);
    assert.ok(
      result.content.length <= 10_000,
      `content length ${result.content.length} should be within budget 10000`,
    );
    assert.ok(!result.content.includes("[...truncated]"), "should not truncate with generous budget");
  });

  it("enforces budget with truncation when needed", () => {
    const result = distillSummaries([REALISTIC_SUMMARY, SECOND_SUMMARY], 200);
    assert.ok(
      result.content.length <= 215, // allow some slack for truncation marker
      `content length ${result.content.length} should be near budget 200`,
    );
    assert.ok(result.content.includes("[...truncated]"), "should include truncation marker");
  });

  it("progressively drops fields when budget is tight", () => {
    // With a budget that can fit the header lines but not all fields,
    // patterns should be dropped first, then key_decisions, then key_files
    const full = distillSummaries([REALISTIC_SUMMARY], 100_000);
    assert.ok(full.content.includes("patterns:"), "full output should have patterns");

    // Find a budget that forces dropping patterns but keeps key_decisions
    const withoutPatterns = full.content.replace(/patterns:.*$/m, "").length;
    const withPatterns = full.content.length;

    if (withPatterns > withoutPatterns) {
      const tightBudget = withoutPatterns + 5;
      const tight = distillSummaries([REALISTIC_SUMMARY], tightBudget);
      assert.ok(!tight.content.includes("patterns:"),
        "tight budget should drop patterns first");
      assert.ok(tight.content.includes("key_decisions:"),
        "tight budget should still have key_decisions");
    }
  });

  it("handles a single summary", () => {
    const result = distillSummaries([REALISTIC_SUMMARY], 10_000);
    assert.equal(result.summaryCount, 1);
    assert.ok(result.content.includes("## S01:"), "should include the single summary");
  });

  it("handles empty input array", () => {
    const result = distillSummaries([], 10_000);
    assert.equal(result.summaryCount, 0);
    assert.equal(result.content, "");
    assert.equal(result.savingsPercent, 0);
    assert.equal(result.originalChars, 0);
    assert.equal(result.distilledChars, 0);
  });

  it("handles malformed content gracefully", () => {
    const malformed = "this is not a valid summary at all\nno frontmatter\nno headings";
    const result = distillSummaries([malformed], 10_000);
    assert.equal(result.summaryCount, 1);
    // Should not throw, should produce some output
    assert.ok(result.content.length > 0, "should produce output even for malformed input");
  });

  it("handles very tight budget (100 chars) with truncation", () => {
    const result = distillSummaries([REALISTIC_SUMMARY, SECOND_SUMMARY], 100);
    assert.ok(
      result.content.length <= 115, // small slack for marker
      `content (${result.content.length}) should be near budget 100`,
    );
    assert.ok(result.content.includes("[...truncated]"), "should truncate at very tight budget");
    assert.ok(result.savingsPercent > 80, `savings should be very high, got ${result.savingsPercent}%`);
  });

  it("tracks original and distilled character counts accurately", () => {
    const summaries = [REALISTIC_SUMMARY, SECOND_SUMMARY];
    const totalOriginal = summaries.reduce((s, c) => s + c.length, 0);
    const result = distillSummaries(summaries, 10_000);
    assert.equal(result.originalChars, totalOriginal, "originalChars should match input total");
    assert.equal(result.distilledChars, result.content.length,
      "distilledChars should match content length");
  });
});
