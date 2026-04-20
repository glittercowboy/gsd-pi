import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const promptPath = join(process.cwd(), "src/resources/extensions/gsd/prompts/validate-milestone.md");
const prompt = readFileSync(promptPath, "utf-8");

test("validate-milestone reviewer C requires canonical verification class names", () => {
  assert.match(prompt, /\*\*Reviewer C[\s\S]*Verification Classes/i);
  assert.match(prompt, /exact class names [`']?Contract[`']?, [`']?Integration[`']?, [`']?Operational[`']?, and [`']?UAT[`']?/i);
  assert.match(prompt, /If no verification classes were planned, say that explicitly/i);
});

test("validate-milestone prompt routes verification class analysis into verificationClasses", () => {
  assert.match(prompt, /pass it in `verificationClasses`/i);
  assert.match(prompt, /Extract the `Verification Classes` subsection from Reviewer C and pass it verbatim in `verificationClasses`/);
});
