import test from "node:test";
import assert from "node:assert/strict";

import { loadPrompt } from "../prompt-loader.ts";

test("loadPrompt normalizes workingDirectory backslashes for bash-friendly prompts (#4048)", () => {
  const prompt = loadPrompt("research-milestone", {
    milestoneId: "M001",
    milestoneTitle: "Windows path fix",
    workingDirectory: "C:\\Dev\\NB\\TR",
    inlinedContext: "context",
    skillActivation: "skill activation",
    skillDiscoveryMode: "off",
    skillDiscoveryInstructions: " disabled",
  });

  assert.match(prompt, /Your working directory is `C:\/Dev\/NB\/TR`/);
  assert.doesNotMatch(prompt, /C:\\Dev\\NB\\TR/);
});
