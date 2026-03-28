import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPrompt } from "../prompt-loader.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = join(__dirname, "..", "prompts");

function safeRender(name: string, vars: Record<string, string>): string {
  let content = readFileSync(join(promptsDir, `${name}.md`), "utf-8");
  const effectiveVars = {
    skillActivation: "If a `GSD Skill Preferences` block is present in system context, use it and the `<available_skills>` catalog in your system prompt to decide which skills to load and follow for this unit, without relaxing required verification or artifact rules.",
    ...vars,
  };

  for (const [key, value] of Object.entries(effectiveVars)) {
    content = content.split(`{{${key}}}`).join(value);
  }

  return content.trim();
}

test("loadPrompt treats replacement values literally", () => {
  const slicePlanExcerpt = [
    "## Verification",
    "- grep -q '^0$' file.txt",
    "- printf '$&'",
    "- printf '$`'",
  ].join("\n");

  const vars = {
    workingDirectory: "/tmp/test-project",
    milestoneId: "M001",
    sliceId: "S01",
    sliceTitle: "Prompt loader regression",
    taskId: "T01",
    taskTitle: "Render prompt safely",
    planPath: ".gsd/milestones/M001/slices/S01/S01-PLAN.md",
    taskPlanPath: ".gsd/milestones/M001/slices/S01/tasks/T01-PLAN.md",
    taskPlanInline: "## Task Plan\n- implement the fix",
    slicePlanExcerpt,
    carryForwardSection: "Carry forward context",
    resumeSection: "Resume context",
    runtimeContext: "",
    priorTaskLines: "- (no prior tasks)",
    taskSummaryPath: ".gsd/milestones/M001/slices/S01/tasks/T01-SUMMARY.md",
    inlinedTemplates: "Template",
    verificationBudget: "~10K chars",
    overridesSection: "",
  };

  const rendered = loadPrompt("execute-task", vars);
  const expected = safeRender("execute-task", vars);

  assert.equal(rendered, expected);
  assert.ok(rendered.includes("grep -q '^0$' file.txt"));
  assert.ok(rendered.includes("printf '$&'"));
  assert.ok(rendered.includes("printf '$`'"));
});
