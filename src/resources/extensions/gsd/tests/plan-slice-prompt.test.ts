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
  skillActivation: "Load the relevant skills.",
};

const DEFAULT_SKILL_ACTIVATION = "If a `GSD Skill Preferences` block is present in system context, use it and the `<available_skills>` catalog in your system prompt to decide which skills to load and follow for this unit, without relaxing required verification or artifact rules.";

function loadPromptWithDefaultSkillActivation(name: string, vars: Record<string, string> = {}): string {
  return loadPrompt(name, { skillActivation: DEFAULT_SKILL_ACTIVATION, ...vars });
}

function promptUsesSkillActivation(name: string): boolean {
  const path = join(worktreePromptsDir, `${name}.md`);
  const content = readFileSync(path, "utf-8");
  return content.includes("{{skillActivation}}");
}

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

test("plan-slice prompt: DB-backed tool names survive template substitution", () => {
  const result = loadPrompt("plan-slice", { ...BASE_VARS, commitInstruction: "Do not commit." });
  assert.ok(result.includes("gsd_plan_slice"), "gsd_plan_slice should appear in rendered prompt");
  assert.ok(result.includes("gsd_plan_task"), "gsd_plan_task should appear in rendered prompt");
  assert.ok(result.includes("canonical write path"), "canonical write path language should survive substitution");
});

test("plan-slice prompt: footer references gsd_plan_slice tool, not direct write", () => {
  const result = loadPrompt("plan-slice", { ...BASE_VARS, commitInstruction: "Do not commit." });
  assert.ok(
    result.includes("MUST call `gsd_plan_slice`"),
    "footer should instruct calling gsd_plan_slice tool",
  );
  assert.ok(
    !result.includes("MUST write the file"),
    "footer should not instruct direct file write",
  );
});

test("domain-work prompts use skillActivation placeholder", () => {
  const prompts = [
    "research-milestone",
    "plan-milestone",
    "research-slice",
    "plan-slice",
    "execute-task",
    "guided-research-slice",
    "guided-plan-milestone",
    "guided-plan-slice",
    "guided-execute-task",
    "guided-resume-task",
  ];

  for (const name of prompts) {
    assert.ok(promptUsesSkillActivation(name), `${name}.md should contain {{skillActivation}}`);
  }
});

test("skillActivation default leaves no unresolved placeholder", () => {
  const result = loadPromptWithDefaultSkillActivation("execute-task", {
    workingDirectory: "/tmp/test-project",
    milestoneId: "M001",
    sliceId: "S01",
    sliceTitle: "Test Slice",
    taskId: "T01",
    taskTitle: "Implement feature",
    planPath: ".gsd/milestones/M001/slices/S01/S01-PLAN.md",
    taskPlanPath: ".gsd/milestones/M001/slices/S01/tasks/T01-PLAN.md",
    taskPlanInline: "Task plan",
    slicePlanExcerpt: "Slice excerpt",
    carryForwardSection: "Carry forward",
    resumeSection: "Resume",
    priorTaskLines: "- (no prior tasks)",
    taskSummaryPath: "/tmp/test-project/.gsd/milestones/M001/slices/S01/tasks/T01-SUMMARY.md",
    inlinedTemplates: "Template",
    verificationBudget: "~10K chars",
    overridesSection: "",
  });

  assert.ok(!result.includes("{{skillActivation}}"));
  assert.ok(result.includes(DEFAULT_SKILL_ACTIVATION));
});

test("custom skillActivation is substituted into execute-task", () => {
  const result = loadPrompt("execute-task", {
    workingDirectory: "/tmp/test-project",
    milestoneId: "M001",
    sliceId: "S01",
    sliceTitle: "Test Slice",
    taskId: "T01",
    taskTitle: "Implement feature",
    planPath: ".gsd/milestones/M001/slices/S01/S01-PLAN.md",
    taskPlanPath: ".gsd/milestones/M001/slices/S01/tasks/T01-PLAN.md",
    taskPlanInline: "Task plan",
    slicePlanExcerpt: "Slice excerpt",
    carryForwardSection: "Carry forward",
    resumeSection: "Resume",
    priorTaskLines: "- (no prior tasks)",
    taskSummaryPath: "/tmp/test-project/.gsd/milestones/M001/slices/S01/tasks/T01-SUMMARY.md",
    inlinedTemplates: "Template",
    verificationBudget: "~10K chars",
    overridesSection: "",
    skillActivation: "Load React and accessibility skills first.",
  });

  assert.ok(result.includes("Load React and accessibility skills first."));
  assert.ok(!result.includes("{{skillActivation}}"));
});

test("guided execute prompt substitutes skillActivation", () => {
  const result = loadPrompt("guided-execute-task", {
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    taskTitle: "Implement feature",
    inlinedTemplates: "Template",
    skillActivation: "Load React skill first.",
  });

  assert.ok(result.includes("Load React skill first."));
  assert.ok(!result.includes("{{skillActivation}}"));
});

test("guided resume prompt substitutes skillActivation", () => {
  const result = loadPrompt("guided-resume-task", {
    milestoneId: "M001",
    sliceId: "S01",
    skillActivation: "Load debugging skill first.",
  });

  assert.ok(result.includes("Load debugging skill first."));
  assert.ok(!result.includes("{{skillActivation}}"));
});

test("research-milestone prompt substitutes skillActivation", () => {
  const result = loadPrompt("research-milestone", {
    workingDirectory: "/tmp/test-project",
    milestoneId: "M001",
    milestoneTitle: "Test Milestone",
    milestonePath: ".gsd/milestones/M001",
    contextPath: ".gsd/milestones/M001/M001-CONTEXT.md",
    outputPath: "/tmp/test-project/.gsd/milestones/M001/M001-RESEARCH.md",
    inlinedContext: "Context",
    skillDiscoveryMode: "manual",
    skillDiscoveryInstructions: " Discover skills manually.",
    skillActivation: "Load research skills first.",
  });

  assert.ok(result.includes("Load research skills first."));
  assert.ok(!result.includes("{{skillActivation}}"));
});

test("research-milestone prompt references gsd_summary_save, not direct write", () => {
  const result = loadPrompt("research-milestone", {
    workingDirectory: "/tmp/test-project",
    milestoneId: "M001",
    milestoneTitle: "Test Milestone",
    milestonePath: ".gsd/milestones/M001",
    contextPath: ".gsd/milestones/M001/M001-CONTEXT.md",
    outputPath: "/tmp/test-project/.gsd/milestones/M001/M001-RESEARCH.md",
    inlinedContext: "Context",
    skillDiscoveryMode: "manual",
    skillDiscoveryInstructions: " Discover skills manually.",
    skillActivation: "Load research skills first.",
  });

  assert.ok(
    result.includes("gsd_summary_save"),
    "research-milestone should reference gsd_summary_save tool",
  );
  assert.ok(
    result.includes('artifact_type: "RESEARCH"'),
    "research-milestone should specify RESEARCH artifact type",
  );
  assert.ok(
    !result.includes("MUST write the file"),
    "research-milestone should not instruct direct file write",
  );
});

test("research-slice prompt substitutes skillActivation", () => {
  const result = loadPrompt("research-slice", {
    workingDirectory: "/tmp/test-project",
    milestoneId: "M001",
    sliceId: "S01",
    sliceTitle: "Test Slice",
    slicePath: ".gsd/milestones/M001/slices/S01",
    roadmapPath: ".gsd/milestones/M001/M001-ROADMAP.md",
    contextPath: ".gsd/milestones/M001/M001-CONTEXT.md",
    milestoneResearchPath: ".gsd/milestones/M001/M001-RESEARCH.md",
    outputPath: "/tmp/test-project/.gsd/milestones/M001/slices/S01/S01-RESEARCH.md",
    inlinedContext: "Context",
    dependencySummaries: "",
    skillDiscoveryMode: "manual",
    skillDiscoveryInstructions: " Discover skills manually.",
    skillActivation: "Load slice research skills first.",
  });

  assert.ok(result.includes("Load slice research skills first."));
  assert.ok(!result.includes("{{skillActivation}}"));
});

test("plan-milestone prompt substitutes skillActivation", () => {
  const result = loadPrompt("plan-milestone", {
    workingDirectory: "/tmp/test-project",
    milestoneId: "M001",
    milestoneTitle: "Test Milestone",
    milestonePath: ".gsd/milestones/M001",
    contextPath: ".gsd/milestones/M001/M001-CONTEXT.md",
    researchPath: ".gsd/milestones/M001/M001-RESEARCH.md",
    researchOutputPath: "/tmp/test-project/.gsd/milestones/M001/M001-RESEARCH.md",
    outputPath: "/tmp/test-project/.gsd/milestones/M001/M001-ROADMAP.md",
    secretsOutputPath: "/tmp/test-project/.gsd/milestones/M001/M001-SECRETS.md",
    inlinedContext: "Context",
    sourceFilePaths: "- source",
    skillDiscoveryMode: "manual",
    skillDiscoveryInstructions: " Discover skills manually.",
    skillActivation: "Load milestone planning skills first.",
  });

  assert.ok(result.includes("Load milestone planning skills first."));
  assert.ok(!result.includes("{{skillActivation}}"));
});

test("guided plan milestone prompt substitutes skillActivation", () => {
  const result = loadPrompt("guided-plan-milestone", {
    milestoneId: "M001",
    milestoneTitle: "Test Milestone",
    secretsOutputPath: ".gsd/milestones/M001/M001-SECRETS.md",
    inlinedTemplates: "Templates",
    skillActivation: "Load guided planning skills first.",
  });

  assert.ok(result.includes("Load guided planning skills first."));
  assert.ok(!result.includes("{{skillActivation}}"));
});

test("guided plan slice prompt substitutes skillActivation", () => {
  const result = loadPrompt("guided-plan-slice", {
    milestoneId: "M001",
    sliceId: "S01",
    sliceTitle: "Test Slice",
    inlinedTemplates: "Templates",
    skillActivation: "Load guided slice planning skills first.",
  });

  assert.ok(result.includes("Load guided slice planning skills first."));
  assert.ok(!result.includes("{{skillActivation}}"));
});

test("guided research slice prompt substitutes skillActivation", () => {
  const result = loadPrompt("guided-research-slice", {
    milestoneId: "M001",
    sliceId: "S01",
    sliceTitle: "Test Slice",
    inlinedTemplates: "Templates",
    skillActivation: "Load guided research skills first.",
  });

  assert.ok(result.includes("Load guided research skills first."));
  assert.ok(!result.includes("{{skillActivation}}"));
});
