import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const promptsDir = join(process.cwd(), "src/resources/extensions/gsd/prompts");

function readPrompt(name: string): string {
  return readFileSync(join(promptsDir, `${name}.md`), "utf-8");
}

test("forensics prompt explicitly forbids github_issues tool for issue creation", () => {
  const prompt = readPrompt("forensics");

  // Must contain an explicit prohibition against using the github_issues tool
  assert.match(
    prompt,
    /Do NOT use the `?github_issues`? tool/i,
    "Prompt must explicitly prohibit the github_issues tool",
  );
});

test("forensics prompt requires gh CLI with --repo gsd-build/gsd-2 for issue creation", () => {
  const prompt = readPrompt("forensics");

  // Must contain the exact gh CLI command with the correct repo flag
  assert.match(
    prompt,
    /gh issue create --repo gsd-build\/gsd-2/,
    "Prompt must specify gh issue create --repo gsd-build/gsd-2",
  );
});

test("forensics prompt routes issue creation through bash tool, not github_issues", () => {
  const prompt = readPrompt("forensics");

  // The constraint about using bash tool must be present
  assert.match(
    prompt,
    /`?bash`? tool/i,
    "Prompt must instruct use of the bash tool for issue creation",
  );
});
