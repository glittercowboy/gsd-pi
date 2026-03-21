/**
 * Cache wiring integration tests — verifies that prompt-cache-optimizer and
 * prompt-ordering work together with the new S03/S04 section labels and headings.
 *
 * Tests:
 *   1. classifySection() returns correct roles for new labels
 *   2. optimizeForCaching() orders mixed sections correctly with cacheEfficiency > 0.3
 *   3. reorderForCaching() handles Context Manifest and Carry-Forward Context headings
 *   4. buildExecuteTaskPrompt section labels are auto-classified correctly
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifySection,
  section,
  optimizeForCaching,
} from "../prompt-cache-optimizer.js";

import {
  reorderForCaching,
  analyzeCacheEfficiency,
} from "../prompt-ordering.js";

// ─── New label classifications in prompt-cache-optimizer ──────────────────────

describe("cache-wiring: classifySection new labels", () => {
  it("classifies 'context-manifest' as semi-static", () => {
    assert.equal(classifySection("context-manifest"), "semi-static");
  });

  it("classifies 'carry-forward' as dynamic", () => {
    assert.equal(classifySection("carry-forward"), "dynamic");
  });

  it("classifies 'targeted-preloads' as dynamic", () => {
    assert.equal(classifySection("targeted-preloads"), "dynamic");
  });

  it("section() auto-classifies context-manifest as semi-static", () => {
    const s = section("context-manifest", "| File | Purpose |");
    assert.equal(s.role, "semi-static");
  });

  it("section() auto-classifies carry-forward as dynamic", () => {
    const s = section("carry-forward", "Prior task summaries here.");
    assert.equal(s.role, "dynamic");
  });

  it("section() auto-classifies targeted-preloads as dynamic", () => {
    const s = section("targeted-preloads", "Preloaded content.");
    assert.equal(s.role, "dynamic");
  });
});

// ─── optimizeForCaching with realistic execute-task sections ──────────────────

describe("cache-wiring: optimizeForCaching section ordering", () => {
  it("orders static → semi-static → dynamic with realistic execute-task sections", () => {
    const sections = [
      section("template-execute-task", "You are executing GSD auto-mode.\n\nTemplate content with instructions."),
      section("overrides", "## Overrides\n\nNo active overrides."),
      section("slice-plan", "## Slice Plan Excerpt\n\nGoal: Build the feature.\nTasks: T01, T02, T03."),
      section("context-manifest", "## Context Manifest\n\n| File | Purpose | Size |\n| `plan.md` | Slice plan | 2K |"),
      section("task-plan", "## Inlined Task Plan\n\n1. Build the widget\n2. Test the widget"),
      section("carry-forward", "## Carry-Forward Context\n\nT01 completed: scaffolded module."),
    ];

    const result = optimizeForCaching(sections);
    const parts = result.prompt.split("\n\n");

    // Template (static) should be first
    assert.ok(
      result.prompt.indexOf("Template content") < result.prompt.indexOf("Slice Plan"),
      "Static template before semi-static slice plan",
    );
    // Semi-static sections should be in the middle
    assert.ok(
      result.prompt.indexOf("Slice Plan") < result.prompt.indexOf("Inlined Task Plan"),
      "Semi-static slice plan before dynamic task plan",
    );
    assert.ok(
      result.prompt.indexOf("Context Manifest") < result.prompt.indexOf("Carry-Forward Context"),
      "Semi-static context manifest before dynamic carry-forward",
    );
    // Dynamic sections should be last
    assert.ok(
      result.prompt.indexOf("Overrides") < result.prompt.indexOf("Inlined Task Plan"),
      "Semi-static overrides before dynamic task plan",
    );
  });

  it("produces cacheEfficiency > 0.3 for realistic execute-task section mix", () => {
    // Simulate a realistic prompt where static+semi-static > 30% of total
    const sections = [
      section("template-execute-task", "A".repeat(5000)),  // 5K static template
      section("overrides", "B".repeat(500)),                // 500 semi-static
      section("slice-plan", "C".repeat(3000)),              // 3K semi-static
      section("context-manifest", "D".repeat(1000)),        // 1K semi-static
      section("task-plan", "E".repeat(4000)),               // 4K dynamic
      section("carry-forward", "F".repeat(3000)),           // 3K dynamic
    ];

    const result = optimizeForCaching(sections);

    // static(5K) + semi-static(4.5K) = 9.5K out of ~16.5K total → ~0.58
    assert.ok(
      result.cacheEfficiency > 0.3,
      `cacheEfficiency should be > 0.3, got ${result.cacheEfficiency}`,
    );
  });

  it("returns correct sectionCounts for execute-task sections", () => {
    const sections = [
      section("template-execute-task", "static template"),
      section("overrides", "overrides content"),
      section("slice-plan", "slice plan content"),
      section("context-manifest", "manifest content"),
      section("task-plan", "task plan content"),
      section("carry-forward", "carry-forward content"),
    ];

    const result = optimizeForCaching(sections);
    assert.equal(result.sectionCounts["static"], 1, "1 static section (template)");
    assert.equal(result.sectionCounts["semi-static"], 3, "3 semi-static sections (overrides, slice-plan, context-manifest)");
    assert.equal(result.sectionCounts["dynamic"], 2, "2 dynamic sections (task-plan, carry-forward)");
  });
});

// ─── reorderForCaching with Context Manifest and Carry-Forward headings ──────

describe("cache-wiring: reorderForCaching heading classifications", () => {
  it("classifies '## Context Manifest' as semi-static and reorders correctly", () => {
    const prompt = [
      "## Inlined Task Plan",
      "Task plan content.",
      "",
      "## Context Manifest",
      "| File | Purpose | Size |",
      "| `plan.md` | Plan | 2K |",
      "",
      "## Output Template",
      "Static template content.",
    ].join("\n");

    const result = reorderForCaching(prompt);
    const staticIdx = result.indexOf("## Output Template");
    const semiIdx = result.indexOf("## Context Manifest");
    const dynamicIdx = result.indexOf("## Inlined Task Plan");

    assert.ok(staticIdx !== -1, "Output Template should exist");
    assert.ok(semiIdx !== -1, "Context Manifest should exist");
    assert.ok(dynamicIdx !== -1, "Inlined Task Plan should exist");
    assert.ok(staticIdx < semiIdx, "Static before semi-static");
    assert.ok(semiIdx < dynamicIdx, "Semi-static before dynamic");
  });

  it("classifies '## Carry-Forward Context' as dynamic", () => {
    const prompt = [
      "## Carry-Forward Context",
      "Prior task summaries.",
      "",
      "## Decisions",
      "Semi-static decisions content.",
    ].join("\n");

    const result = reorderForCaching(prompt);
    const semiIdx = result.indexOf("## Decisions");
    const dynamicIdx = result.indexOf("## Carry-Forward Context");

    assert.ok(semiIdx < dynamicIdx, "Semi-static Decisions before dynamic Carry-Forward");
  });

  it("analyzeCacheEfficiency accounts for Context Manifest as semi-static", () => {
    const prompt = [
      "## Output Template",
      "Static content here.",
      "",
      "## Context Manifest",
      "| File | Purpose | Size |",
      "| `plan.md` | Plan | 2K |",
      "",
      "## Inlined Task Plan",
      "Dynamic task content.",
    ].join("\n");

    const result = analyzeCacheEfficiency(prompt);
    assert.ok(result.semiStaticChars > 0, "Context Manifest should contribute to semi-static chars");
    assert.ok(result.staticChars > 0, "Output Template should contribute to static chars");
    assert.ok(result.dynamicChars > 0, "Inlined Task Plan should contribute to dynamic chars");
    assert.ok(result.cacheEfficiency > 0.3, "Should have > 0.3 cache efficiency");
  });
});

// ─── Cross-module consistency ────────────────────────────────────────────────

describe("cache-wiring: cross-module consistency", () => {
  it("both modules agree on context-manifest being cacheable (semi-static)", () => {
    // prompt-cache-optimizer classifies the label
    const labelRole = classifySection("context-manifest");
    assert.equal(labelRole, "semi-static");

    // prompt-ordering classifies the heading
    const prompt = "## Context Manifest\nManifest content.\n\n## Inlined Task Plan\nTask content.";
    const result = reorderForCaching(prompt);
    const manifestIdx = result.indexOf("## Context Manifest");
    const taskIdx = result.indexOf("## Inlined Task Plan");
    assert.ok(manifestIdx < taskIdx, "Heading-based ordering agrees: semi-static before dynamic");
  });

  it("both modules agree on carry-forward being dynamic", () => {
    const labelRole = classifySection("carry-forward");
    assert.equal(labelRole, "dynamic");

    const prompt = "## Decisions\nDecision content.\n\n## Carry-Forward Context\nCarry-forward content.";
    const result = reorderForCaching(prompt);
    const semiIdx = result.indexOf("## Decisions");
    const dynamicIdx = result.indexOf("## Carry-Forward Context");
    assert.ok(semiIdx < dynamicIdx, "Heading-based ordering agrees: semi-static before dynamic");
  });
});
