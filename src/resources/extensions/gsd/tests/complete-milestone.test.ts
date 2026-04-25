import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { invalidateAllCaches } from '../cache.ts';
import { parseUnitId } from "../unit-id.ts";
import { openDatabase, closeDatabase, insertMilestone, insertSlice, insertTask } from "../gsd-db.ts";
import { clearPathCache } from "../paths.ts";
import { clearParseCache } from "../files.ts";

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

// ─── Fixture Helpers ───────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-complete-ms-test-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function writeRoadmap(base: string, mid: string, content: string): void {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-ROADMAP.md`), content);
}

function writeMilestoneSummary(base: string, mid: string, content: string): void {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-SUMMARY.md`), content);
}

function writeMilestoneValidation(base: string, mid: string, verdict: string = "pass"): void {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-VALIDATION.md`), `---\nverdict: ${verdict}\nremediation_round: 0\n---\n\n# Validation\nValidated.`);
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("complete-milestone", () => {

  test("prompt template exists and loads", () => {
    let result: string;
    let threw = false;
    try {
      result = loadPromptFromWorktree("complete-milestone", {
        workingDirectory: "/tmp/test-project",
        milestoneId: "M001",
        milestoneTitle: "Test Milestone",
        roadmapPath: ".gsd/milestones/M001/M001-ROADMAP.md",
        inlinedContext: "test context block",
      });
    } catch (err) {
      threw = true;
      result = "";
    }

    assert.ok(!threw, "loadPrompt does not throw for complete-milestone");
    assert.ok(typeof result === "string" && result.length > 0, "loadPrompt returns a non-empty string");
  });

  test("prompt variable substitution", () => {
    const prompt = loadPromptFromWorktree("complete-milestone", {
      workingDirectory: "/tmp/test-project",
      milestoneId: "M001",
      milestoneTitle: "Integration Feature",
      roadmapPath: ".gsd/milestones/M001/M001-ROADMAP.md",
      inlinedContext: "--- inlined slice summaries and context ---",
    });

    assert.ok(prompt.includes("M001"), "prompt contains milestoneId 'M001'");
    assert.ok(prompt.includes("Integration Feature"), "prompt contains milestoneTitle");
    assert.ok(prompt.includes(".gsd/milestones/M001/M001-ROADMAP.md"), "prompt contains roadmapPath");
    assert.ok(prompt.includes("--- inlined slice summaries and context ---"), "prompt contains inlinedContext");
    assert.ok(!prompt.includes("{{milestoneId}}"), "no un-substituted {{milestoneId}}");
    assert.ok(!prompt.includes("{{milestoneTitle}}"), "no un-substituted {{milestoneTitle}}");
    assert.ok(!prompt.includes("{{roadmapPath}}"), "no un-substituted {{roadmapPath}}");
    assert.ok(!prompt.includes("{{inlinedContext}}"), "no un-substituted {{inlinedContext}}");
  });

  test("prompt content integrity", () => {
    const prompt = loadPromptFromWorktree("complete-milestone", {
      workingDirectory: "/tmp/test-project",
      milestoneId: "M002",
      milestoneTitle: "Completion Workflow",
      roadmapPath: ".gsd/milestones/M002/M002-ROADMAP.md",
      inlinedContext: "context",
    });

    assert.ok(prompt.includes("Complete Milestone"), "prompt contains 'Complete Milestone' heading");
    assert.ok(prompt.includes("success criter") || prompt.includes("success criteria"), "prompt mentions success criteria verification");
    assert.ok(prompt.includes("milestone-summary") || prompt.includes("milestoneSummary"), "prompt references milestone summary artifact");
    assert.ok(prompt.includes("Milestone M002 complete"), "prompt contains completion sentinel for M002");
  });

  test("prompt contains verification gate that blocks completion on failure", () => {
    const prompt = loadPromptFromWorktree("complete-milestone", {
      workingDirectory: "/tmp/test-project",
      milestoneId: "M001",
      milestoneTitle: "Gate Test",
      roadmapPath: ".gsd/milestones/M001/M001-ROADMAP.md",
      inlinedContext: "context",
    });

    // Verification gate section must exist
    assert.ok(
      prompt.includes("Verification Gate"),
      "prompt contains 'Verification Gate' section",
    );

    // Failure path must block gsd_complete_milestone
    assert.ok(
      prompt.includes("Do NOT call `gsd_complete_milestone`"),
      "failure path explicitly blocks calling the completion tool",
    );

    // Failure path must have its own sentinel distinct from success
    assert.ok(
      prompt.includes("verification FAILED"),
      "failure path outputs a FAILED sentinel",
    );

    // verificationPassed parameter must be referenced
    assert.ok(
      prompt.includes("verificationPassed"),
      "prompt references verificationPassed parameter",
    );
  });

  test("handleCompleteMilestone rejects when verificationPassed is false", async () => {
    const { handleCompleteMilestone } = await import("../tools/complete-milestone.ts");
    const base = createFixtureBase();
    try {
      const result = await handleCompleteMilestone({
        milestoneId: "M001",
        title: "Test Milestone",
        oneLiner: "Test",
        narrative: "Test narrative",
        successCriteriaResults: "None met",
        definitionOfDoneResults: "Incomplete",
        requirementOutcomes: "None validated",
        keyDecisions: [],
        keyFiles: [],
        lessonsLearned: [],
        followUps: "",
        deviations: "",
        verificationPassed: false,
      }, base);

      assert.ok("error" in result, "returns error when verificationPassed is false");
      assert.ok(
        (result as { error: string }).error.includes("verification did not pass"),
        "error message mentions verification did not pass",
      );
    } finally {
      cleanup(base);
    }
  });

  test("handleCompleteMilestone rejects when verificationPassed is omitted", async () => {
    const { handleCompleteMilestone } = await import("../tools/complete-milestone.ts");
    const base = createFixtureBase();
    try {
      // Simulate omitted verificationPassed (undefined coerced via any)
      const params: any = {
        milestoneId: "M001",
        title: "Test Milestone",
        oneLiner: "Test",
        narrative: "Test narrative",
        successCriteriaResults: "Results",
        definitionOfDoneResults: "Done results",
        requirementOutcomes: "Outcomes",
        keyDecisions: [],
        keyFiles: [],
        lessonsLearned: [],
        followUps: "",
        deviations: "",
        // verificationPassed intentionally omitted
      };
      const result = await handleCompleteMilestone(params, base);

      assert.ok("error" in result, "returns error when verificationPassed is omitted");
      assert.ok(
        (result as { error: string }).error.includes("verification did not pass"),
        "error message mentions verification did not pass",
      );
    } finally {
      cleanup(base);
    }
  });

  test("diagnoseExpectedArtifact logic for complete-milestone", async () => {
    // Import the path helpers used by diagnoseExpectedArtifact
    const { relMilestoneFile } = await import("../paths.ts");

    // Simulate diagnoseExpectedArtifact("complete-milestone", "M001", base) logic
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001\n\n## Slices\n- [x] **S01: Done** \`risk:low\` \`depends:[]\`\n  > After this: done\n`);

      const unitType = "complete-milestone";
      const unitId = "M001";
      const { milestone: mid } = parseUnitId(unitId);

      // This is the exact logic from diagnoseExpectedArtifact for "complete-milestone"
      const result = `${relMilestoneFile(base, mid, "SUMMARY")} (milestone summary)`;

      assert.ok(typeof result === "string", "diagnose returns a string");
      assert.ok(result.includes("SUMMARY"), "diagnose result mentions SUMMARY");
      assert.ok(result.includes("milestone"), "diagnose result mentions milestone");
      assert.ok(result.includes("M001"), "diagnose result includes the milestone ID");
    } finally {
      cleanup(base);
    }
  });

  test("step 11 specifies write tool for PROJECT.md update (#2946)", () => {
    const prompt = loadPromptFromWorktree("complete-milestone", {
      workingDirectory: "/tmp/test-project",
      milestoneId: "M001",
      milestoneTitle: "Tool Guidance Test",
      roadmapPath: ".gsd/milestones/M001/M001-ROADMAP.md",
      inlinedContext: "context",
      milestoneSummaryPath: ".gsd/milestones/M001/M001-SUMMARY.md",
      skillActivation: "",
    });

    // Step 11 must explicitly name the `write` tool so the LLM doesn't
    // confuse it with `edit` (which requires path + oldText + newText).
    // See: https://github.com/gsd-build/gsd-2/issues/2946
    assert.ok(
      /PROJECT\.md.*\bwrite\b/i.test(prompt) || /\bwrite\b.*PROJECT\.md/i.test(prompt),
      "step 11 must name the `write` tool when updating PROJECT.md",
    );

    // The prompt must NOT leave tool choice ambiguous for PROJECT.md
    // Verify it mentions the required parameter (`content` or `path`)
    assert.ok(
      prompt.includes("`.gsd/PROJECT.md`") || prompt.includes('".gsd/PROJECT.md"'),
      "step 11 must reference the PROJECT.md path explicitly",
    );
  });

  test("sanitizeCompleteMilestoneParams normalizes string parameters", async () => {
    const { sanitizeCompleteMilestoneParams } = await import("../bootstrap/sanitize-complete-milestone.ts");

    // Simulate params as they might arrive from the SDK after partial JSON parse:
    // - numbers instead of strings
    // - null instead of arrays
    // - extra whitespace in strings
    // - undefined optional fields
    const raw: any = {
      milestoneId: "  M011 ",
      title: 42,                              // number instead of string
      oneLiner: "  One-liner with spaces  ",
      narrative: "# Big markdown\n\nWith newlines and `backticks`\n\n```ts\ncode();\n```\n",
      successCriteriaResults: null,            // null instead of string
      definitionOfDoneResults: undefined,      // undefined instead of string
      requirementOutcomes: 12345,              // number instead of string
      keyDecisions: "not an array",            // string instead of array
      keyFiles: null,                          // null instead of array
      lessonsLearned: [" lesson one ", null, "", "  lesson two  "],
      followUps: "  follow up  ",
      deviations: undefined,
      verificationPassed: "true",             // string instead of boolean
    };

    const sanitized = sanitizeCompleteMilestoneParams(raw);

    // String fields are trimmed and coerced
    assert.strictEqual(sanitized.milestoneId, "M011");
    assert.strictEqual(sanitized.title, "42");
    assert.strictEqual(sanitized.oneLiner, "One-liner with spaces");
    assert.ok(sanitized.narrative.includes("# Big markdown"), "narrative preserves markdown");
    assert.strictEqual(sanitized.successCriteriaResults, "");
    assert.strictEqual(sanitized.definitionOfDoneResults, "");
    assert.strictEqual(sanitized.requirementOutcomes, "12345");

    // Array fields are normalized
    assert.ok(Array.isArray(sanitized.keyDecisions), "keyDecisions is an array");
    assert.deepStrictEqual(sanitized.keyDecisions, []);
    assert.ok(Array.isArray(sanitized.keyFiles), "keyFiles is an array");
    assert.deepStrictEqual(sanitized.keyFiles, []);
    assert.deepStrictEqual(sanitized.lessonsLearned, ["lesson one", "lesson two"]);

    // Optional fields — toStr() returns "" for undefined/null
    assert.strictEqual(sanitized.followUps, "follow up");
    assert.strictEqual(sanitized.deviations, "");

    // Boolean coercion
    assert.strictEqual(sanitized.verificationPassed, true);
  });

  test("sanitizeCompleteMilestoneParams handles large markdown content", async () => {
    const { sanitizeCompleteMilestoneParams } = await import("../bootstrap/sanitize-complete-milestone.ts");

    // Generate a large markdown string (~25k characters to exceed the 23667 position from the bug)
    const largeMd = "# Milestone Summary\n\n" +
      Array.from({ length: 500 }, (_, i) =>
        `## Section ${i}\n\n` +
        `- [x] Task ${i} completed with \`code\` and **bold** text\n` +
        `  - Sub-item with special chars: <, >, &, ", '\n` +
        `  - Another sub-item: \`\`\`ts\nconst x = ${i};\n\`\`\`\n`
      ).join("\n");

    assert.ok(largeMd.length > 23667, `generated markdown is ${largeMd.length} chars, must exceed 23667`);

    const raw: any = {
      milestoneId: "M011",
      title: "Content Depth, Narrative & Onboarding",
      oneLiner: "Large milestone with many slices",
      narrative: largeMd,
      successCriteriaResults: largeMd,
      definitionOfDoneResults: largeMd,
      requirementOutcomes: largeMd,
      keyDecisions: ["decision 1", "decision 2"],
      keyFiles: ["file1.ts", "file2.ts"],
      lessonsLearned: ["lesson 1"],
      followUps: "Some follow-ups",
      deviations: "Some deviations",
      verificationPassed: true,
    };

    const sanitized = sanitizeCompleteMilestoneParams(raw);

    // Large content should pass through without truncation or corruption
    assert.strictEqual(sanitized.narrative, largeMd.trim());
    assert.strictEqual(sanitized.successCriteriaResults, largeMd.trim());
    assert.strictEqual(sanitized.definitionOfDoneResults, largeMd.trim());
    assert.strictEqual(sanitized.requirementOutcomes, largeMd.trim());
  });

  test("milestoneCompleteExecute uses sanitized params", async () => {
    // This test verifies that the execute function sanitizes params before passing
    // to handleCompleteMilestone. We test indirectly: if we pass numeric milestoneId,
    // the handler should still receive a string (and return a meaningful error, not a crash).
    const { handleCompleteMilestone } = await import("../tools/complete-milestone.ts");
    const { sanitizeCompleteMilestoneParams } = await import("../bootstrap/sanitize-complete-milestone.ts");
    const base = createFixtureBase();
    try {
      // Simulate what milestoneCompleteExecute should do: sanitize then call handler
      const raw: any = {
        milestoneId: 42,           // number — would crash without sanitization
        title: "Test",
        oneLiner: "Test",
        narrative: "Test narrative",
        successCriteriaResults: "Results",
        definitionOfDoneResults: "Done",
        requirementOutcomes: "Outcomes",
        keyDecisions: null,        // null — would crash .length without sanitization
        keyFiles: "not-array",     // string — would crash .map without sanitization
        lessonsLearned: undefined, // undefined — would crash .map without sanitization
        followUps: "",
        deviations: "",
        verificationPassed: true,
      };

      const sanitized = sanitizeCompleteMilestoneParams(raw);

      // Verify sanitization didn't crash and produced valid typed params
      assert.strictEqual(typeof sanitized.milestoneId, "string", "milestoneId is a string after sanitization");
      assert.ok(Array.isArray(sanitized.keyDecisions), "keyDecisions is array after sanitization");
      assert.ok(Array.isArray(sanitized.keyFiles), "keyFiles is array after sanitization");
      assert.ok(Array.isArray(sanitized.lessonsLearned), "lessonsLearned is array after sanitization");
      assert.strictEqual(typeof sanitized.verificationPassed, "boolean", "verificationPassed is boolean after sanitization");

      // Calling handleCompleteMilestone may throw GSD_STALE_STATE (no DB in test env)
      // but it should NOT throw TypeError from type mismatches — that's the bug fix.
      try {
        await handleCompleteMilestone(sanitized, base);
      } catch (err: any) {
        // GSD_STALE_STATE or "No database open" is acceptable — it means we got past
        // the type-sensitive code and failed on DB access, which is expected in tests.
        assert.ok(
          err.code === "GSD_STALE_STATE" || err.message?.includes("database"),
          `expected DB error, got: ${err.message}`,
        );
      }
    } finally {
      cleanup(base);
    }
  });

  test("handleCompleteMilestone does not overwrite existing SUMMARY.md on re-dispatch (#4598)", async () => {
    // This test verifies that when SUMMARY.md already exists (from a prior completion),
    // re-calling handleCompleteMilestone does not overwrite it.
    // Before the fix this test FAILS because the handler unconditionally writes SUMMARY.md.
    const { handleCompleteMilestone } = await import("../tools/complete-milestone.ts");
    const base = createFixtureBase();
    const mid = "M001";
    const dbPath = join(base, ".gsd", "gsd.db");
    try {
      // Set up DB with milestone and a complete slice + task
      openDatabase(dbPath);
      insertMilestone({ id: mid, title: "Test Milestone", status: "active" });
      insertSlice({ id: "S01", milestoneId: mid, title: "Slice One", status: "complete" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: mid, title: "Task One", status: "complete" });

      // Pre-write an existing SUMMARY.md to simulate a prior completion
      const milestoneDir = join(base, ".gsd", "milestones", mid);
      mkdirSync(milestoneDir, { recursive: true });
      const summaryPath = join(milestoneDir, `${mid}-SUMMARY.md`);
      const originalContent = "original content — must not be overwritten";
      writeFileSync(summaryPath, originalContent, "utf-8");

      // Call handleCompleteMilestone — this is the re-dispatch scenario
      const params = {
        milestoneId: mid,
        title: "Test Milestone",
        oneLiner: "Re-dispatched",
        narrative: "This is a re-dispatch",
        successCriteriaResults: "Met",
        definitionOfDoneResults: "Done",
        requirementOutcomes: "Covered",
        keyDecisions: [],
        keyFiles: [],
        lessonsLearned: [],
        followUps: "",
        deviations: "",
        verificationPassed: true,
      };

      const result = await handleCompleteMilestone(params, base);

      // The call may return an error (milestone already complete) or success
      // but in either case the SUMMARY.md must NOT be overwritten.
      const actualContent = readFileSync(summaryPath, "utf-8");
      assert.strictEqual(
        actualContent,
        originalContent,
        "existing SUMMARY.md must not be overwritten on re-dispatch (#4598)",
      );
    } finally {
      try { closeDatabase(); } catch { /* */ }
      clearPathCache();
      clearParseCache();
      cleanup(base);
    }
  });

  test("deriveState completing-milestone integration", async () => {
    const { deriveState, isMilestoneComplete } = await import("../state.ts");
    const { invalidateAllCaches: invalidateAllCachesDynamic } = await import("../cache.ts");
    const { parseRoadmap } = await import("../parsers-legacy.ts");

    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: Integration Test

**Vision:** Test completing-milestone flow.

## Slices

- [x] **S01: Slice One** \`risk:low\` \`depends:[]\`
  > After this: done.

- [x] **S02: Slice Two** \`risk:low\` \`depends:[S01]\`
  > After this: done.
`);

      // Verify isMilestoneComplete returns true
      const { loadFile } = await import("../files.ts");
      const roadmapPath = join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
      const roadmapContent = await loadFile(roadmapPath);
      const roadmap = parseRoadmap(roadmapContent!);
      assert.ok(isMilestoneComplete(roadmap), "isMilestoneComplete returns true when all slices are [x]");

      // Verify deriveState returns completing-milestone phase (with validation already done)
      writeMilestoneValidation(base, "M001");
      const state = await deriveState(base);
      assert.strictEqual(state.phase, "completing-milestone", "deriveState returns completing-milestone when all slices done, no summary");
      assert.strictEqual(state.activeMilestone?.id, "M001", "active milestone is M001");
      assert.strictEqual(state.activeSlice, null, "no active slice in completing-milestone");

      // Now add the summary and verify it transitions to complete
      writeMilestoneSummary(base, "M001", "# M001 Summary\n\nDone.");
      invalidateAllCachesDynamic();
      const stateAfter = await deriveState(base);
      assert.strictEqual(stateAfter.phase, "complete", "deriveState returns complete after summary exists");
      assert.strictEqual(stateAfter.registry[0]?.status, "complete", "registry shows complete status");
    } finally {
      cleanup(base);
    }
  });
});
