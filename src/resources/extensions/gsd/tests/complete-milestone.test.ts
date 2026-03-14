import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createTestContext } from './test-helpers.ts';
import { clearPathCache } from '../paths.ts';
import { invalidateStateCache } from '../state.ts';

// loadPrompt reads from ~/.gsd/agent/extensions/gsd/prompts/ (main checkout).
// In a worktree the file may not exist there yet, so we resolve prompts
// relative to this test file's location (the worktree copy).
const __dirname = dirname(fileURLToPath(import.meta.url));
const worktreePromptsDir = join(__dirname, "..", "prompts");

const { assertEq, assertTrue, report } = createTestContext();
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

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {

  // ─── Prompt Template Loading ───────────────────────────────────────────
  console.log("\n=== complete-milestone prompt template exists ===");
  {
    let result: string;
    let threw = false;
    try {
      result = loadPromptFromWorktree("complete-milestone", {
        milestoneId: "M001",
        milestoneTitle: "Test Milestone",
        roadmapPath: ".gsd/milestones/M001/M001-ROADMAP.md",
        inlinedContext: "test context block",
      });
    } catch (err) {
      threw = true;
      result = "";
      console.error(`  ERROR: loadPrompt threw: ${err}`);
    }

    assertTrue(!threw, "loadPrompt does not throw for complete-milestone");
    assertTrue(typeof result === "string" && result.length > 0, "loadPrompt returns a non-empty string");
  }

  // ─── Variable Substitution ─────────────────────────────────────────────
  console.log("\n=== prompt variable substitution ===");
  {
    const prompt = loadPromptFromWorktree("complete-milestone", {
      milestoneId: "M001",
      milestoneTitle: "Integration Feature",
      roadmapPath: ".gsd/milestones/M001/M001-ROADMAP.md",
      inlinedContext: "--- inlined slice summaries and context ---",
    });

    assertTrue(prompt.includes("M001"), "prompt contains milestoneId 'M001'");
    assertTrue(prompt.includes("Integration Feature"), "prompt contains milestoneTitle");
    assertTrue(prompt.includes(".gsd/milestones/M001/M001-ROADMAP.md"), "prompt contains roadmapPath");
    assertTrue(prompt.includes("--- inlined slice summaries and context ---"), "prompt contains inlinedContext");
    assertTrue(!prompt.includes("{{milestoneId}}"), "no un-substituted {{milestoneId}}");
    assertTrue(!prompt.includes("{{milestoneTitle}}"), "no un-substituted {{milestoneTitle}}");
    assertTrue(!prompt.includes("{{roadmapPath}}"), "no un-substituted {{roadmapPath}}");
    assertTrue(!prompt.includes("{{inlinedContext}}"), "no un-substituted {{inlinedContext}}");
  }

  // ─── Prompt Content Integrity ──────────────────────────────────────────
  console.log("\n=== prompt content integrity ===");
  {
    const prompt = loadPromptFromWorktree("complete-milestone", {
      milestoneId: "M002",
      milestoneTitle: "Completion Workflow",
      roadmapPath: ".gsd/milestones/M002/M002-ROADMAP.md",
      inlinedContext: "context",
    });

    assertTrue(prompt.includes("Complete Milestone"), "prompt contains 'Complete Milestone' heading");
    assertTrue(prompt.includes("success criter") || prompt.includes("success criteria"), "prompt mentions success criteria verification");
    assertTrue(prompt.includes("milestone-summary") || prompt.includes("milestoneSummary"), "prompt references milestone summary artifact");
    assertTrue(prompt.includes("Milestone M002 complete"), "prompt contains completion sentinel for M002");
  }

  // ─── diagnoseExpectedArtifact behavior ─────────────────────────────────
  // Since diagnoseExpectedArtifact is not exported from auto.ts, we test
  // the same logic by reimplementing the switch case for complete-milestone
  // and verifying against known path patterns.
  console.log("\n=== diagnoseExpectedArtifact logic for complete-milestone ===");
  {
    // Import the path helpers used by diagnoseExpectedArtifact
    const { relMilestoneFile } = await import("../paths.ts");

    // Simulate diagnoseExpectedArtifact("complete-milestone", "M001", base) logic
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001\n\n## Slices\n- [x] **S01: Done** \`risk:low\` \`depends:[]\`\n  > After this: done\n`);

      const unitType = "complete-milestone";
      const unitId = "M001";
      const parts = unitId.split("/");
      const mid = parts[0]!;

      // This is the exact logic from diagnoseExpectedArtifact for "complete-milestone"
      const result = `${relMilestoneFile(base, mid, "SUMMARY")} (milestone summary)`;

      assertTrue(typeof result === "string", "diagnose returns a string");
      assertTrue(result.includes("SUMMARY"), "diagnose result mentions SUMMARY");
      assertTrue(result.includes("milestone"), "diagnose result mentions milestone");
      assertTrue(result.includes("M001"), "diagnose result includes the milestone ID");
    } finally {
      cleanup(base);
    }
  }

  // ─── deriveState integration: completing-milestone dispatches correctly ─
  console.log("\n=== deriveState completing-milestone integration ===");
  {
    const { deriveState, isMilestoneComplete, invalidateStateCache } = await import("../state.ts");
    const { parseRoadmap } = await import("../files.ts");

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
      assertTrue(isMilestoneComplete(roadmap), "isMilestoneComplete returns true when all slices are [x]");

      // Verify deriveState returns completing-milestone phase
      const state = await deriveState(base);
      assertEq(state.phase, "completing-milestone", "deriveState returns completing-milestone when all slices done, no summary");
      assertEq(state.activeMilestone?.id, "M001", "active milestone is M001");
      assertEq(state.activeSlice, null, "no active slice in completing-milestone");

      // Now add the summary and verify it transitions to complete
      writeMilestoneSummary(base, "M001", "# M001 Summary\n\nDone.");
      clearPathCache();
      invalidateStateCache();
      const stateAfter = await deriveState(base);
      assertEq(stateAfter.phase, "complete", "deriveState returns complete after summary exists");
      assertEq(stateAfter.registry[0]?.status, "complete", "registry shows complete status");
    } finally {
      cleanup(base);
    }
  }

  report();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
