import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = join(__dirname, "..", "prompts");

function readPrompt(name: string): string {
  return readFileSync(join(promptsDir, name), "utf-8");
}

test("add-tests prompt forbids referencing gitignored paths", () => {
  const prompt = readPrompt("add-tests.md");

  assert.match(
    prompt,
    /gitignore/i,
    "add-tests prompt should mention .gitignore to rule out referencing local-only files",
  );
  assert.match(prompt, /\.gsd\//, "add-tests prompt should name .gsd/ as off-limits for tests");
  assert.match(prompt, /\.planning\//, "add-tests prompt should name .planning/ as off-limits for tests");
  assert.match(prompt, /\.audits\//, "add-tests prompt should name .audits/ as off-limits for tests");
  assert.match(
    prompt,
    /tracked/i,
    "add-tests prompt should frame the rule in terms of tracked files",
  );
});

test("plan-slice prompt warns against planning tests that depend on gitignored files", () => {
  const prompt = readPrompt("plan-slice.md");

  assert.match(
    prompt,
    /gitignore/i,
    "plan-slice prompt should warn against planning tests that depend on .gitignore paths",
  );
  assert.match(prompt, /\.gsd\//, "plan-slice prompt should name .gsd/ as off-limits for planned tests");
  assert.match(prompt, /\.planning\//, "plan-slice prompt should name .planning/ as off-limits for planned tests");
  assert.match(prompt, /\.audits\//, "plan-slice prompt should name .audits/ as off-limits for planned tests");
});

test("execute-task prompt forbids tests that reference gitignored paths", () => {
  const prompt = readPrompt("execute-task.md");

  assert.match(
    prompt,
    /gitignore/i,
    "execute-task prompt should forbid referencing gitignored paths from tests",
  );
  assert.match(prompt, /\.gsd\//, "execute-task prompt should name .gsd/ as off-limits for tests");
  assert.match(prompt, /\.planning\//, "execute-task prompt should name .planning/ as off-limits for tests");
  assert.match(prompt, /\.audits\//, "execute-task prompt should name .audits/ as off-limits for tests");
});
