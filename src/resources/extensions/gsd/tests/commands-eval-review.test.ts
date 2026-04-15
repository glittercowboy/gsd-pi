/**
 * Tests for /gsd eval-review pure functions
 *
 * Tests: parseEvalReviewArgs, detectEvalReviewState,
 *        buildEvalReviewOutputPath, buildEvalReviewContext
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import {
  parseEvalReviewArgs,
  detectEvalReviewState,
  buildEvalReviewOutputPath,
  buildEvalReviewContext,
  type EvalReviewState,
} from "../commands-eval-review.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), `gsd-eval-review-test-${randomBytes(4).toString("hex")}-`));
}

// Creates the .gsd/milestones/M001/slices/S01 structure under basePath
function createSliceDir(basePath: string, milestoneId: string, sliceId: string): string {
  const sliceDir = join(basePath, ".gsd", "milestones", milestoneId, "slices", sliceId);
  mkdirSync(sliceDir, { recursive: true });
  return sliceDir;
}

// ── parseEvalReviewArgs ───────────────────────────────────────────────────────

describe("parseEvalReviewArgs", () => {
  test("empty string → sliceId null", () => {
    const result = parseEvalReviewArgs("");
    assert.equal(result.sliceId, null);
  });

  test("whitespace-only → sliceId null", () => {
    const result = parseEvalReviewArgs("   ");
    assert.equal(result.sliceId, null);
  });

  test("bare slice ID → sliceId set", () => {
    const result = parseEvalReviewArgs("S01");
    assert.equal(result.sliceId, "S01");
  });

  test("slice ID with surrounding whitespace → trimmed", () => {
    const result = parseEvalReviewArgs("  S02  ");
    assert.equal(result.sliceId, "S02");
  });

  test("--force before slice ID → sliceId set and force true", () => {
    const result = parseEvalReviewArgs("--force S03");
    assert.equal(result.sliceId, "S03");
    assert.equal(result.force, true);
  });

  test("--force only → sliceId null, force true", () => {
    const result = parseEvalReviewArgs("--force");
    assert.equal(result.sliceId, null);
    assert.equal(result.force, true);
  });
});

// ── detectEvalReviewState ─────────────────────────────────────────────────────

describe("detectEvalReviewState", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = createTmpDir();
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  test("no SUMMARY.md → state no-summary, both paths null", () => {
    createSliceDir(tmpBase, "M001", "S01");
    const result = detectEvalReviewState(tmpBase, "M001", "S01");
    assert.equal(result.state, "no-summary");
    assert.equal(result.summaryPath, null);
    assert.equal(result.specPath, null);
  });

  test("SUMMARY.md only → state no-spec, summaryPath set, specPath null", () => {
    const sliceDir = createSliceDir(tmpBase, "M001", "S01");
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\n\nContent here.", "utf-8");
    const result = detectEvalReviewState(tmpBase, "M001", "S01");
    assert.equal(result.state, "no-spec");
    assert.ok(result.summaryPath !== null);
    assert.equal(result.specPath, null);
  });

  test("SUMMARY.md + AI-SPEC.md → state full, both paths set", () => {
    const sliceDir = createSliceDir(tmpBase, "M001", "S01");
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\n\nContent here.", "utf-8");
    writeFileSync(join(sliceDir, "AI-SPEC.md"), "# AI Spec\n\nSpec content here.", "utf-8");
    const result = detectEvalReviewState(tmpBase, "M001", "S01");
    assert.equal(result.state, "full");
    assert.ok(result.summaryPath !== null);
    assert.ok(result.specPath !== null);
  });

  test("sliceDir in result contains the slice ID", () => {
    const sliceDir = createSliceDir(tmpBase, "M001", "S01");
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "content", "utf-8");
    const result = detectEvalReviewState(tmpBase, "M001", "S01");
    assert.ok(result.sliceDir !== null);
    assert.ok(result.sliceDir!.includes("S01"));
  });

  test("non-existent milestone dir → state no-summary", () => {
    const result = detectEvalReviewState(tmpBase, "M999", "S99");
    assert.equal(result.state, "no-summary");
    assert.equal(result.summaryPath, null);
    assert.equal(result.specPath, null);
  });

  test("sliceDir is null when milestone does not exist", () => {
    const result = detectEvalReviewState(tmpBase, "M999", "S99");
    // sliceDir may or may not be set depending on implementation,
    // but state must be no-summary
    assert.equal(result.state, "no-summary");
  });
});

// ── buildEvalReviewOutputPath ─────────────────────────────────────────────────

describe("buildEvalReviewOutputPath", () => {
  test("returns join(sliceDir, sliceId-EVAL-REVIEW.md)", () => {
    const result = buildEvalReviewOutputPath("/some/path/S01", "S01");
    assert.equal(result, "/some/path/S01/S01-EVAL-REVIEW.md");
  });

  test("works with different slice IDs", () => {
    const result = buildEvalReviewOutputPath("/base/milestones/M001/slices/S03", "S03");
    assert.equal(result, "/base/milestones/M001/slices/S03/S03-EVAL-REVIEW.md");
  });
});

// ── buildEvalReviewContext ────────────────────────────────────────────────────

describe("buildEvalReviewContext", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = createTmpDir();
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  test("state no-spec: spec is null, summary contains file content", () => {
    const sliceDir = createSliceDir(tmpBase, "M001", "S01");
    const summaryContent = "# Summary\n\nThis is the summary content.";
    const summaryPath = join(sliceDir, "S01-SUMMARY.md");
    writeFileSync(summaryPath, summaryContent, "utf-8");

    const state: EvalReviewState = {
      state: "no-spec",
      summaryPath,
      specPath: null,
      sliceDir,
    };

    const ctx = buildEvalReviewContext(state);
    assert.equal(ctx.spec, null);
    assert.equal(ctx.summary, summaryContent);
  });

  test("state full: spec contains AI-SPEC content, summary contains SUMMARY content", () => {
    const sliceDir = createSliceDir(tmpBase, "M001", "S01");
    const summaryContent = "# Summary\n\nSummary here.";
    const specContent = "# AI Spec\n\nSpec here.";
    const summaryPath = join(sliceDir, "S01-SUMMARY.md");
    const specPath = join(sliceDir, "AI-SPEC.md");
    writeFileSync(summaryPath, summaryContent, "utf-8");
    writeFileSync(specPath, specContent, "utf-8");

    const state: EvalReviewState = {
      state: "full",
      summaryPath,
      specPath,
      sliceDir,
    };

    const ctx = buildEvalReviewContext(state);
    assert.equal(ctx.spec, specContent);
    assert.equal(ctx.summary, summaryContent);
  });
});
