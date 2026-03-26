import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { invalidateAllCaches } from '../cache.ts';
import { parseUnitId } from "../unit-id.ts";

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
