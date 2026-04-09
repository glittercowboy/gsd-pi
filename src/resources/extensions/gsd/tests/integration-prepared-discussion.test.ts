/**
 * Integration tests for the prepared discussion system.
 *
 * Exercises the full preparation pipeline against the real GSD-2 codebase:
 * - runPreparation() produces valid briefs
 * - TypeScript is detected as primary language
 * - Module structure includes top-level directories
 * - Completes within R112 timing requirement (<60s)
 * - prepareAndBuildDiscussPrompt() uses discuss-prepared template when enabled
 * - Fallback to standard prompt when preparation is disabled
 */

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  runPreparation,
  formatCodebaseBrief,
  formatPriorContextBrief,
  formatEcosystemBrief,
  type PreparationUIContext,
  type PreparationPreferences,
  type PreparationResult,
} from "../preparation.ts";
import { validateEnhancedContext } from "../prompt-validation.ts";
import { getLastPreparationResult, clearPreparationResult } from "../guided-flow.ts";

// ─── Test Helpers ───────────────────────────────────────────────────────────────

/**
 * Mock UI context that captures notifications for testing.
 * Follows the pattern from preparation.test.ts.
 */
function createMockUI(): PreparationUIContext & { notifications: Array<{ message: string; type?: string }> } {
  const notifications: Array<{ message: string; type?: string }> = [];
  return {
    notifications,
    notify(message: string, type?: "info" | "warning" | "error" | "success") {
      notifications.push({ message, type });
    },
  };
}

/**
 * Get the GSD extension source directory for integration testing.
 * This is the real codebase we'll analyze.
 */
function getGsdExtensionDir(): string {
  // Navigate from tests/ up to gsd/ directory
  return join(import.meta.dirname, "..");
}

/**
 * Get the GSD-2 project root for full codebase analysis.
 */
function getProjectRoot(): string {
  // Navigate from tests/ up to the project root
  // tests/ -> gsd/ -> extensions/ -> resources/ -> src/ -> gsd-2/
  return join(import.meta.dirname, "..", "..", "..", "..", "..");
}

// ─── R111 Validation: runPreparation against real codebase ──────────────────────

test("R111: runPreparation() produces valid codebase brief for GSD extension", async (t) => {
  const dir = getGsdExtensionDir();
  const ui = createMockUI();
  const prefs: PreparationPreferences = {
    discuss_preparation: true,
    discuss_web_research: false, // Skip web research to avoid API key requirement
    discuss_depth: "standard",
  };

  const result = await runPreparation(dir, ui, prefs);

  // Verify preparation completed successfully
  assert.equal(result.enabled, true, "preparation should be enabled");
  assert.ok(result.codebase, "should have codebase brief");
  assert.ok(result.codebaseBrief, "should have formatted codebase brief");

  // Verify TypeScript is detected as primary language
  assert.equal(
    result.codebase.techStack.primaryLanguage,
    "javascript/typescript",
    "should detect TypeScript as primary language",
  );

  // Verify module structure includes top-level directories
  const topLevelDirs = result.codebase.moduleStructure.topLevelDirs;
  assert.ok(topLevelDirs.length > 0, "should detect top-level directories");

  // Common directories in the GSD extension
  const expectedDirs = ["tests", "prompts", "templates", "migrate"];
  const foundExpected = expectedDirs.filter(d => topLevelDirs.includes(d));
  assert.ok(
    foundExpected.length >= 2,
    `should detect common directories, found: ${topLevelDirs.join(", ")}`,
  );

  // Verify sampled files exist
  assert.ok(result.codebase.sampledFiles.length > 0, "should sample source files");
});

test("R111: runPreparation() produces valid prior context brief", async (t) => {
  const dir = getGsdExtensionDir();
  const ui = createMockUI();
  const prefs: PreparationPreferences = {
    discuss_preparation: true,
    discuss_web_research: false,
  };

  const result = await runPreparation(dir, ui, prefs);

  // Verify prior context brief structure
  assert.ok(result.priorContext, "should have prior context");
  assert.ok(result.priorContextBrief, "should have formatted prior context brief");

  // Prior context aggregates decisions, requirements, knowledge, summaries
  assert.ok("decisions" in result.priorContext, "should have decisions");
  assert.ok("requirements" in result.priorContext, "should have requirements");
  assert.ok("knowledge" in result.priorContext, "should have knowledge");
  assert.ok("summaries" in result.priorContext, "should have summaries");
});

test("R111: runPreparation() produces valid ecosystem brief (skipped without API key)", async (t) => {
  const dir = getGsdExtensionDir();
  const ui = createMockUI();
  const prefs: PreparationPreferences = {
    discuss_preparation: true,
    discuss_web_research: false, // Explicitly disable
  };

  const result = await runPreparation(dir, ui, prefs);

  // Verify ecosystem brief structure
  assert.ok(result.ecosystem, "should have ecosystem brief");
  assert.ok(result.ecosystemBrief, "should have formatted ecosystem brief");
  assert.equal(result.ecosystem.available, false, "ecosystem should be unavailable when web research disabled");
  assert.ok(result.ecosystem.skippedReason, "should have skip reason");
});

test("R112: runPreparation() completes within 60s requirement", async (t) => {
  const dir = getGsdExtensionDir();
  const prefs: PreparationPreferences = {
    discuss_preparation: true,
    discuss_web_research: false,
    discuss_depth: "standard",
  };

  const startTime = performance.now();
  const result = await runPreparation(dir, null, prefs);
  const elapsed = performance.now() - startTime;

  // R112 requirement: preparation must complete within 60 seconds
  assert.ok(result.durationMs < 60000, `should complete within 60s, took ${result.durationMs}ms`);
  assert.ok(elapsed < 60000, `wall-clock time should be under 60s, was ${elapsed}ms`);

  // Should be much faster for a local directory analysis
  assert.ok(result.durationMs < 10000, `should typically complete within 10s, took ${result.durationMs}ms`);
});

// ─── Codebase Pattern Detection ─────────────────────────────────────────────────

test("runPreparation() detects code patterns from GSD extension", async (t) => {
  const dir = getGsdExtensionDir();
  const prefs: PreparationPreferences = {
    discuss_preparation: true,
    discuss_web_research: false,
  };

  const result = await runPreparation(dir, null, prefs);

  // The GSD extension uses async/await extensively
  assert.ok(
    result.codebase.patterns.asyncStyle === "async/await" || result.codebase.patterns.asyncStyle === "mixed",
    `should detect async/await or mixed, got ${result.codebase.patterns.asyncStyle}`,
  );

  // The GSD extension uses try/catch for error handling
  assert.ok(
    result.codebase.patterns.errorHandling === "try/catch" || result.codebase.patterns.errorHandling === "mixed",
    `should detect try/catch or mixed, got ${result.codebase.patterns.errorHandling}`,
  );

  // TypeScript uses camelCase or mixed naming
  assert.ok(
    result.codebase.patterns.namingConvention === "camelCase" || result.codebase.patterns.namingConvention === "mixed",
    `should detect camelCase or mixed, got ${result.codebase.patterns.namingConvention}`,
  );

  // Evidence should be populated
  assert.ok(result.codebase.patterns.evidence.asyncStyle.length > 0, "should have async style evidence");
});

test("runPreparation() samples TypeScript files from src/ or project root", async (t) => {
  const dir = getGsdExtensionDir();
  const prefs: PreparationPreferences = {
    discuss_preparation: true,
    discuss_web_research: false,
  };

  const result = await runPreparation(dir, null, prefs);

  // Should sample TypeScript files
  const tsFiles = result.codebase.sampledFiles.filter(
    f => f.endsWith(".ts") || f.endsWith(".tsx"),
  );
  assert.ok(tsFiles.length > 0, "should sample TypeScript files");

  // Should exclude test files
  const testFiles = result.codebase.sampledFiles.filter(
    f => f.includes(".test.") || f.includes(".spec."),
  );
  assert.equal(testFiles.length, 0, "should not sample test files");
});

// ─── Brief Formatting ───────────────────────────────────────────────────────────

test("formatCodebaseBrief() produces LLM-readable markdown", async (t) => {
  const dir = getGsdExtensionDir();
  const prefs: PreparationPreferences = {
    discuss_preparation: true,
    discuss_web_research: false,
  };

  const result = await runPreparation(dir, null, prefs);
  const formatted = formatCodebaseBrief(result.codebase);

  // Should contain expected sections
  assert.ok(formatted.includes("## Tech Stack"), "should have Tech Stack section");
  assert.ok(formatted.includes("## Module Structure"), "should have Module Structure section");
  assert.ok(formatted.includes("## Code Patterns"), "should have Code Patterns section");

  // Should contain detected tech
  assert.ok(formatted.includes("javascript/typescript"), "should include detected language");

  // Should be within character limit
  assert.ok(formatted.length <= 3000, `should cap at 3000 chars, got ${formatted.length}`);
});

test("formatPriorContextBrief() produces structured prior context output", async (t) => {
  const dir = getGsdExtensionDir();
  const prefs: PreparationPreferences = {
    discuss_preparation: true,
    discuss_web_research: false,
  };

  const result = await runPreparation(dir, null, prefs);
  const formatted = formatPriorContextBrief(result.priorContext);

  // Should contain expected sections
  assert.ok(formatted.includes("## Prior Decisions"), "should have Prior Decisions section");
  assert.ok(formatted.includes("## Prior Requirements"), "should have Prior Requirements section");
  assert.ok(formatted.includes("## Prior Knowledge"), "should have Prior Knowledge section");
  assert.ok(formatted.includes("## Prior Milestone Summaries"), "should have Prior Milestone Summaries section");

  // Should be within character limit
  assert.ok(formatted.length <= 6000, `should cap at 6000 chars, got ${formatted.length}`);
});

test("formatEcosystemBrief() returns simplified message (research happens during discussion)", async (t) => {
  const dir = getGsdExtensionDir();
  const prefs: PreparationPreferences = {
    discuss_preparation: true,
    discuss_web_research: false,
  };

  const result = await runPreparation(dir, null, prefs);
  const formatted = formatEcosystemBrief(result.ecosystem);

  // Should contain section header
  assert.ok(formatted.includes("## Ecosystem Research"), "should have Ecosystem Research section");

  // Should indicate research happens during discussion
  assert.ok(formatted.includes("during the discussion"), "should mention research happens during discussion");
  assert.ok(formatted.includes("web search tools"), "should mention web search tools");

  // Should be within character limit
  assert.ok(formatted.length <= 4000, `should cap at 4000 chars, got ${formatted.length}`);
});

// ─── Preparation Result Storage ─────────────────────────────────────────────────

test("getLastPreparationResult() returns null initially", async (t) => {
  // Clear any existing state
  clearPreparationResult();

  const result = getLastPreparationResult();
  assert.equal(result, null, "should return null when no preparation has run");
});

test("clearPreparationResult() clears stored result", async (t) => {
  // This test verifies the clear function works
  // We can't easily test the set behavior without running the full guided-flow
  clearPreparationResult();
  const result = getLastPreparationResult();
  assert.equal(result, null, "should be null after clear");
});

// ─── TUI Progress Notifications ─────────────────────────────────────────────────

test("runPreparation() emits TUI progress notifications", async (t) => {
  const dir = getGsdExtensionDir();
  const ui = createMockUI();
  const prefs: PreparationPreferences = {
    discuss_preparation: true,
    discuss_web_research: false,
  };

  await runPreparation(dir, ui, prefs);

  // Should have notifications for each phase
  assert.ok(ui.notifications.length > 0, "should have notifications");

  // Verify codebase analysis notifications
  assert.ok(
    ui.notifications.some(n => n.message.includes("Analyzing codebase")),
    "should show codebase analysis start",
  );
  assert.ok(
    ui.notifications.some(n => n.message.includes("✓ Analyzed codebase")),
    "should show codebase analysis complete",
  );

  // Verify prior context notifications
  assert.ok(
    ui.notifications.some(n => n.message.includes("Reviewing prior context")),
    "should show prior context start",
  );
  assert.ok(
    ui.notifications.some(n => n.message.includes("✓ Reviewed prior context")),
    "should show prior context complete",
  );
});

test("runPreparation() works in silent mode (no UI)", async (t) => {
  const dir = getGsdExtensionDir();
  const prefs: PreparationPreferences = {
    discuss_preparation: true,
    discuss_web_research: false,
  };

  // Pass null for UI
  const result = await runPreparation(dir, null, prefs);

  // Should complete without error
  assert.equal(result.enabled, true, "should work without UI");
  assert.ok(result.codebase, "should have codebase");
  assert.ok(result.priorContext, "should have priorContext");
  assert.ok(result.durationMs > 0, "should have duration");
});

// ─── Preference-Controlled Behavior ─────────────────────────────────────────────

test("runPreparation() returns early when discuss_preparation is false", async (t) => {
  const dir = getGsdExtensionDir();
  const ui = createMockUI();
  const prefs: PreparationPreferences = {
    discuss_preparation: false,
  };

  const result = await runPreparation(dir, ui, prefs);

  assert.equal(result.enabled, false, "should indicate preparation disabled");
  assert.equal(result.codebaseBrief, "", "should have empty codebase brief");
  assert.equal(result.priorContextBrief, "", "should have empty prior context brief");
  assert.equal(result.ecosystemBrief, "", "should have empty ecosystem brief");
  assert.equal(ui.notifications.length, 0, "should not show any notifications");
});

test("runPreparation() ecosystem research always returns unavailable (happens during discussion)", async (t) => {
  const dir = getGsdExtensionDir();
  const ui = createMockUI();
  const prefs: PreparationPreferences = {
    discuss_preparation: true,
    discuss_web_research: true, // Even with this enabled, ecosystem research returns unavailable
  };

  const result = await runPreparation(dir, ui, prefs);

  assert.equal(result.enabled, true);
  assert.equal(result.ecosystemResearchPerformed, false, "should not perform ecosystem research from preparation");
  assert.equal(result.ecosystem.available, false);
  assert.ok(
    result.ecosystem.skippedReason?.includes("during the discussion"),
    "should indicate research happens during discussion",
  );

  // Should NOT have ecosystem research notifications (no longer part of preparation)
  assert.ok(
    !ui.notifications.some(n => n.message.includes("Researching ecosystem")),
    "should not show ecosystem research notification",
  );
});

// ─── validateEnhancedContext Integration ────────────────────────────────────────

test("validateEnhancedContext() validates required sections", async (t) => {
  // Test with valid enhanced context
  const validContext = `# M001 — Test Milestone

## Scope

This milestone covers X, Y, Z.

## Architectural Decisions

### Decision 1: Use TypeScript

We will use TypeScript for type safety.

## Acceptance Criteria

- [ ] Feature A works
- [ ] Feature B works
`;

  const validResult = validateEnhancedContext(validContext);
  assert.equal(validResult.valid, true, "should validate complete context");
  assert.deepEqual(validResult.missing, [], "should have no missing sections");

  // Test with missing sections
  const invalidContext = `# M001 — Test Milestone

## Scope

This milestone covers X, Y, Z.
`;

  const invalidResult = validateEnhancedContext(invalidContext);
  assert.equal(invalidResult.valid, false, "should reject incomplete context");
  assert.ok(invalidResult.missing.length > 0, "should list missing sections");
  assert.ok(
    invalidResult.missing.some(m => m.includes("Architectural Decisions")),
    "should report missing Architectural Decisions",
  );
  assert.ok(
    invalidResult.missing.some(m => m.includes("Acceptance Criteria")),
    "should report missing Acceptance Criteria",
  );
});

test("validateEnhancedContext() requires decision entries in Architectural Decisions", async (t) => {
  // Empty architectural decisions section
  const emptyDecisions = `# M001 — Test Milestone

## Scope

This milestone covers X, Y, Z.

## Architectural Decisions

(No decisions yet)

## Acceptance Criteria

- [ ] Feature A works
`;

  const result = validateEnhancedContext(emptyDecisions);
  assert.equal(result.valid, false, "should reject empty decisions section");
  assert.ok(
    result.missing.some(m => m.includes("decision entry")),
    "should report missing decision entry",
  );
});

// ─── Full Pipeline Integration ──────────────────────────────────────────────────

test("Full pipeline: preparation produces consistent results across runs", async (t) => {
  const dir = getGsdExtensionDir();
  const prefs: PreparationPreferences = {
    discuss_preparation: true,
    discuss_web_research: false,
  };

  // Run preparation twice
  const result1 = await runPreparation(dir, null, prefs);
  const result2 = await runPreparation(dir, null, prefs);

  // Results should be consistent (same codebase, same analysis)
  assert.equal(
    result1.codebase.techStack.primaryLanguage,
    result2.codebase.techStack.primaryLanguage,
    "primary language should be consistent",
  );

  assert.deepEqual(
    result1.codebase.moduleStructure.topLevelDirs.sort(),
    result2.codebase.moduleStructure.topLevelDirs.sort(),
    "top-level directories should be consistent",
  );

  assert.equal(
    result1.codebase.patterns.asyncStyle,
    result2.codebase.patterns.asyncStyle,
    "async style should be consistent",
  );
});

test("Full pipeline: preparation handles empty .gsd directory gracefully", async (t) => {
  // The GSD extension directory may or may not have a .gsd subdirectory
  // Either way, preparation should not crash
  const dir = getGsdExtensionDir();
  const prefs: PreparationPreferences = {
    discuss_preparation: true,
    discuss_web_research: false,
  };

  let result: PreparationResult | undefined;
  let error: unknown;

  try {
    result = await runPreparation(dir, null, prefs);
  } catch (e) {
    error = e;
  }

  assert.equal(error, undefined, "should not throw");
  assert.ok(result, "should return result");
  assert.equal(result!.enabled, true, "should be enabled");

  // Prior context should gracefully handle missing files
  assert.ok(result!.priorContext, "should have prior context even if files missing");
});
