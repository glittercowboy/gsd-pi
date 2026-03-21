/**
 * Prompt budget enforcement tests — verifies that budget-aware prompt builders
 * truncate content at section boundaries and that plan-slice includes executor
 * context constraints.
 *
 * Tests:
 *   1. inlineDependencySummaries() truncates when budget is small, passes through when large
 *   2. plan-slice.md template includes {{executorContextConstraints}} placeholder
 *   3. Executor constraints formatting varies with context window size
 *   4. Different context windows produce different budget-constrained outputs
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { inlineDependencySummaries } from "../auto-prompts.js";
import { computeBudgets, truncateAtSectionBoundary } from "../context-budget.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function createFixtureBase(): string {
  return mkdtempSync(join(tmpdir(), "gsd-prompt-budget-test-"));
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

/**
 * Set up a minimal milestone with a roadmap declaring slice dependencies and
 * dependency slice summaries on disk.
 */
function setupDependencyFixture(
  base: string,
  mid: string,
  sid: string,
  deps: string[],
  summaries: Record<string, string>,
): void {
  const msDir = join(base, ".gsd", "milestones", mid);
  mkdirSync(msDir, { recursive: true });

  // Build roadmap content — sid depends on deps
  const depStr = deps.join(", ");
  const sliceLines = [
    `- [x] **${deps[0]}: Done dep** \`risk:low\` \`depends:[]\``,
    `- [ ] **${sid}: Current slice** \`risk:medium\` \`depends:[${depStr}]\``,
  ];
  // Add any extra deps as completed slices
  for (let i = 1; i < deps.length; i++) {
    sliceLines.unshift(`- [x] **${deps[i]}: Another dep** \`risk:low\` \`depends:[]\``);
  }
  const roadmapContent = [
    "# Roadmap",
    "",
    "## Slices",
    "",
    ...sliceLines,
  ].join("\n");
  writeFileSync(join(msDir, `${mid}-ROADMAP.md`), roadmapContent);

  // Write dependency slice summaries
  for (const [depId, content] of Object.entries(summaries)) {
    const sliceDir = join(msDir, "slices", depId);
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(sliceDir, `${depId}-SUMMARY.md`), content);
  }

  // Ensure target slice dir exists
  const targetSliceDir = join(msDir, "slices", sid);
  mkdirSync(targetSliceDir, { recursive: true });
}

// ─── inlineDependencySummaries truncation ─────────────────────────────────────

describe("prompt-budget: inlineDependencySummaries truncation", () => {
  let base: string;

  beforeEach(() => {
    base = createFixtureBase();
  });

  afterEach(() => {
    cleanup(base);
  });

  it("passes through all content when budget is larger than total", async () => {
    const summaryContent = "### Results\n\nEverything works.\n\n### Forward Intelligence\n\nWatch out for X.";
    setupDependencyFixture(base, "M001", "S02", ["S01"], {
      S01: summaryContent,
    });

    const result = await inlineDependencySummaries("M001", "S02", base, 100_000);
    assert.ok(result.includes("Everything works."), "should include full summary content");
    assert.ok(result.includes("Watch out for X."), "should include forward intelligence");
    assert.ok(!result.includes("[...truncated"), "should not have truncation marker");
  });

  it("truncates at section boundaries when budget is small", async () => {
    // Create a large summary with multiple sections
    const sections = [];
    for (let i = 0; i < 10; i++) {
      sections.push(`### Section ${i}\n\n${"Lorem ipsum dolor sit amet. ".repeat(50)}`);
    }
    const largeSummary = sections.join("\n\n");

    setupDependencyFixture(base, "M001", "S02", ["S01"], {
      S01: largeSummary,
    });

    // Use a budget smaller than total content
    const result = await inlineDependencySummaries("M001", "S02", base, 500);
    assert.ok(result.includes("[...truncated"), "should have truncation marker when over budget");
    assert.ok(result.length <= 600, `result should be near budget limit, got ${result.length}`);
  });

  it("returns content unchanged when no budget is provided (backward compat)", async () => {
    const sections = [];
    for (let i = 0; i < 5; i++) {
      sections.push(`### Section ${i}\n\n${"Content block. ".repeat(30)}`);
    }
    const largeSummary = sections.join("\n\n");

    setupDependencyFixture(base, "M001", "S02", ["S01"], {
      S01: largeSummary,
    });

    // No budget parameter — backward-compatible behavior
    const result = await inlineDependencySummaries("M001", "S02", base);
    assert.ok(!result.includes("[...truncated"), "should not truncate without budget");
    assert.ok(result.includes("Section 4"), "should include all sections");
  });

  it("handles multiple dependency summaries with truncation", async () => {
    const summary1 = "### S01 Results\n\nFirst dep done.\n\n### S01 Notes\n\nSome notes.";
    const summary2 = "### S02 Results\n\nSecond dep done.\n\n### S02 Notes\n\nMore notes.";
    setupDependencyFixture(base, "M001", "S03", ["S01", "S02"], {
      S01: summary1,
      S02: summary2,
    });

    // Budget large enough for all content
    const fullResult = await inlineDependencySummaries("M001", "S03", base, 100_000);
    assert.ok(fullResult.includes("First dep done."), "should have S01 content");
    assert.ok(fullResult.includes("Second dep done."), "should have S02 content");

    // Budget too small for all
    const truncResult = await inlineDependencySummaries("M001", "S03", base, 200);
    assert.ok(truncResult.includes("[...truncated"), "should truncate when budget is small");
  });

  it("returns no-dependencies marker when slice has no deps", async () => {
    const msDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(msDir, { recursive: true });
    const roadmap = "# Roadmap\n\n## Slices\n\n- [ ] **S01: Solo** `risk:low` `depends:[]`\n";
    writeFileSync(join(msDir, "M001-ROADMAP.md"), roadmap);

    const result = await inlineDependencySummaries("M001", "S01", base, 1000);
    assert.equal(result, "- (no dependencies)");
  });
});

// ─── plan-slice template includes executor constraints placeholder ────────────

describe("prompt-budget: plan-slice template", () => {
  it("contains {{executorContextConstraints}} placeholder", () => {
    const templatePath = join(__dirname, "..", "prompts", "plan-slice.md");
    const template = readFileSync(templatePath, "utf-8");
    assert.ok(
      template.includes("{{executorContextConstraints}}"),
      "plan-slice.md should contain {{executorContextConstraints}} placeholder",
    );
  });
});

// ─── Executor constraints formatting ──────────────────────────────────────────

describe("prompt-budget: executor constraints formatting", () => {
  it("128K window produces different constraints than 1M window", () => {
    const budget128K = computeBudgets(128_000);
    const budget1M = computeBudgets(1_000_000);

    // Task count ranges should differ
    assert.notEqual(
      budget128K.taskCountRange.max,
      budget1M.taskCountRange.max,
      "128K and 1M should have different max task counts",
    );

    // Inline context budgets should differ
    assert.ok(
      budget1M.inlineContextBudgetChars > budget128K.inlineContextBudgetChars,
      "1M should have larger inline context budget than 128K",
    );

    // Format constraint blocks and verify they differ
    const format = (b: ReturnType<typeof computeBudgets>, windowTokens: number) => {
      const { min, max } = b.taskCountRange;
      const execWindowK = Math.round(windowTokens / 1000);
      const perTaskBudgetK = Math.round(b.inlineContextBudgetChars / 1000);
      return [
        `## Executor Context Constraints`,
        ``,
        `The agent that executes each task has a **${execWindowK}K token** context window.`,
        `- Recommended task count for this slice: **${min}–${max} tasks**`,
        `- Each task gets ~${perTaskBudgetK}K chars of inline context (plans, code, decisions)`,
        `- Keep individual tasks completable within a single context window — if a task needs more context than fits, split it`,
      ].join("\n");
    };

    const constraints128K = format(budget128K, 128_000);
    const constraints1M = format(budget1M, 1_000_000);

    assert.ok(constraints128K.includes("128K token"), "128K constraints should reference 128K");
    assert.ok(constraints1M.includes("1000K token"), "1M constraints should reference 1000K");
    assert.ok(constraints128K.includes("2–5 tasks"), "128K should recommend 2–5 tasks");
    assert.ok(constraints1M.includes("2–8 tasks"), "1M should recommend 2–8 tasks");
    assert.notEqual(constraints128K, constraints1M, "constraint blocks should differ");
  });

  it("undefined context window falls back to 200K defaults", () => {
    // computeBudgets(0) defaults to 200K (D002)
    const budgetDefault = computeBudgets(0);
    const budget200K = computeBudgets(200_000);

    assert.equal(budgetDefault.summaryBudgetChars, budget200K.summaryBudgetChars);
    assert.equal(budgetDefault.inlineContextBudgetChars, budget200K.inlineContextBudgetChars);
    assert.equal(budgetDefault.taskCountRange.max, budget200K.taskCountRange.max);
  });
});

// ─── Budget-constrained output varies with context window ─────────────────────

describe("prompt-budget: different context windows produce different outputs", () => {
  it("small window truncates content that large window preserves", () => {
    // Simulate assembled inlinedContext with multiple sections
    const sections = [];
    for (let i = 0; i < 20; i++) {
      sections.push(`### Section ${i}: Important Context\n\n${"Detailed content for this section. ".repeat(100)}`);
    }
    const largeContent = `## Inlined Context\n\n${sections.join("\n\n---\n\n")}`;

    // 128K context window budget
    const budget128K = computeBudgets(128_000);
    const r128K = truncateAtSectionBoundary(largeContent, budget128K.inlineContextBudgetChars);

    // 1M context window budget
    const budget1M = computeBudgets(1_000_000);
    const r1M = truncateAtSectionBoundary(largeContent, budget1M.inlineContextBudgetChars);

    // The large content (~70K chars) should fit in 1M budget (~1.6M chars) but
    // if we make content bigger, the 128K budget (~204K chars) would truncate
    assert.ok(
      r128K.content.length <= budget128K.inlineContextBudgetChars + 100, // +100 for truncation marker
      "128K result should respect budget",
    );
    assert.ok(
      r1M.content.length <= budget1M.inlineContextBudgetChars + 100,
      "1M result should respect budget",
    );

    // With content smaller than both budgets, both should pass through unchanged
    const smallContent = "### One Section\n\nSmall content.";
    const small128K = truncateAtSectionBoundary(smallContent, budget128K.inlineContextBudgetChars);
    const small1M = truncateAtSectionBoundary(smallContent, budget1M.inlineContextBudgetChars);
    assert.equal(small128K.content, smallContent, "small content unchanged for 128K");
    assert.equal(small128K.droppedSections, 0);
    assert.equal(small1M.content, smallContent, "small content unchanged for 1M");
    assert.equal(small1M.droppedSections, 0);
  });

  it("128K budget truncates very large content while 1M preserves it", () => {
    // Create content that exceeds 128K budget (~204K chars) but fits in 1M (~1.6M chars)
    const sections = [];
    for (let i = 0; i < 100; i++) {
      sections.push(`### Section ${i}\n\n${"X".repeat(3000)}`);
    }
    const content = sections.join("\n\n");
    // ~310K chars total

    const budget128K = computeBudgets(128_000);
    const result128K = truncateAtSectionBoundary(content, budget128K.inlineContextBudgetChars);

    const budget1M = computeBudgets(1_000_000);
    const result1M = truncateAtSectionBoundary(content, budget1M.inlineContextBudgetChars);

    assert.ok(result128K.content.includes("[...truncated"), "128K should truncate ~310K content");
    assert.ok(result128K.droppedSections > 0, "128K should report dropped sections");
    assert.ok(!result1M.content.includes("[...truncated"), "1M should preserve ~310K content");
    assert.equal(result1M.droppedSections, 0);
    assert.ok(result128K.content.length < result1M.content.length, "128K result should be shorter than 1M result");
  });
});

// ─── execute-task template includes manifest + preload placeholders ─────────

describe("prompt-budget: execute-task template", () => {
  it("contains {{verificationBudget}} placeholder", () => {
    const templatePath = join(__dirname, "..", "prompts", "execute-task.md");
    const template = readFileSync(templatePath, "utf-8");
    assert.ok(
      template.includes("{{verificationBudget}}"),
      "execute-task.md should contain {{verificationBudget}} placeholder",
    );
  });

  it("contains {{contextManifest}} placeholder", () => {
    const templatePath = join(__dirname, "..", "prompts", "execute-task.md");
    const template = readFileSync(templatePath, "utf-8");
    assert.ok(
      template.includes("{{contextManifest}}"),
      "execute-task.md should contain {{contextManifest}} placeholder",
    );
  });

  it("contains {{targetedPreloads}} placeholder", () => {
    const templatePath = join(__dirname, "..", "prompts", "execute-task.md");
    const template = readFileSync(templatePath, "utf-8");
    assert.ok(
      template.includes("{{targetedPreloads}}"),
      "execute-task.md should contain {{targetedPreloads}} placeholder",
    );
  });

  it("does NOT contain old {{carryForwardSection}} placeholder", () => {
    const templatePath = join(__dirname, "..", "prompts", "execute-task.md");
    const template = readFileSync(templatePath, "utf-8");
    assert.ok(
      !template.includes("{{carryForwardSection}}"),
      "execute-task.md should NOT contain {{carryForwardSection}} placeholder",
    );
  });

  it("verificationBudget format varies with context window size", () => {
    const budget128K = computeBudgets(128_000);
    const budget1M = computeBudgets(1_000_000);

    const format128K = `~${Math.round(budget128K.verificationBudgetChars / 1000)}K chars`;
    const format1M = `~${Math.round(budget1M.verificationBudgetChars / 1000)}K chars`;

    assert.notEqual(format128K, format1M, "128K and 1M should produce different verification budget strings");
    assert.ok(format128K.includes("~51K"), `128K should produce ~51K, got ${format128K}`);
    assert.ok(format1M.includes("~400K"), `1M should produce ~400K, got ${format1M}`);
  });
});

// ─── buildCompleteSlicePrompt budget enforcement (simulated) ─────────────────

describe("prompt-budget: complete-slice builder truncation pattern", () => {
  it("truncateAtSectionBoundary truncates assembled inlinedContext for complete-slice pattern", () => {
    // Simulate buildCompleteSlicePrompt: roadmap + slice plan + task summaries
    const inlined: string[] = [];
    inlined.push("### Milestone Roadmap\n\nRoadmap content here.");
    inlined.push("### Slice Plan\n\nSlice plan content here.");
    // Add many task summaries that push past budget
    for (let i = 0; i < 50; i++) {
      inlined.push(`### Task Summary: T${String(i).padStart(2, "0")}\nSource: \`tasks/T${String(i).padStart(2, "0")}-SUMMARY.md\`\n\n${"Task result details. ".repeat(200)}`);
    }

    const assembledContent = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

    // Small context window (128K) should truncate
    const budget128K = computeBudgets(128_000);
    const result128K = truncateAtSectionBoundary(assembledContent, budget128K.inlineContextBudgetChars);
    assert.ok(result128K.content.includes("[...truncated"), "128K should truncate many task summaries");
    assert.ok(result128K.content.includes("### Milestone Roadmap"), "should preserve early sections");
    assert.ok(result128K.droppedSections > 0, "128K should report dropped sections");

    // Large context window (1M) should preserve all
    const budget1M = computeBudgets(1_000_000);
    const result1M = truncateAtSectionBoundary(assembledContent, budget1M.inlineContextBudgetChars);
    assert.ok(!result1M.content.includes("[...truncated"), "1M should preserve all task summaries");
    assert.equal(result1M.droppedSections, 0);
  });

  it("small content passes through unchanged at any context window size", () => {
    const smallContent = "## Inlined Context\n\n### Roadmap\n\nSmall roadmap.\n\n---\n\n### Plan\n\nSmall plan.";

    const budget128K = computeBudgets(128_000);
    const result128K = truncateAtSectionBoundary(smallContent, budget128K.inlineContextBudgetChars);
    assert.equal(result128K.content, smallContent, "small content unchanged for 128K");
    assert.equal(result128K.droppedSections, 0);

    const budget1M = computeBudgets(1_000_000);
    const result1M = truncateAtSectionBoundary(smallContent, budget1M.inlineContextBudgetChars);
    assert.equal(result1M.content, smallContent, "small content unchanged for 1M");
    assert.equal(result1M.droppedSections, 0);
  });
});

// ─── buildCompleteMilestonePrompt budget enforcement (simulated) ─────────────

describe("prompt-budget: complete-milestone builder truncation pattern", () => {
  it("truncateAtSectionBoundary truncates assembled inlinedContext for complete-milestone pattern", () => {
    // Simulate buildCompleteMilestonePrompt: roadmap + slice summaries + root files
    const inlined: string[] = [];
    inlined.push("### Milestone Roadmap\n\nRoadmap content here.");
    // Add many slice summaries that push past budget
    for (let i = 0; i < 30; i++) {
      inlined.push(`### S${String(i).padStart(2, "0")} Summary\n\n${"Slice summary with detailed results and forward intelligence. ".repeat(200)}`);
    }
    inlined.push("### Requirements\n\nProject requirements.");
    inlined.push("### Decisions\n\nProject decisions.");

    const assembledContent = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

    // Small context window (128K) should truncate
    const budget128K = computeBudgets(128_000);
    const result128K = truncateAtSectionBoundary(assembledContent, budget128K.inlineContextBudgetChars);
    assert.ok(result128K.content.includes("[...truncated"), "128K should truncate many slice summaries");
    assert.ok(result128K.droppedSections > 0);

    // Large context window (1M) should preserve all
    const budget1M = computeBudgets(1_000_000);
    const result1M = truncateAtSectionBoundary(assembledContent, budget1M.inlineContextBudgetChars);
    assert.ok(!result1M.content.includes("[...truncated"), "1M should preserve all slice summaries");
    assert.equal(result1M.droppedSections, 0);
  });

  it("different context windows produce different truncation for milestone completion", () => {
    // Create content that exceeds 128K budget but not 200K budget
    const inlined: string[] = [];
    inlined.push("### Roadmap\n\nRoadmap.");
    for (let i = 0; i < 15; i++) {
      inlined.push(`### S${i} Summary\n\n${"X".repeat(15000)}`);
    }
    const content = `## Inlined Context\n\n${inlined.join("\n\n---\n\n")}`;
    // ~225K chars total

    const budget128K = computeBudgets(128_000);
    const budget200K = computeBudgets(200_000);
    const budget1M = computeBudgets(1_000_000);

    const result128K = truncateAtSectionBoundary(content, budget128K.inlineContextBudgetChars);
    const result200K = truncateAtSectionBoundary(content, budget200K.inlineContextBudgetChars);
    const result1M = truncateAtSectionBoundary(content, budget1M.inlineContextBudgetChars);

    // 128K (budget ~204K) should truncate ~225K content
    assert.ok(result128K.content.includes("[...truncated"), "128K should truncate ~225K content");
    assert.ok(result128K.droppedSections > 0);
    // 200K (budget ~320K) should not truncate ~225K content
    assert.ok(!result200K.content.includes("[...truncated"), "200K should preserve ~225K content");
    assert.equal(result200K.droppedSections, 0);
    // 1M should not truncate
    assert.ok(!result1M.content.includes("[...truncated"), "1M should preserve ~225K content");
    assert.equal(result1M.droppedSections, 0);
    // 128K result should be shorter
    assert.ok(result128K.content.length < result200K.content.length, "128K result should be shorter than 200K");
  });
});

// ─── execute-task builder uses manifest + preloads instead of truncation ──────

describe("prompt-budget: execute-task builder manifest pattern", () => {
  let base: string;

  beforeEach(() => {
    base = createFixtureBase();
  });

  afterEach(() => {
    cleanup(base);
  });

  it("buildExecuteTaskPrompt output contains Context Manifest section with table", async () => {
    // Set up minimal fixture: milestone dir, roadmap, slice plan, task plan
    const msDir = join(base, ".gsd", "milestones", "M001");
    const sliceDir = join(msDir, "slices", "S01");
    const taskDir = join(sliceDir, "tasks");
    mkdirSync(taskDir, { recursive: true });

    const roadmap = "# Roadmap\n\n## Slices\n\n- [ ] **S01: Test slice** `risk:low` `depends:[]`\n";
    writeFileSync(join(msDir, "M001-ROADMAP.md"), roadmap);

    const slicePlan = "# S01: Test Slice\n\n**Goal:** Test goal.\n**Demo:** Test demo.\n\n## Verification\n\n- `echo pass`\n\n## Tasks\n\n- [ ] **T01: Test task** `est:30m`\n";
    writeFileSync(join(sliceDir, "S01-PLAN.md"), slicePlan);

    const taskPlan = "# T01: Test task\n\n## Steps\n\n1. Do the thing\n";
    writeFileSync(join(taskDir, "T01-PLAN.md"), taskPlan);

    const { buildExecuteTaskPrompt } = await import("../auto-prompts.js");
    const result = await buildExecuteTaskPrompt("M001", "S01", "Test slice", "T01", "Test task", base);

    assert.ok(result.includes("## Context Manifest"), "output should contain Context Manifest heading");
    assert.ok(result.includes("| File | Purpose | Size |"), "output should contain manifest table header");
    assert.ok(result.includes("| `"), "output should contain manifest table rows");
  });

  it("buildExecuteTaskPrompt output does NOT contain truncation markers", async () => {
    const msDir = join(base, ".gsd", "milestones", "M001");
    const sliceDir = join(msDir, "slices", "S01");
    const taskDir = join(sliceDir, "tasks");
    mkdirSync(taskDir, { recursive: true });

    const roadmap = "# Roadmap\n\n## Slices\n\n- [ ] **S01: Test slice** `risk:low` `depends:[]`\n";
    writeFileSync(join(msDir, "M001-ROADMAP.md"), roadmap);

    // Write many prior task summaries to simulate the carry-forward scenario
    for (let i = 1; i <= 10; i++) {
      const tid = `T${String(i).padStart(2, "0")}`;
      const summaryContent = [
        "---",
        `id: ${tid}`,
        "parent: S01",
        "milestone: M001",
        "provides:",
        "  - some output",
        "key_files:",
        "  - some/file.ts",
        "key_decisions:",
        "  - a decision",
        "patterns_established:",
        "  - a pattern",
        "observability_surfaces:",
        "  - none",
        "duration: 10m",
        "verification_result: passed",
        "completed_at: 2025-01-01",
        "blocker_discovered: false",
        "---",
        "",
        `# ${tid}: Task ${i}`,
        "",
        `**Did task ${i} stuff**`,
        "",
        "## What Happened",
        "",
        `${"Detailed task results with lots of content. ".repeat(100)}`,
        "",
        "## Diagnostics",
        "",
        "Check the logs.",
      ].join("\n");
      writeFileSync(join(taskDir, `${tid}-SUMMARY.md`), summaryContent);
    }

    // Create a large slice plan
    const slicePlan = "# S01: Test Slice\n\n**Goal:** Big slice goal.\n**Demo:** Demo.\n\n## Verification\n\n- `echo pass`\n\n## Tasks\n\n" +
      Array.from({ length: 11 }, (_, i) => `- [${i < 10 ? 'x' : ' '}] **T${String(i + 1).padStart(2, "0")}: Task ${i + 1}** \`est:30m\``).join("\n") + "\n";
    writeFileSync(join(sliceDir, "S01-PLAN.md"), slicePlan);

    const taskPlan = "# T11: Task eleven\n\n## Steps\n\n1. Do the thing\n";
    writeFileSync(join(taskDir, "T11-PLAN.md"), taskPlan);

    const { buildExecuteTaskPrompt } = await import("../auto-prompts.js");
    const result = await buildExecuteTaskPrompt("M001", "S01", "Test slice", "T11", "Task eleven", base);

    assert.ok(!result.includes("[...truncated"), "execute-task output should NOT contain truncation markers");
    assert.ok(result.includes("## Context Manifest"), "should still have manifest");
    assert.ok(result.includes("T11-PLAN.md"), "should reference task plan in manifest");
  });

  it("buildExecuteTaskPrompt output contains inlined task plan content", async () => {
    const msDir = join(base, ".gsd", "milestones", "M001");
    const sliceDir = join(msDir, "slices", "S01");
    const taskDir = join(sliceDir, "tasks");
    mkdirSync(taskDir, { recursive: true });

    const roadmap = "# Roadmap\n\n## Slices\n\n- [ ] **S01: Test slice** `risk:low` `depends:[]`\n";
    writeFileSync(join(msDir, "M001-ROADMAP.md"), roadmap);

    const slicePlan = "# S01: Test Slice\n\n**Goal:** Goal.\n**Demo:** Demo.\n\n## Verification\n\n- `echo ok`\n\n## Tasks\n\n- [ ] **T01: First task** `est:30m`\n";
    writeFileSync(join(sliceDir, "S01-PLAN.md"), slicePlan);

    const taskPlan = "# T01: First task\n\n## Steps\n\n1. Build the widget\n2. Test the widget\n";
    writeFileSync(join(taskDir, "T01-PLAN.md"), taskPlan);

    const { buildExecuteTaskPrompt } = await import("../auto-prompts.js");
    const result = await buildExecuteTaskPrompt("M001", "S01", "Test slice", "T01", "First task", base);

    // Task plan should be inlined in the targeted preloads
    assert.ok(result.includes("Build the widget"), "output should contain task plan content");
    assert.ok(result.includes("Test the widget"), "output should contain all task plan steps");
    assert.ok(result.includes("## Inlined Task Plan"), "output should have task plan heading");
  });

  it("manifest includes agent instructions about reading files on demand", () => {
    const templatePath = join(__dirname, "..", "prompts", "execute-task.md");
    const template = readFileSync(templatePath, "utf-8");
    assert.ok(
      template.includes("read") && template.includes("on demand"),
      "template should instruct agent to read non-preloaded files on demand",
    );
  });
});