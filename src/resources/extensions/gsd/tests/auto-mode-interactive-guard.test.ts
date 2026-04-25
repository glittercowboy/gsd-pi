/**
 * Test: auto-mode prompts must prohibit ask_user_questions / secure_env_collect
 *
 * Bug #2936: When the LLM calls ask_user_questions during auto-mode units
 * (plan-slice, execute-task, complete-slice), the interactive tool queues a
 * user response which causes the subsequent gsd_plan_slice / gsd_complete_task
 * call to fail with "Skipped due to queued user message." The canonical GSD
 * tool call is never recorded, verifyExpectedArtifact finds no artifact, and
 * the dispatch loop re-dispatches the same unit 2-4x.
 *
 * Fix: Each auto-mode prompt must contain an "Autonomous execution" guard
 * that explicitly prohibits ask_user_questions and secure_env_collect.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = join(__dirname, "..", "prompts");

function loadPromptRaw(name: string): string {
  return readFileSync(join(promptsDir, `${name}.md`), "utf-8");
}

const AUTO_MODE_PROMPTS = ["plan-slice", "execute-task", "complete-slice"];

for (const promptName of AUTO_MODE_PROMPTS) {
  test(`${promptName} prompt prohibits ask_user_questions in auto-mode`, () => {
    const content = loadPromptRaw(promptName);

    assert.ok(
      content.includes("ask_user_questions"),
      `${promptName}.md must mention ask_user_questions (to prohibit it)`,
    );

    assert.ok(
      content.includes("secure_env_collect"),
      `${promptName}.md must mention secure_env_collect (to prohibit it)`,
    );

    // The guard must clearly state this is autonomous / auto-mode
    assert.ok(
      content.toLowerCase().includes("auto-mode") || content.toLowerCase().includes("autonomous"),
      `${promptName}.md must reference auto-mode or autonomous execution`,
    );

    // The guard must indicate no human is available
    assert.ok(
      content.includes("no human") || content.includes("no user"),
      `${promptName}.md must state that no human/user is available to answer`,
    );
  });
}

test("auto-mode prompts contain autonomous guard before final tool call reminder", () => {
  for (const promptName of AUTO_MODE_PROMPTS) {
    const content = loadPromptRaw(promptName);

    // The guard should appear before the final "MUST call" line
    const guardIndex = content.indexOf("ask_user_questions");
    const mustCallIndex = content.lastIndexOf("MUST call");

    assert.ok(
      guardIndex !== -1 && mustCallIndex !== -1 && guardIndex < mustCallIndex,
      `${promptName}.md: autonomous guard (ask_user_questions prohibition) must appear before the final MUST call reminder`,
    );
  }
});
