import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const worktreePromptsDir = join(__dirname, "..", "prompts");

function loadPrompt(name: string, vars: Record<string, string> = {}): string {
  const path = join(worktreePromptsDir, `${name}.md`);
  let content = readFileSync(path, "utf-8");
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  return content.trim();
}

const BASE_VARS = {
  workingDirectory: "/tmp/test-project",
  milestoneId: "M001", sliceId: "S01", sliceTitle: "Test Slice",
  slicePath: ".gsd/milestones/M001/slices/S01",
  roadmapPath: ".gsd/milestones/M001/M001-ROADMAP.md",
  researchPath: ".gsd/milestones/M001/slices/S01/S01-RESEARCH.md",
  outputPath: "/tmp/test-project/.gsd/milestones/M001/slices/S01/S01-PLAN.md",
  inlinedContext: "--- test inlined context ---",
  dependencySummaries: "", executorContextConstraints: "",
  sourceFilePaths: "- **Requirements**: `.gsd/REQUIREMENTS.md`",
};

test("plan-slice prompt: commit instruction says do not commit (external state)", () => {
  const result = loadPrompt("plan-slice", { ...BASE_VARS, commitInstruction: "Do not commit planning artifacts — .gsd/ is managed externally." });
  assert.ok(result.includes("Do not commit planning artifacts"));
  assert.ok(!result.includes("{{commitInstruction}}"));
});

test("plan-slice prompt: all variables substituted", () => {
  const result = loadPrompt("plan-slice", { ...BASE_VARS, commitInstruction: "Commit: `docs(S01): add slice plan`" });
  assert.ok(!result.includes("{{"));
  assert.ok(result.includes("M001"));
  assert.ok(result.includes("S01"));
});
