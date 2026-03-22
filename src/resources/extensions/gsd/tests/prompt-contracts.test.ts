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

test("discuss prompt allows implementation questions when they materially matter", () => {
  const prompt = readPrompt("discuss");
  assert.match(prompt, /Lead with experience, but ask implementation when it materially matters/i);
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
});

test("guided-resume-task prompt preserves recovery state until work is superseded", () => {
  const prompt = readPrompt("guided-resume-task");
  assert.match(prompt, /Do \*\*not\*\* delete the continue file immediately/i);
  assert.match(prompt, /successfully completed or you have written a newer summary\/continue artifact/i);
  assert.doesNotMatch(prompt, /Delete the continue file after reading it/i);
});

test("execute-task prompt includes tool selection guidelines to prevent hangs", () => {
  const prompt = readPrompt("execute-task");
  // Verify the tool selection guidelines section exists
  assert.match(prompt, /## Tool Selection Guidelines/i);
  
  // Verify bash is recommended for quick commands
  assert.match(prompt, /Use `bash` for quick commands that complete in <10 seconds/i);
  
  // Verify async_bash is recommended for long-running commands
  assert.match(prompt, /Use `async_bash` for commands that take 10\+ seconds/i);
  assert.match(prompt, /Follow with `await_job` to get the result/i);
  
  // Verify bg_shell is recommended for indefinite processes
  assert.match(prompt, /Use `bg_shell` for processes that run indefinitely/i);
  assert.match(prompt, /dev servers, watchers, daemons/i);
  
  // Verify the warning about bash & is present
  assert.match(prompt, /Never use `bash` with `&` — it causes hangs/i);
  assert.match(prompt, /stream inheritance/i);
  
  // Verify bg_shell is recommended over bash >/dev/null 2>&1 &
  assert.match(prompt, /Use `bg_shell` instead/i);
});
