/**
 * Tests for verdict-parser.ts — extraction, normalization, and schema validation.
 *
 * Regression tests for #2960: extractVerdict() must detect verdicts in both
 * YAML frontmatter and common markdown body patterns (LLM manual writes).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractVerdict,
  hasVerdict,
  isAcceptableUatVerdict,
  isValidMilestoneVerdict,
} from "../verdict-parser.ts";

// ── extractVerdict ──────────────────────────────────────────────────────────

describe("extractVerdict", () => {
  it("extracts verdict from YAML frontmatter", () => {
    const content = "---\nverdict: pass\n---\n\n# Validation";
    assert.equal(extractVerdict(content), "pass");
  });

  it("normalizes 'passed' to 'pass' in frontmatter", () => {
    const content = "---\nverdict: passed\n---\n";
    assert.equal(extractVerdict(content), "pass");
  });

  it("extracts case-insensitive verdict from frontmatter", () => {
    const content = "---\nVerdict: PASS\n---\n";
    assert.equal(extractVerdict(content), "pass");
  });

  it("extracts needs-remediation from frontmatter", () => {
    const content = "---\nverdict: needs-remediation\n---\n";
    assert.equal(extractVerdict(content), "needs-remediation");
  });

  it("returns undefined when content has no frontmatter and no markdown verdict", () => {
    const content = "# Just a heading\n\nSome text without any verdict.";
    assert.equal(extractVerdict(content), undefined);
  });

  // ── Regression: #2960 — markdown body verdicts ─────────────────────────

  it("detects **Verdict:** PASS in markdown body (#2960)", () => {
    const content = [
      "# M013 — Milestone Validation",
      "",
      "**Verdict:** PASS",
      "",
      "All slices completed successfully.",
    ].join("\n");
    assert.equal(extractVerdict(content), "pass");
  });

  it("detects **Verdict:** with emoji prefix in markdown body (#2960)", () => {
    const content = [
      "# Milestone Validation",
      "",
      "**Verdict:** ✅ PASS",
      "",
      "Everything looks good.",
    ].join("\n");
    assert.equal(extractVerdict(content), "pass");
  });

  it("detects **Verdict:** needs-remediation in markdown body (#2960)", () => {
    const content = [
      "# Milestone Validation",
      "",
      "**Verdict:** needs-remediation",
      "",
      "Several issues found.",
    ].join("\n");
    assert.equal(extractVerdict(content), "needs-remediation");
  });

  it("normalizes 'passed' to 'pass' in markdown body (#2960)", () => {
    const content = "# Validation\n\n**Verdict:** Passed\n";
    assert.equal(extractVerdict(content), "pass");
  });

  it("detects verdict without colon in bold pattern (#2960)", () => {
    const content = "# Validation\n\n**Verdict** PASS\n";
    assert.equal(extractVerdict(content), "pass");
  });

  it("prefers frontmatter verdict over markdown body", () => {
    const content = [
      "---",
      "verdict: needs-remediation",
      "---",
      "",
      "**Verdict:** PASS",
    ].join("\n");
    assert.equal(extractVerdict(content), "needs-remediation");
  });
});

// ── hasVerdict ────────────────────────────────────────────────────────────

describe("hasVerdict", () => {
  it("returns true when verdict field exists", () => {
    assert.equal(hasVerdict("verdict: pass"), true);
  });

  it("returns false when no verdict field exists", () => {
    assert.equal(hasVerdict("# Just a heading"), false);
  });
});

// ── isAcceptableUatVerdict ───────────────────────────────────────────────

describe("isAcceptableUatVerdict", () => {
  it("accepts pass verdict", () => {
    assert.equal(isAcceptableUatVerdict("pass", undefined), true);
  });

  it("accepts passed verdict", () => {
    assert.equal(isAcceptableUatVerdict("passed", undefined), true);
  });

  it("rejects fail verdict", () => {
    assert.equal(isAcceptableUatVerdict("fail", undefined), false);
  });

  it("accepts partial for mixed UAT type", () => {
    assert.equal(isAcceptableUatVerdict("partial", "mixed"), true);
  });

  it("rejects partial for artifact-driven UAT type", () => {
    assert.equal(isAcceptableUatVerdict("partial", "artifact-driven"), false);
  });
});

// ── isValidMilestoneVerdict ──────────────────────────────────────────────

describe("isValidMilestoneVerdict", () => {
  it("accepts pass", () => {
    assert.equal(isValidMilestoneVerdict("pass"), true);
  });

  it("accepts needs-attention", () => {
    assert.equal(isValidMilestoneVerdict("needs-attention"), true);
  });

  it("accepts needs-remediation", () => {
    assert.equal(isValidMilestoneVerdict("needs-remediation"), true);
  });

  it("rejects unknown verdict", () => {
    assert.equal(isValidMilestoneVerdict("fail"), false);
  });
});
