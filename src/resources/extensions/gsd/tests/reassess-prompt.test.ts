import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// loadPrompt reads from ~/.gsd/agent/extensions/gsd/prompts/ (main checkout).
// In a worktree the file may not exist there yet, so we resolve prompts
// relative to this test file's location (the worktree copy).
const __dirname = dirname(fileURLToPath(import.meta.url));
const worktreePromptsDir = join(__dirname, "..", "prompts");

/**
 * Load a prompt template from the worktree prompts directory
 * and apply variable substitution (mirrors loadPrompt logic).
 */
function loadPromptFromWorktree(name: string, vars: Record<string, string> = {}): string {
  const path = join(worktreePromptsDir, `${name}.md`);
  let content = readFileSync(path, "utf-8");
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  return content.trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

  // ─── reassess-roadmap prompt loads and substitutes ─────────────────────

describe('reassess-prompt', () => {
test('reassess-roadmap prompt loads and substitutes', () => {
    const testVars = {
      workingDirectory: "/tmp/test-project",
      milestoneId: "M099",
      completedSliceId: "S03",
      assessmentPath: ".gsd/milestones/M099/slices/S03/S03-ASSESSMENT.md",
      roadmapPath: ".gsd/milestones/M099/M099-ROADMAP.md",
      inlinedContext: "--- test inlined context block ---",
    };

    let result: string;
    let threw = false;
    try {
      result = loadPromptFromWorktree("reassess-roadmap", testVars);
    } catch (err) {
      threw = true;
      result = "";
      console.error(`  ERROR: loadPrompt threw: ${err}`);
    }

    assert.ok(!threw, "loadPrompt does not throw for reassess-roadmap");
    assert.ok(typeof result === "string" && result.length > 0, "loadPrompt returns a non-empty string");

    // Verify all test variables were substituted into the output
    assert.ok(result.includes("M099"), "prompt contains milestoneId 'M099'");
    assert.ok(result.includes("S03"), "prompt contains completedSliceId 'S03'");
    assert.ok(result.includes(".gsd/milestones/M099/slices/S03/S03-ASSESSMENT.md"), "prompt contains assessmentPath");
    assert.ok(result.includes(".gsd/milestones/M099/M099-ROADMAP.md"), "prompt contains roadmapPath");
    assert.ok(result.includes("--- test inlined context block ---"), "prompt contains inlinedContext");

    // Verify no un-substituted variables remain
    assert.ok(!result.includes("{{milestoneId}}"), "no un-substituted {{milestoneId}}");
    assert.ok(!result.includes("{{completedSliceId}}"), "no un-substituted {{completedSliceId}}");
    assert.ok(!result.includes("{{assessmentPath}}"), "no un-substituted {{assessmentPath}}");
    assert.ok(!result.includes("{{roadmapPath}}"), "no un-substituted {{roadmapPath}}");
    assert.ok(!result.includes("{{inlinedContext}}"), "no un-substituted {{inlinedContext}}");
});

  // ─── reassess-roadmap contains coverage-check instruction ─────────────
test('reassess-roadmap contains coverage-check instruction', () => {
    const prompt = loadPromptFromWorktree("reassess-roadmap", {
      workingDirectory: "/tmp/test-project",
      milestoneId: "M001",
      completedSliceId: "S01",
      assessmentPath: ".gsd/milestones/M001/slices/S01/S01-ASSESSMENT.md",
      roadmapPath: ".gsd/milestones/M001/M001-ROADMAP.md",
      inlinedContext: "context",
    });

    // Normalize to lowercase for case-insensitive matching
    const lower = prompt.toLowerCase();

    // The prompt must mention "each success criterion" or "every success criterion"
    assert.ok(
      lower.includes("each success criterion") || lower.includes("every success criterion"),
      "prompt contains 'each success criterion' or 'every success criterion'"
    );

    // The prompt must mention "owning slice" or "remaining slice"
    assert.ok(
      lower.includes("owning slice") || lower.includes("remaining slice"),
      "prompt contains 'owning slice' or 'remaining slice'"
    );

    // The prompt must mention "no remaining owner" or "no owner" or "no slice"
    assert.ok(
      lower.includes("no remaining owner") || lower.includes("no owner") || lower.includes("no slice"),
      "prompt contains 'no remaining owner', 'no owner', or 'no slice'"
    );

    // The prompt must mention "blocking issue" or "blocking"
    assert.ok(
      lower.includes("blocking issue") || lower.includes("blocking"),
      "prompt contains 'blocking issue' or 'blocking'"
    );
});

  // ─── coverage-check requires at-least-one semantics ───────────────────
test('coverage-check requires at-least-one semantics', () => {
    const prompt = loadPromptFromWorktree("reassess-roadmap", {
      workingDirectory: "/tmp/test-project",
      milestoneId: "M001",
      completedSliceId: "S01",
      assessmentPath: ".gsd/milestones/M001/slices/S01/S01-ASSESSMENT.md",
      roadmapPath: ".gsd/milestones/M001/M001-ROADMAP.md",
      inlinedContext: "context",
    });

    const lower = prompt.toLowerCase();

    // The instruction must use "at least one" or equivalent inclusive language
    assert.ok(
      lower.includes("at least one") || lower.includes("at-least-one") || lower.includes("one or more"),
      "prompt uses 'at least one' or equivalent inclusive language for slice ownership"
    );

    // The instruction must NOT require "exactly one" — that would be too rigid
    assert.ok(
      !lower.includes("exactly one owner") && !lower.includes("exactly one slice"),
      "prompt does NOT use 'exactly one' for slice ownership (would be too rigid)"
    );
});

});
