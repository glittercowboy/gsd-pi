import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reorderForCaching, analyzeCacheEfficiency } from "../prompt-ordering.js";

describe("reorderForCaching", () => {
  it("reorders static sections before dynamic sections", () => {
    const prompt = [
      "## Inlined Task Plan",
      "Do the task steps here.",
      "",
      "## Output Template",
      "Use this template.",
      "",
      "## Resume State",
      "Resuming from checkpoint.",
    ].join("\n");

    const result = reorderForCaching(prompt);
    const outputIdx = result.indexOf("## Output Template");
    const taskIdx = result.indexOf("## Inlined Task Plan");
    const resumeIdx = result.indexOf("## Resume State");

    assert.ok(outputIdx < taskIdx, "Static 'Output Template' should come before dynamic 'Inlined Task Plan'");
    assert.ok(outputIdx < resumeIdx, "Static 'Output Template' should come before dynamic 'Resume State'");
  });

  it("preserves preamble at the beginning", () => {
    const prompt = [
      "You are executing GSD auto-mode.",
      "",
      "## Output Template",
      "Template content.",
      "",
      "## Inlined Task Plan",
      "Task content.",
    ].join("\n");

    const result = reorderForCaching(prompt);
    assert.ok(
      result.startsWith("You are executing GSD auto-mode."),
      "Preamble should remain at the start",
    );
  });

  it("preserves relative order within groups", () => {
    const prompt = [
      "## Decisions",
      "Decision A.",
      "",
      "## Requirements",
      "Requirement B.",
      "",
      "## Overrides",
      "Override C.",
    ].join("\n");

    const result = reorderForCaching(prompt);
    const decisionsIdx = result.indexOf("## Decisions");
    const requirementsIdx = result.indexOf("## Requirements");
    const overridesIdx = result.indexOf("## Overrides");

    assert.ok(decisionsIdx < requirementsIdx, "Decisions should come before Requirements (same group order)");
    assert.ok(requirementsIdx < overridesIdx, "Requirements should come before Overrides (same group order)");
  });

  it("handles prompts with no headings (returns unchanged)", () => {
    const prompt = "Just plain text with no markdown headings at all.";
    const result = reorderForCaching(prompt);
    assert.equal(result, prompt);
  });

  it("handles prompts with only static sections", () => {
    const prompt = [
      "## Output Template",
      "Template A.",
      "",
      "## Executor Context Constraints",
      "Constraints B.",
    ].join("\n");

    const result = reorderForCaching(prompt);
    // Both are static, order preserved
    assert.ok(result.indexOf("## Output Template") < result.indexOf("## Executor Context Constraints"));
  });

  it("handles prompts with only dynamic sections", () => {
    const prompt = [
      "## Inlined Task Plan",
      "Plan A.",
      "",
      "## Resume State",
      "State B.",
      "",
      "## Verification",
      "Check C.",
    ].join("\n");

    const result = reorderForCaching(prompt);
    // All dynamic, order preserved
    const planIdx = result.indexOf("## Inlined Task Plan");
    const resumeIdx = result.indexOf("## Resume State");
    const verifyIdx = result.indexOf("## Verification");
    assert.ok(planIdx < resumeIdx);
    assert.ok(resumeIdx < verifyIdx);
  });

  it("unknown headings default to dynamic", () => {
    const prompt = [
      "## Output Template",
      "Static content.",
      "",
      "## Some Unknown Section",
      "Unknown content.",
      "",
      "## Decisions",
      "Semi-static content.",
    ].join("\n");

    const result = reorderForCaching(prompt);
    const staticIdx = result.indexOf("## Output Template");
    const semiIdx = result.indexOf("## Decisions");
    const unknownIdx = result.indexOf("## Some Unknown Section");

    assert.ok(staticIdx < semiIdx, "Static before semi-static");
    assert.ok(semiIdx < unknownIdx, "Semi-static before unknown (dynamic)");
  });

  it("sub-headings stay with their parent section", () => {
    const prompt = [
      "## Slice Plan Excerpt",
      "Slice content.",
      "### Task List",
      "- T1.1",
      "- T1.2",
      "",
      "## Inlined Task Plan",
      "Dynamic task content.",
    ].join("\n");

    const result = reorderForCaching(prompt);
    // The ### Task List should stay with ## Slice Plan Excerpt
    const sliceIdx = result.indexOf("## Slice Plan Excerpt");
    const taskListIdx = result.indexOf("### Task List");
    const inlinedIdx = result.indexOf("## Inlined Task Plan");

    assert.ok(sliceIdx < taskListIdx, "Sub-heading stays after its parent");
    assert.ok(taskListIdx < inlinedIdx, "Sub-heading block comes before dynamic section");
  });
});

describe("analyzeCacheEfficiency", () => {
  it("returns correct ratios", () => {
    const prompt = [
      "Preamble text here.",
      "",
      "## Output Template",
      "Static content here.",
      "",
      "## Decisions",
      "Semi-static content.",
      "",
      "## Inlined Task Plan",
      "Dynamic content here.",
    ].join("\n");

    const result = analyzeCacheEfficiency(prompt);

    assert.ok(result.totalChars > 0, "totalChars should be positive");
    assert.ok(result.staticChars > 0, "staticChars should be positive (includes preamble)");
    assert.ok(result.semiStaticChars > 0, "semiStaticChars should be positive");
    assert.ok(result.dynamicChars > 0, "dynamicChars should be positive");
    assert.ok(result.cacheEfficiency > 0 && result.cacheEfficiency < 1, "efficiency should be between 0 and 1");
    assert.equal(
      result.totalChars,
      result.staticChars + result.semiStaticChars + result.dynamicChars,
      "chars should sum to total",
    );
  });

  it("returns 1.0 efficiency for all-static prompts", () => {
    const prompt = [
      "## Output Template",
      "All static.",
      "",
      "## Executor Context Constraints",
      "Also static.",
    ].join("\n");

    const result = analyzeCacheEfficiency(prompt);
    assert.equal(result.cacheEfficiency, 1.0);
    assert.equal(result.dynamicChars, 0);
  });

  it("returns 0 efficiency for all-dynamic prompts", () => {
    const prompt = [
      "## Inlined Task Plan",
      "All dynamic.",
      "",
      "## Resume State",
      "Also dynamic.",
    ].join("\n");

    const result = analyzeCacheEfficiency(prompt);
    assert.equal(result.cacheEfficiency, 0);
    assert.equal(result.staticChars, 0);
    assert.equal(result.semiStaticChars, 0);
  });
});

describe("real-world prompt reordering", () => {
  it("reorders a realistic execute-task prompt for better cache efficiency", () => {
    // Simulate a prompt resembling buildExecuteTaskPrompt output
    const prompt = [
      "You are executing GSD auto-mode.",
      "",
      "## UNIT: Execute Task T1.2 (\"Add login\") -- Slice S1 (\"Auth\"), Milestone M1",
      "",
      "## Working Directory",
      "Your working directory is `/project`.",
      "",
      "## Overrides",
      "No overrides.",
      "",
      "## Resume State",
      "Resuming from step 3.",
      "",
      "## Carry-Forward Context",
      "Previous task noted the API uses JWT.",
      "",
      "## Inlined Task Plan",
      "1. Create auth endpoint",
      "2. Add JWT validation",
      "3. Write tests",
      "",
      "## Slice Plan Excerpt",
      "Tasks: T1.1, T1.2, T1.3",
      "Verification: run tests",
      "",
      "## Decisions",
      "Using bcrypt for password hashing.",
      "",
      "## Requirements",
      "Must support OAuth2.",
      "",
      "## Prior Task Summaries",
      "T1.1 completed: scaffolded auth module.",
      "",
      "## Backing Source Artifacts",
      "- Slice plan: `.gsd/slices/S1.md`",
      "",
      "## Output Template",
      "Use standard task summary format.",
      "",
      "## Verification",
      "Run `npm test` and verify all pass.",
    ].join("\n");

    const beforeEfficiency = analyzeCacheEfficiency(prompt);
    const reordered = reorderForCaching(prompt);
    const afterEfficiency = analyzeCacheEfficiency(reordered);

    // Efficiency score doesn't change (same content), but ordering improves cache prefix
    assert.equal(beforeEfficiency.cacheEfficiency, afterEfficiency.cacheEfficiency);

    // Verify static sections come first (after preamble + UNIT heading which is dynamic)
    const outputTemplateIdx = reordered.indexOf("## Output Template");
    const workingDirIdx = reordered.indexOf("## Working Directory");
    const backingIdx = reordered.indexOf("## Backing Source Artifacts");

    // Semi-static sections come after static
    const decisionsIdx = reordered.indexOf("## Decisions");
    const requirementsIdx = reordered.indexOf("## Requirements");
    const sliceIdx = reordered.indexOf("## Slice Plan Excerpt");

    // Dynamic sections come last
    const taskPlanIdx = reordered.indexOf("## Inlined Task Plan");
    const resumeIdx = reordered.indexOf("## Resume State");
    const verifyIdx = reordered.indexOf("## Verification");

    // Static before semi-static
    assert.ok(outputTemplateIdx < decisionsIdx, "Static before semi-static");
    assert.ok(workingDirIdx < sliceIdx, "Static before semi-static");
    assert.ok(backingIdx < requirementsIdx, "Static before semi-static");

    // Semi-static before dynamic
    assert.ok(decisionsIdx < taskPlanIdx, "Semi-static before dynamic");
    assert.ok(requirementsIdx < resumeIdx, "Semi-static before dynamic");
    assert.ok(sliceIdx < verifyIdx, "Semi-static before dynamic");

    // Preamble still first
    assert.ok(
      reordered.startsWith("You are executing GSD auto-mode."),
      "Preamble preserved at start",
    );
  });
});

// ─── S03 heading classifications ─────────────────────────────────────────────

describe("reorderForCaching: S03 heading classifications", () => {
  it("classifies 'Context Manifest' as semi-static", () => {
    const prompt = [
      "## Inlined Task Plan",
      "Dynamic task content.",
      "",
      "## Context Manifest",
      "| File | Purpose | Size |",
      "| `plan.md` | Slice plan | 2K |",
      "",
      "## Output Template",
      "Static template.",
    ].join("\n");

    const result = reorderForCaching(prompt);
    const staticIdx = result.indexOf("## Output Template");
    const semiIdx = result.indexOf("## Context Manifest");
    const dynamicIdx = result.indexOf("## Inlined Task Plan");

    assert.ok(staticIdx < semiIdx, "Static 'Output Template' before semi-static 'Context Manifest'");
    assert.ok(semiIdx < dynamicIdx, "Semi-static 'Context Manifest' before dynamic 'Inlined Task Plan'");
  });

  it("classifies 'Carry-Forward Context' as dynamic", () => {
    const prompt = [
      "## Carry-Forward Context",
      "Prior task summary content.",
      "",
      "## Decisions",
      "Semi-static decisions.",
      "",
      "## Output Template",
      "Static template.",
    ].join("\n");

    const result = reorderForCaching(prompt);
    const staticIdx = result.indexOf("## Output Template");
    const semiIdx = result.indexOf("## Decisions");
    const dynamicIdx = result.indexOf("## Carry-Forward Context");

    assert.ok(staticIdx < semiIdx, "Static before semi-static");
    assert.ok(semiIdx < dynamicIdx, "Semi-static before dynamic 'Carry-Forward Context'");
  });

  it("Context Manifest groups with other semi-static sections", () => {
    const prompt = [
      "## Inlined Task Plan",
      "Task content.",
      "",
      "## Context Manifest",
      "Manifest content.",
      "",
      "## Slice Plan Excerpt",
      "Slice content.",
      "",
      "## Carry-Forward Context",
      "Carry-forward content.",
    ].join("\n");

    const result = reorderForCaching(prompt);
    const manifestIdx = result.indexOf("## Context Manifest");
    const sliceIdx = result.indexOf("## Slice Plan Excerpt");
    const taskIdx = result.indexOf("## Inlined Task Plan");
    const carryIdx = result.indexOf("## Carry-Forward Context");

    // Both semi-static sections come before both dynamic sections
    assert.ok(manifestIdx < taskIdx, "Semi-static Context Manifest before dynamic Task Plan");
    assert.ok(sliceIdx < carryIdx, "Semi-static Slice Plan before dynamic Carry-Forward");
  });
});
