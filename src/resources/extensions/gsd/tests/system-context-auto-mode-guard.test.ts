import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildAutoModePromptGuard,
  buildBeforeAgentStartResult,
  isAutoModePrompt,
} from "../bootstrap/system-context.ts";

test("system-context: auto-mode prompt guard is added for auto-mode prompts", () => {
  const prompt = "You are executing GSD auto-mode.\n\n## UNIT: Execute Task T01";
  const guard = buildAutoModePromptGuard(prompt);

  assert.ok(isAutoModePrompt(prompt), "auto-mode prompt should be detected");
  assert.ok(guard.includes("ask_user_questions"), "guard should block ask_user_questions");
  assert.ok(guard.includes("secure_env_collect"), "guard should block secure_env_collect");
  assert.ok(guard.includes("AUTO-MODE PROMPT GUARD"), "guard should be clearly labeled");
});

test("system-context: auto-mode prompt guard is omitted for non-auto prompts", () => {
  const prompt = "Discuss milestone M001 with the user.";

  assert.equal(isAutoModePrompt(prompt), false, "non-auto prompt should not be detected");
  assert.equal(buildAutoModePromptGuard(prompt), "", "non-auto prompt should not get a guard");
});

test("system-context: before-agent-start injects the guard into auto-mode system prompts", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-auto-guard-"));
  mkdirSync(join(tmp, ".gsd"), { recursive: true });
  const originalCwd = process.cwd();

  try {
    process.chdir(tmp);

    const result = await buildBeforeAgentStartResult(
      {
        prompt: "You are executing GSD auto-mode.\n\n## UNIT: Execute Task T01",
        systemPrompt: "BASE SYSTEM",
      },
      {
        ui: {
          notify() {},
          setStatus() {},
          setWidget() {},
          setFooter() {},
        },
      } as never,
    );

    assert.ok(result, "before-agent-start should return a prompt");
    assert.ok(result!.systemPrompt.includes("[AUTO-MODE PROMPT GUARD]"), "guard should be injected");
    assert.ok(result!.systemPrompt.includes("ask_user_questions"), "guard should block ask_user_questions");
    assert.ok(result!.systemPrompt.includes("secure_env_collect"), "guard should block secure_env_collect");
  } finally {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
  }
});
