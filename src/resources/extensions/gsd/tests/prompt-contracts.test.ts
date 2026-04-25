import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const promptsDir = join(process.cwd(), "src/resources/extensions/gsd/prompts");

function readPrompt(name: string): string {
  return readFileSync(join(promptsDir, `${name}.md`), "utf-8");
}

test("reactive-execute prompt keeps task summaries with subagents and avoids batch commits", () => {
  const prompt = readPrompt("reactive-execute");
  assert.match(prompt, /subagent-written summary as authoritative/i);
  assert.match(prompt, /Do NOT create a batch commit/i);
  assert.doesNotMatch(prompt, /\*\*Write task summaries\*\*/i);
  assert.doesNotMatch(prompt, /\*\*Commit\*\* all changes/i);
});

test("run-uat prompt branches on dynamic UAT mode and supports runtime evidence", () => {
  const prompt = readPrompt("run-uat");
  assert.match(prompt, /\*\*Detected UAT mode:\*\*\s*`\{\{uatType\}\}`/);
  assert.match(prompt, /uatType:\s*\{\{uatType\}\}/);
  assert.match(prompt, /live-runtime/);
  assert.match(prompt, /browser\/runtime\/network/i);
  assert.match(prompt, /NEEDS-HUMAN/);
  assert.doesNotMatch(prompt, /uatType:\s*artifact-driven/);
});

test("workflow-start prompt defaults to autonomy instead of per-phase confirmation", () => {
  const prompt = readPrompt("workflow-start");
  assert.match(prompt, /Keep moving by default/i);
  assert.match(prompt, /Decision gates, not ceremony/i);
  assert.doesNotMatch(prompt, /confirm with the user before proceeding/i);
  assert.doesNotMatch(prompt, /Gate between phases/i);
});

test("system prompt references CODEBASE.md and /gsd codebase", () => {
  const prompt = readPrompt("system");
  assert.match(prompt, /CODEBASE\.md/);
  assert.match(prompt, /\/gsd codebase \[generate\|update\|stats\]/);
  assert.match(prompt, /auto-refreshes it when tracked files change/i);
});

test("system prompt hard rules forbid fabricating user responses", () => {
  const prompt = readPrompt("system");
  assert.match(prompt, /never fabricate, simulate, or role-play user responses/i);
  assert.match(prompt, /never generate markers like `?\[User\]`?, `?\[Human\]`?, `?User:`?/i);
  assert.match(prompt, /ask one question round \(1-3 questions\), then stop and wait for the user's actual response/i);
  assert.match(prompt, /ask_user_questions.*only valid structured user input/i);
});

test("discuss prompt allows implementation questions when they materially matter", () => {
  const prompt = readPrompt("discuss");
  assert.match(prompt, /Lead with experience, but ask implementation when it materially matters/i);
  assert.match(prompt, /Never fabricate, simulate, or role-play user responses/i);
  assert.match(prompt, /Ask one question round \(1-3 questions\) per turn, then stop and wait for the user's actual response/i);
  assert.match(prompt, /one gate, not two/i);
  assert.doesNotMatch(prompt, /Questions must be about the experience, not the implementation/i);
});

test("guided discussion prompts avoid wrap-up prompts after every round", () => {
  const milestonePrompt = readPrompt("guided-discuss-milestone");
  const slicePrompt = readPrompt("guided-discuss-slice");
  assert.match(milestonePrompt, /Do \*\*not\*\* ask a meta "ready to wrap up\?" question after every round/i);
  assert.match(slicePrompt, /Do \*\*not\*\* ask a meta "ready to wrap up\?" question after every round/i);
  assert.doesNotMatch(milestonePrompt, /I think I have a solid picture of this milestone\. Ready to wrap up/i);
  assert.doesNotMatch(slicePrompt, /I think I have a solid picture of this slice\. Ready to wrap up/i);
  assert.match(milestonePrompt, /Never fabricate or simulate user input/i);
  assert.match(slicePrompt, /Never fabricate or simulate user input/i);
});

test("guided milestone discussion scopes depth verification to the milestone id", () => {
  const prompt = readPrompt("guided-discuss-milestone");
  assert.match(prompt, /depth_verification_\{\{milestoneId\}\}/, "depth verification id should include the milestone id");
  assert.doesNotMatch(prompt, /depth_verification_confirm" — this enables the write-gate downstream/i, "legacy global depth gate wording should be gone");
});

test("queue prompt requires waiting for user response between rounds", () => {
  const prompt = readPrompt("queue");
  assert.match(prompt, /Never fabricate or simulate user input during this discussion/i);
  assert.match(prompt, /Ask 1-3 questions per round, then wait for the user's response before asking the next round\./i);
  assert.doesNotMatch(prompt, /treat that as permission to continue/i);
});

test("guided-resume-task prompt preserves recovery state until work is superseded", () => {
  const prompt = readPrompt("guided-resume-task");
  assert.match(prompt, /Do \*\*not\*\* delete the continue file immediately/i);
  assert.match(prompt, /successfully completed or you have written a newer summary\/continue artifact/i);
  assert.doesNotMatch(prompt, /Delete the continue file after reading it/i);
});

// ─── Prompt migration: execute-task → gsd_complete_task ───────────────

test("execute-task prompt references gsd_complete_task tool", () => {
  const prompt = readPrompt("execute-task");
  assert.match(prompt, /gsd_complete_task/);
});

test("execute-task prompt uses gsd_complete_task as canonical summary write path", () => {
  const prompt = readPrompt("execute-task");
  assert.match(prompt, /\{\{taskSummaryPath\}\}/);
  assert.match(prompt, /gsd_complete_task/);
  assert.match(prompt, /DB-backed tool is the canonical write path/i);
  assert.match(prompt, /Do \*\*not\*\* manually write `?\{\{taskSummaryPath\}\}`?/i);
  assert.doesNotMatch(prompt, /^\d+\.\s+Write `?\{\{taskSummaryPath\}\}`?\s*$/m);
});

test("execute-task prompt does not instruct LLM to toggle checkboxes manually", () => {
  const prompt = readPrompt("execute-task");
  assert.doesNotMatch(prompt, /change \[ \] to \[x\]/);
  assert.doesNotMatch(prompt, /Mark \{\{taskId\}\} done in/);
});

test("execute-task prompt still contains template variables for context", () => {
  const prompt = readPrompt("execute-task");
  assert.match(prompt, /\{\{taskSummaryPath\}\}/);
  assert.match(prompt, /\{\{planPath\}\}/);
});

test("guided-execute-task prompt references gsd_task_complete tool", () => {
  const prompt = readPrompt("guided-execute-task");
  assert.match(prompt, /gsd_task_complete/);
});

test("guided-execute-task prompt does not instruct manual file write", () => {
  const prompt = readPrompt("guided-execute-task");
  assert.doesNotMatch(prompt, /Write `?\{\{taskId\}\}-SUMMARY\.md`?.*mark it done/i);
});

// ─── Prompt migration: complete-slice → gsd_complete_slice ────────────

test("complete-slice prompt references gsd_complete_slice tool", () => {
  const prompt = readPrompt("complete-slice");
  assert.match(prompt, /gsd_complete_slice/);
});

test("complete-slice prompt does not instruct LLM to toggle checkboxes manually", () => {
  const prompt = readPrompt("complete-slice");
  assert.doesNotMatch(prompt, /change \[ \] to \[x\]/);
});

test("guided-complete-slice prompt references gsd_slice_complete tool", () => {
  const prompt = readPrompt("guided-complete-slice");
  assert.match(prompt, /gsd_slice_complete/);
});

test("complete-slice prompt instructs writing summary and UAT files before tool call", () => {
  const prompt = readPrompt("complete-slice");
  assert.match(prompt, /\{\{sliceSummaryPath\}\}/);
  assert.match(prompt, /\{\{sliceUatPath\}\}/);
  assert.match(prompt, /gsd_complete_slice/);
  assert.match(prompt, /DB-backed tool is the canonical write path/i);
  assert.match(prompt, /Do \*\*not\*\* manually write `?\{\{sliceSummaryPath\}\}`?/i);
  assert.match(prompt, /Do \*\*not\*\* manually write `?\{\{sliceUatPath\}\}`?/i);
  assert.doesNotMatch(prompt, /^\d+\.\s+Write `?\{\{sliceSummaryPath\}\}`?.*$/m);
  assert.doesNotMatch(prompt, /^\d+\.\s+Write `?\{\{sliceUatPath\}\}`?.*$/m);
});

test("complete-slice prompt preserves decisions and knowledge review steps", () => {
  const prompt = readPrompt("complete-slice");
  assert.match(prompt, /DECISIONS\.md/);
  assert.match(prompt, /KNOWLEDGE\.md/);
});

test("validate-milestone prompt uses gsd_validate_milestone as canonical validation write path", () => {
  const prompt = readPrompt("validate-milestone");
  assert.match(prompt, /gsd_validate_milestone/);
  assert.match(prompt, /\{\{validationPath\}\}/);
  assert.match(prompt, /DB-backed tool is the canonical write path/i);
  assert.match(prompt, /Do \*\*not\*\* manually write `?\{\{validationPath\}\}`?/i);
  assert.doesNotMatch(prompt, /Write to `?\{\{validationPath\}\}`?:/i);
});

test("complete-slice prompt still contains template variables for context", () => {
  const prompt = readPrompt("complete-slice");
  assert.match(prompt, /\{\{sliceSummaryPath\}\}/);
  assert.match(prompt, /\{\{sliceUatPath\}\}/);
});

test("plan-milestone prompt references DB-backed planning tool and explicitly forbids manual roadmap writes", () => {
  const prompt = readPrompt("plan-milestone");
  assert.match(prompt, /gsd_plan_milestone/);
  assert.match(prompt, /Do \*\*not\*\* write `?\{\{outputPath\}\}`?, `?ROADMAP\.md`?, or other planning artifacts manually/i);
});

test("guided-plan-milestone prompt references DB-backed planning tool and explicitly forbids manual roadmap writes", () => {
  const prompt = readPrompt("guided-plan-milestone");
  assert.match(prompt, /gsd_plan_milestone/);
  assert.match(prompt, /Do \*\*not\*\* write `?\{\{milestoneId\}\}-ROADMAP\.md`?, `?ROADMAP\.md`?, or other planning artifacts manually/i);
});

test("plan-slice prompt no longer frames direct PLAN writes as the source of truth", () => {
  const prompt = readPrompt("plan-slice");
  assert.match(prompt, /Do \*\*not\*\* rely on direct `PLAN\.md` writes as the source of truth/i);
});

test("plan-slice prompt explicitly names gsd_plan_slice as DB-backed planning tool", () => {
  const prompt = readPrompt("plan-slice");
  assert.match(prompt, /gsd_plan_slice/);
  assert.match(prompt, /gsd_plan_task/);
  // The prompt should describe the DB-backed tool as the canonical write path
  assert.match(prompt, /DB-backed tool is the canonical write path/i);
});

test("plan-slice prompt does not instruct direct file writes as a primary step", () => {
  const prompt = readPrompt("plan-slice");
  // Should not instruct to "Write {{outputPath}}" as a primary step — tools handle rendering
  assert.doesNotMatch(prompt, /^\d+\.\s+Write `?\{\{outputPath\}\}`?\s*$/m);
});

test("plan-slice prompt clarifies gsd_plan_slice handles task persistence", () => {
  const prompt = readPrompt("plan-slice");
  // gsd_plan_slice persists tasks in its transaction — no separate gsd_plan_task calls needed
  assert.match(prompt, /gsd_plan_task/);
  assert.match(prompt, /gsd_plan_slice` handles task persistence/i);
});

test("replan-slice prompt uses gsd_replan_slice as canonical DB-backed tool", () => {
  const prompt = readPrompt("replan-slice");
  assert.match(prompt, /gsd_replan_slice/);
  // Degraded fallback (direct file writes) was removed — DB tools are always available
  assert.doesNotMatch(prompt, /Degraded fallback/i);
});

// ─── ADR-011 refine-slice prompt contracts ────────────────────────────

test("refine-slice prompt names gsd_plan_slice as the DB-backed write path", () => {
  const prompt = readPrompt("refine-slice");
  assert.match(prompt, /gsd_plan_slice/, "refine-slice must call gsd_plan_slice to persist");
});

test("refine-slice prompt does not instruct direct PLAN.md writes", () => {
  const prompt = readPrompt("refine-slice");
  assert.match(
    prompt,
    /do NOT rely on direct `PLAN\.md` writes/i,
    "refine-slice must not frame direct file writes as authoritative",
  );
});

test("refine-slice prompt frames the unit as a transformation, not blank-sheet planning", () => {
  const prompt = readPrompt("refine-slice");
  // The framing language is load-bearing — the model should treat this as
  // expanding an approved sketch, not planning from scratch.
  assert.match(prompt, /expands an approved sketch/i);
  assert.match(prompt, /Sketch Scope/);
});

test("reassess-roadmap prompt references gsd_reassess_roadmap tool", () => {
  const prompt = readPrompt("reassess-roadmap");
  assert.match(prompt, /gsd_reassess_roadmap/);
});

test("validate-milestone prompt dispatches parallel reviewers", () => {
  const prompt = readPrompt("validate-milestone");
  assert.match(prompt, /Reviewer A/);
  assert.match(prompt, /Reviewer B/);
  assert.match(prompt, /Reviewer C/);
  assert.match(prompt, /Requirements Coverage/);
  assert.match(prompt, /Cross-Slice Integration/);
  assert.match(prompt, /Assessment & Acceptance Criteria/);
  assert.match(prompt, /assessment evidence/i);
});

// ─── Prompt migration: replan-slice → gsd_replan_slice ────────────────

test("replan-slice prompt names gsd_replan_slice as the tool to use", () => {
  const prompt = readPrompt("replan-slice");
  assert.match(prompt, /gsd_replan_slice/);
});

// ─── Prompt migration: reassess-roadmap → gsd_reassess_roadmap ───────

test("reassess-roadmap prompt names gsd_reassess_roadmap as the tool to use", () => {
  const prompt = readPrompt("reassess-roadmap");
  assert.match(prompt, /gsd_reassess_roadmap/);
});

// ─── Bug #2933: prompt parameter names must match camelCase TypeBox schema ───

test("execute-task prompt uses camelCase parameter names matching TypeBox schema", () => {
  const prompt = readPrompt("execute-task");
  // The gsd_complete_task tool schema uses camelCase: milestoneId, sliceId, taskId
  // Prompts must NOT tell the LLM to use snake_case (milestone_id, slice_id, task_id)
  const toolCallLine = prompt.split("\n").find((l) => /gsd_complete_task/.test(l) || /gsd_task_complete/.test(l));
  assert.ok(toolCallLine, "prompt must contain a gsd_complete_task or gsd_task_complete tool call line");
  assert.doesNotMatch(toolCallLine!, /milestone_id/, "must use milestoneId, not milestone_id");
  assert.doesNotMatch(toolCallLine!, /slice_id/, "must use sliceId, not slice_id");
  assert.doesNotMatch(toolCallLine!, /task_id/, "must use taskId, not task_id");
  // Positive: must mention the camelCase names
  assert.match(toolCallLine!, /milestoneId/);
  assert.match(toolCallLine!, /sliceId/);
  assert.match(toolCallLine!, /taskId/);
});

test("complete-slice prompt uses camelCase parameter names matching TypeBox schema", () => {
  const prompt = readPrompt("complete-slice");
  // The gsd_complete_slice tool schema uses camelCase: milestoneId, sliceId
  const toolCallLine = prompt.split("\n").find((l) => /gsd_complete_slice/.test(l) || /gsd_slice_complete/.test(l));
  assert.ok(toolCallLine, "prompt must contain a gsd_complete_slice or gsd_slice_complete tool call line");
  assert.doesNotMatch(toolCallLine!, /milestone_id/, "must use milestoneId, not milestone_id");
  assert.doesNotMatch(toolCallLine!, /slice_id/, "must use sliceId, not slice_id");
  // Positive: must mention the camelCase names
  assert.match(toolCallLine!, /milestoneId/);
  assert.match(toolCallLine!, /sliceId/);
});

// ─── File system safety: complete-slice parity with complete-milestone (#2935) ──

test("complete-slice prompt includes filesystem safety guard against EISDIR", () => {
  const prompt = readPrompt("complete-slice");
  assert.match(
    prompt,
    /File system safety/i,
    "complete-slice.md must include a 'File system safety' instruction to prevent EISDIR errors when the LLM passes a directory path to the read tool"
  );
  assert.match(
    prompt,
    /never pass.*directory path.*directly to the.*read.*tool/i,
    "complete-slice.md must warn against passing directory paths to the read tool"
  );
});

test("complete-milestone prompt still has its filesystem safety guard (regression)", () => {
  const prompt = readPrompt("complete-milestone");
  assert.match(
    prompt,
    /File system safety/i,
    "complete-milestone.md must keep its filesystem safety guard"
  );
});

test("reactive-execute prompt references tool calls instead of checkbox updates", () => {
  const prompt = readPrompt("reactive-execute");
  assert.doesNotMatch(prompt, /checkbox updates/);
  assert.doesNotMatch(prompt, /checkbox edits/);
  assert.match(prompt, /completion tool calls/);
});
