import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { classifyUnitComplexity, tierLabel, tierOrdinal, extractTaskMetadata } from "../complexity-classifier.js";
import type { ComplexityTier, TaskMetadata } from "../complexity-classifier.js";

// ─── tierLabel ───────────────────────────────────────────────────────────────

test("tierLabel returns correct short labels", () => {
  assert.equal(tierLabel("light"), "L");
  assert.equal(tierLabel("standard"), "S");
  assert.equal(tierLabel("heavy"), "H");
});

// ─── tierOrdinal ─────────────────────────────────────────────────────────────

test("tierOrdinal returns correct ordering", () => {
  assert.ok(tierOrdinal("light") < tierOrdinal("standard"));
  assert.ok(tierOrdinal("standard") < tierOrdinal("heavy"));
});

// ─── Unit Type Classification ────────────────────────────────────────────────

test("complete-slice classifies as standard", () => {
  const result = classifyUnitComplexity("complete-slice", "M001/S01", "/tmp/fake");
  assert.equal(result.tier, "standard");
});

test("run-uat classifies as light", () => {
  const result = classifyUnitComplexity("run-uat", "M001/S01", "/tmp/fake");
  assert.equal(result.tier, "light");
});

test("research-milestone classifies as standard", () => {
  const result = classifyUnitComplexity("research-milestone", "M001", "/tmp/fake");
  assert.equal(result.tier, "standard");
});

test("research-slice classifies as standard", () => {
  const result = classifyUnitComplexity("research-slice", "M001/S01", "/tmp/fake");
  assert.equal(result.tier, "standard");
});

test("plan-milestone classifies as heavy", () => {
  const result = classifyUnitComplexity("plan-milestone", "M001", "/tmp/fake");
  assert.equal(result.tier, "heavy");
});

test("plan-slice classifies as heavy", () => {
  const result = classifyUnitComplexity("plan-slice", "M001/S01", "/tmp/fake");
  assert.equal(result.tier, "heavy");
});

test("replan-slice classifies as heavy", () => {
  const result = classifyUnitComplexity("replan-slice", "M001/S01", "/tmp/fake");
  assert.equal(result.tier, "heavy");
});

test("reassess-roadmap classifies as heavy", () => {
  const result = classifyUnitComplexity("reassess-roadmap", "M001", "/tmp/fake");
  assert.equal(result.tier, "heavy");
});

test("hook units classify as light", () => {
  const result = classifyUnitComplexity("hook/verify", "M001/S01/T01", "/tmp/fake");
  assert.equal(result.tier, "light");
  assert.match(result.reason, /hook/);
});

test("unknown unit types default to standard", () => {
  const result = classifyUnitComplexity("custom-thing", "M001", "/tmp/fake");
  assert.equal(result.tier, "standard");
});

// ─── Task Metadata Classification ────────────────────────────────────────────

test("execute-task with many dependencies classifies as heavy", () => {
  const metadata: TaskMetadata = { dependencyCount: 4 };
  const result = classifyUnitComplexity("execute-task", "M001/S01/T01", "/tmp/fake", undefined, metadata);
  assert.equal(result.tier, "heavy");
  assert.match(result.reason, /dependencies/);
});

test("execute-task with many files classifies as heavy", () => {
  const metadata: TaskMetadata = { fileCount: 8 };
  const result = classifyUnitComplexity("execute-task", "M001/S01/T01", "/tmp/fake", undefined, metadata);
  assert.equal(result.tier, "heavy");
  assert.match(result.reason, /files/);
});

test("execute-task with large estimated lines classifies as heavy", () => {
  const metadata: TaskMetadata = { estimatedLines: 600 };
  const result = classifyUnitComplexity("execute-task", "M001/S01/T01", "/tmp/fake", undefined, metadata);
  assert.equal(result.tier, "heavy");
  assert.match(result.reason, /lines/);
});

test("execute-task with docs tags classifies as light", () => {
  const metadata: TaskMetadata = { tags: ["docs"] };
  const result = classifyUnitComplexity("execute-task", "M001/S01/T01", "/tmp/fake", undefined, metadata);
  assert.equal(result.tier, "light");
});

test("execute-task with single file modification classifies as light", () => {
  const metadata: TaskMetadata = { fileCount: 1, isNewFile: false };
  const result = classifyUnitComplexity("execute-task", "M001/S01/T01", "/tmp/fake", undefined, metadata);
  assert.equal(result.tier, "light");
});

test("execute-task with no metadata classifies as standard", () => {
  const result = classifyUnitComplexity("execute-task", "M001/S01/T01", "/tmp/fake");
  assert.equal(result.tier, "standard");
});

// ─── Budget Pressure ─────────────────────────────────────────────────────────

test("no budget pressure below 50%", () => {
  const result = classifyUnitComplexity("research-slice", "M001/S01", "/tmp/fake", 0.3);
  assert.equal(result.tier, "standard");
  assert.equal(result.downgraded, false);
});

test("budget pressure at 50% downgrades standard to light", () => {
  const result = classifyUnitComplexity("research-slice", "M001/S01", "/tmp/fake", 0.55);
  assert.equal(result.tier, "light");
  assert.equal(result.downgraded, true);
  assert.match(result.reason, /budget pressure/);
});

test("budget pressure at 75% keeps heavy as heavy", () => {
  const result = classifyUnitComplexity("replan-slice", "M001/S01", "/tmp/fake", 0.80);
  assert.equal(result.tier, "heavy");
  assert.equal(result.downgraded, false);
});

test("budget pressure at 90% downgrades heavy to standard", () => {
  const result = classifyUnitComplexity("replan-slice", "M001/S01", "/tmp/fake", 0.95);
  assert.equal(result.tier, "standard");
  assert.equal(result.downgraded, true);
});

test("budget pressure at 90% downgrades standard to light", () => {
  const result = classifyUnitComplexity("research-slice", "M001/S01", "/tmp/fake", 0.95);
  assert.equal(result.tier, "light");
  assert.equal(result.downgraded, true);
});

test("budget pressure at 90% downgrades complete-slice standard to light", () => {
  const result = classifyUnitComplexity("complete-slice", "M001/S01", "/tmp/fake", 0.95);
  assert.equal(result.tier, "light");
});

// ─── Phase 4: Task Plan Introspection ────────────────────────────────────────

test("execute-task with multiple complexity keywords classifies as heavy", () => {
  const metadata: TaskMetadata = { complexityKeywords: ["migration", "security"] };
  const result = classifyUnitComplexity("execute-task", "M001/S01/T01", "/tmp/fake", undefined, metadata);
  assert.equal(result.tier, "heavy");
  assert.match(result.reason, /migration/);
  assert.match(result.reason, /security/);
});

test("execute-task with single complexity keyword classifies as standard", () => {
  const metadata: TaskMetadata = { complexityKeywords: ["performance"] };
  const result = classifyUnitComplexity("execute-task", "M001/S01/T01", "/tmp/fake", undefined, metadata);
  assert.equal(result.tier, "standard");
  assert.match(result.reason, /performance/);
});

test("execute-task with many code blocks classifies as heavy", () => {
  const metadata: TaskMetadata = { codeBlockCount: 6 };
  const result = classifyUnitComplexity("execute-task", "M001/S01/T01", "/tmp/fake", undefined, metadata);
  assert.equal(result.tier, "heavy");
  assert.match(result.reason, /code blocks/);
});

test("execute-task with few code blocks stays standard", () => {
  const metadata: TaskMetadata = { codeBlockCount: 2 };
  const result = classifyUnitComplexity("execute-task", "M001/S01/T01", "/tmp/fake", undefined, metadata);
  assert.equal(result.tier, "standard");
});

// ─── ClassificationResult taskMetadata passthrough ───────────────────────────

describe("ClassificationResult taskMetadata", () => {
  test("classifyUnitComplexity for execute-task returns result with taskMetadata populated", () => {
    const metadata: TaskMetadata = { fileCount: 3, tags: ["docs"] };
    const result = classifyUnitComplexity("execute-task", "M001/S01/T01", "/tmp/fake", undefined, metadata);
    assert.ok(result.taskMetadata !== undefined, "taskMetadata should be populated for execute-task");
    assert.equal(result.taskMetadata!.tags?.[0], "docs");
  });

  test("classifyUnitComplexity for hook/xyz returns result with taskMetadata undefined", () => {
    const result = classifyUnitComplexity("hook/verify", "M001/S01/T01", "/tmp/fake");
    assert.equal(result.taskMetadata, undefined, "taskMetadata should be undefined for hook units");
  });

  test("classifyUnitComplexity for plan-slice returns result with taskMetadata undefined", () => {
    const result = classifyUnitComplexity("plan-slice", "M001/S01", "/tmp/fake");
    assert.equal(result.taskMetadata, undefined, "taskMetadata should be undefined for plan-slice");
  });

  test("extractTaskMetadata is importable as a named export and is a function", () => {
    assert.equal(typeof extractTaskMetadata, "function", "extractTaskMetadata should be a callable function");
  });
});
