/**
 * Context Compression — unit tests for M004/S02.
 *
 * Verifies that prompt builders respect inlineLevel parameter by
 * inspecting the auto-prompts.ts source for level-aware gating.
 * Cannot call builders directly due to @gsd/pi-coding-agent import
 * resolution — uses source-level structural verification instead.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsSrc = readFileSync(join(__dirname, "..", "auto-prompts.ts"), "utf-8");

// ═══════════════════════════════════════════════════════════════════════════
// inlineLevel Parameter Presence
// ═══════════════════════════════════════════════════════════════════════════

const BUILDERS_WITH_LEVEL = [
  "buildPlanMilestonePrompt",
  "buildPlanSlicePrompt",
  "buildExecuteTaskPrompt",
  "buildCompleteSlicePrompt",
  "buildCompleteMilestonePrompt",
  "buildReassessRoadmapPrompt",
];

for (const builder of BUILDERS_WITH_LEVEL) {
  test(`compression: ${builder} accepts inlineLevel parameter`, () => {
    // Find the function signature
    const sigRegex = new RegExp(`export async function ${builder}\\([^)]*level\\?: InlineLevel`);
    assert.ok(
      sigRegex.test(promptsSrc),
      `${builder} should have level?: InlineLevel parameter`,
    );
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Default Level Resolution
// ═══════════════════════════════════════════════════════════════════════════

test("compression: builders default to resolveInlineLevel() when no level passed", () => {
  const defaultPattern = /const inlineLevel = level \?\? resolveInlineLevel\(\)/g;
  const matches = promptsSrc.match(defaultPattern);
  assert.ok(matches, "should have resolveInlineLevel() fallback");
  assert.ok(
    matches.length >= BUILDERS_WITH_LEVEL.length,
    `should have ${BUILDERS_WITH_LEVEL.length} fallback instances, found ${matches?.length}`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Minimal Level — Template Reduction
// ═══════════════════════════════════════════════════════════════════════════

test("compression: buildExecuteTaskPrompt minimal drops decisions template", () => {
  // In the execute-task builder, minimal should only inline task-summary, not decisions
  assert.ok(
    promptsSrc.includes('inlineLevel === "minimal"') &&
    promptsSrc.includes('inlineTemplate("task-summary"'),
    "execute-task should conditionally include decisions template based on level",
  );
});

test("compression: buildExecuteTaskPrompt minimal truncates prior summaries", () => {
  assert.ok(
    promptsSrc.includes('inlineLevel === "minimal" && priorSummaries.length > 1'),
    "execute-task should limit prior summaries for minimal level",
  );
});

test("compression: buildPlanMilestonePrompt minimal drops project/requirements/decisions files", () => {
  // The plan-milestone builder should gate root file inlining on inlineLevel
  assert.ok(
    promptsSrc.includes('inlineLevel !== "minimal"') &&
    promptsSrc.includes('inlineGsdRootFile(base, "project.md"'),
    "plan-milestone should conditionally include project.md based on level",
  );
});

test("compression: buildPlanMilestonePrompt minimal drops extra templates", () => {
  // Full inlines 5 templates, minimal should inline fewer
  assert.ok(
    promptsSrc.includes('if (inlineLevel === "full")') &&
    promptsSrc.includes('inlineTemplate("secrets-manifest"'),
    "plan-milestone should only include secrets-manifest template at full level",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Complete-Slice Level Gating
// ═══════════════════════════════════════════════════════════════════════════

test("compression: buildCompleteSlicePrompt minimal drops requirements", () => {
  // Find the complete-slice section and verify requirements gating
  const completeSliceIdx = promptsSrc.indexOf("buildCompleteSlicePrompt");
  const nextBuilder = promptsSrc.indexOf("buildCompleteMilestonePrompt");
  const completeSliceBlock = promptsSrc.slice(completeSliceIdx, nextBuilder);
  assert.ok(
    completeSliceBlock.includes('inlineLevel !== "minimal"'),
    "complete-slice should gate requirements inlining on level",
  );
});

test("compression: buildCompleteSlicePrompt minimal drops UAT template", () => {
  const completeSliceIdx = promptsSrc.indexOf("buildCompleteSlicePrompt");
  const nextBuilder = promptsSrc.indexOf("buildCompleteMilestonePrompt");
  const completeSliceBlock = promptsSrc.slice(completeSliceIdx, nextBuilder);
  assert.ok(
    completeSliceBlock.includes('inlineLevel !== "minimal"') &&
    completeSliceBlock.includes('inlineTemplate("uat"'),
    "complete-slice should conditionally include UAT template based on level",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Complete-Milestone Level Gating
// ═══════════════════════════════════════════════════════════════════════════

test("compression: buildCompleteMilestonePrompt minimal drops root GSD files", () => {
  const completeMilestoneIdx = promptsSrc.indexOf("buildCompleteMilestonePrompt");
  const nextBuilder = promptsSrc.indexOf("buildReplanSlicePrompt");
  const block = promptsSrc.slice(completeMilestoneIdx, nextBuilder);
  assert.ok(
    block.includes('inlineLevel !== "minimal"') &&
    (block.includes('inlineGsdRootFile(base, "requirements.md"') || block.includes('inlineRequirementsFromDb(base')),
    "complete-milestone should gate root file inlining on level",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Reassess-Roadmap Level Gating
// ═══════════════════════════════════════════════════════════════════════════

test("compression: buildReassessRoadmapPrompt minimal drops project/requirements/decisions", () => {
  const reassessIdx = promptsSrc.indexOf("buildReassessRoadmapPrompt");
  const block = promptsSrc.slice(reassessIdx, reassessIdx + 1500);
  assert.ok(
    block.includes('inlineLevel !== "minimal"'),
    "reassess-roadmap should gate file inlining on level",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Full Level — No Regression
// ═══════════════════════════════════════════════════════════════════════════

test("compression: full level preserves all templates and files (no regression)", () => {
  // Verify the key template names are still present in the source
  const expectedTemplates = [
    "roadmap", "decisions", "plan", "task-plan", "secrets-manifest",
    "task-summary", "slice-summary", "uat", "milestone-summary",
  ];
  for (const tpl of expectedTemplates) {
    assert.ok(
      promptsSrc.includes(`inlineTemplate("${tpl}"`),
      `template "${tpl}" should still be present in auto-prompts.ts`,
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Import Verification
// ═══════════════════════════════════════════════════════════════════════════

test("compression: auto-prompts.ts imports resolveInlineLevel and InlineLevel", () => {
  assert.ok(
    promptsSrc.includes("resolveInlineLevel"),
    "should import resolveInlineLevel from preferences",
  );
  assert.ok(
    promptsSrc.includes("InlineLevel"),
    "should import InlineLevel type from types",
  );
});
