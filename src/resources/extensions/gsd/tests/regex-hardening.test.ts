/**
 * regex-hardening.test.ts — verifies production regexes accept both the
 * legacy (M001) and unique (M001-abc123) milestone ID formats.
 *
 * The previous version of this file advertised 12 parser sites but
 * only 3 tested imports (SLICE_BRANCH_RE, MILESTONE_ID_RE helpers).
 * The remaining 9 sections (a, b, d, e, f) declared local `const
 * *_RE = ...` copies of production regexes and asserted against the
 * copies — a bug in the real regex would not fail those tests. See
 * #4835.
 *
 * This rewrite imports every production pattern it exercises. Four
 * call sites whose regexes are inline at the use site (state.ts:313
 * title-strip, workspace-index.ts:80 title extraction, worktree-
 * command.ts hasExistingMilestones, and the prompt dispatch regexes
 * in index.ts) are intentionally NOT reimplemented here — they should
 * be covered by behaviour tests of their parent functions, not by
 * regex-copy assertions. A follow-up issue tracks extracting those
 * regexes to a shared patterns module so they can be tested directly.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MILESTONE_ID_RE,
  extractMilestoneSeq,
  milestoneIdSort,
} from "../guided-flow.ts";
import { SLICE_BRANCH_RE } from "../worktree.ts";
import { MILESTONE_CONTEXT_RE } from "../bootstrap/write-gate.ts";

// ─── MILESTONE_ID_RE ──────────────────────────────────────────────────────

test("MILESTONE_ID_RE accepts classic M001 format", () => {
  assert.ok(MILESTONE_ID_RE.test("M001"));
  assert.ok(MILESTONE_ID_RE.test("M042"));
  assert.ok(MILESTONE_ID_RE.test("M999"));
});

test("MILESTONE_ID_RE accepts unique M001-abc123 format", () => {
  assert.ok(MILESTONE_ID_RE.test("M001-abc123"));
  assert.ok(MILESTONE_ID_RE.test("M042-z9a8b7"));
});

test("MILESTONE_ID_RE rejects non-milestone strings", () => {
  assert.ok(!MILESTONE_ID_RE.test("S01"));
  assert.ok(!MILESTONE_ID_RE.test("X001"));
  assert.ok(!MILESTONE_ID_RE.test("notes"));
  assert.ok(!MILESTONE_ID_RE.test(".DS_Store"));
  assert.ok(!MILESTONE_ID_RE.test(""));
  // Must be a bare id — not a prefix match.
  assert.ok(!MILESTONE_ID_RE.test("M001-ABCDEF"), "uppercase suffix rejected");
  assert.ok(!MILESTONE_ID_RE.test("M001 "), "trailing space rejected");
});

// ─── SLICE_BRANCH_RE ──────────────────────────────────────────────────────

test("SLICE_BRANCH_RE captures milestone + slice without worktree prefix", () => {
  for (const { input, expectMid } of [
    { input: "gsd/M001/S01", expectMid: "M001" },
    { input: "gsd/M001-abc123/S01", expectMid: "M001-abc123" },
  ]) {
    const m = input.match(SLICE_BRANCH_RE);
    assert.ok(m, `should match ${input}`);
    assert.equal(m?.[1], undefined, "no worktree prefix");
    assert.equal(m?.[2], expectMid);
    assert.equal(m?.[3], "S01");
  }
});

test("SLICE_BRANCH_RE captures worktree prefix when present", () => {
  for (const { input, expectMid } of [
    { input: "gsd/worktree/M001/S01", expectMid: "M001" },
    { input: "gsd/worktree/M001-abc123/S01", expectMid: "M001-abc123" },
  ]) {
    const m = input.match(SLICE_BRANCH_RE);
    assert.ok(m, `should match ${input}`);
    assert.equal(m?.[1], "worktree");
    assert.equal(m?.[2], expectMid);
    assert.equal(m?.[3], "S01");
  }
});

test("SLICE_BRANCH_RE rejects malformed inputs", () => {
  assert.ok(!SLICE_BRANCH_RE.test("gsd/S01"), "no milestone");
  assert.ok(!SLICE_BRANCH_RE.test("main"), "non-gsd branch");
  assert.ok(!SLICE_BRANCH_RE.test("gsd/M001"), "no slice");
  assert.ok(!SLICE_BRANCH_RE.test("feature/M001/S01"), "wrong prefix");
});

// ─── MILESTONE_CONTEXT_RE ────────────────────────────────────────────────

test("MILESTONE_CONTEXT_RE matches legacy and unique CONTEXT.md names", () => {
  assert.ok(MILESTONE_CONTEXT_RE.test("M001-CONTEXT.md"));
  assert.ok(MILESTONE_CONTEXT_RE.test("M001-abc123-CONTEXT.md"));
  assert.ok(
    MILESTONE_CONTEXT_RE.test(".gsd/milestones/M001/M001-CONTEXT.md"),
    "full path legacy format",
  );
  assert.ok(
    MILESTONE_CONTEXT_RE.test(".gsd/milestones/M001-abc123/M001-abc123-CONTEXT.md"),
    "full path unique format",
  );
});

test("MILESTONE_CONTEXT_RE rejects non-CONTEXT artifact names", () => {
  assert.ok(!MILESTONE_CONTEXT_RE.test("M001-ROADMAP.md"));
  assert.ok(!MILESTONE_CONTEXT_RE.test("M001-SUMMARY.md"));
  assert.ok(!MILESTONE_CONTEXT_RE.test("CONTEXT.md"), "bare name without milestone prefix");
});

// ─── extractMilestoneSeq ──────────────────────────────────────────────────

test("extractMilestoneSeq returns numeric sequence for both formats", () => {
  assert.equal(extractMilestoneSeq("M001"), 1);
  assert.equal(extractMilestoneSeq("M042"), 42);
  assert.equal(extractMilestoneSeq("M999"), 999);
  assert.equal(extractMilestoneSeq("M001-abc123"), 1);
  assert.equal(extractMilestoneSeq("M042-z9a8b7"), 42);
  assert.equal(extractMilestoneSeq("M100-xyz789"), 100);
});

test("extractMilestoneSeq returns 0 (not NaN) for invalid inputs", () => {
  assert.equal(extractMilestoneSeq(""), 0);
  assert.equal(extractMilestoneSeq("notes"), 0);
  assert.equal(extractMilestoneSeq("S01"), 0);
  // Specific regression: the parseInt(slice(1)) implementation returned
  // NaN on inputs like "M001-abc123" because parseInt stopped at the
  // dash but then the rest of the logic treated the result as a number.
  // Current impl returns a real number.
  assert.ok(!Number.isNaN(extractMilestoneSeq("M001-abc123")));
});

// ─── milestoneIdSort ──────────────────────────────────────────────────────

test("milestoneIdSort orders by numeric sequence across both formats", () => {
  const mixed = ["M002-abc123", "M001", "M001-xyz789"];
  assert.deepEqual(
    [...mixed].sort(milestoneIdSort),
    ["M001", "M001-xyz789", "M002-abc123"],
    "mixed formats sort by seq number",
  );

  const legacy = ["M003", "M001", "M002"];
  assert.deepEqual([...legacy].sort(milestoneIdSort), ["M001", "M002", "M003"]);

  const unique = ["M003-abc123", "M001-def456", "M002-ghi789"];
  assert.deepEqual(
    [...unique].sort(milestoneIdSort),
    ["M001-def456", "M002-ghi789", "M003-abc123"],
  );
});

test("milestoneIdSort preserves input order for same-sequence ids", () => {
  // sort is stable per ECMAScript 2019+ when the comparator returns 0.
  const sameSeq = ["M001-abc123", "M001"];
  const sorted = [...sameSeq].sort(milestoneIdSort);
  assert.equal(sorted[0], "M001-abc123");
  assert.equal(sorted[1], "M001");
});
