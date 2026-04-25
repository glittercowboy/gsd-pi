import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = join(__dirname, "..", "prompts");

test("execute-task prompt requires reading existing artifacts before write", () => {
  const prompt = readFileSync(join(promptsDir, "execute-task.md"), "utf-8");

  assert.match(
    prompt,
    /Before any `Write` that creates an artifact or output file, check whether that path already exists\./,
    "execute-task prompt should require an existence check before creating artifacts",
  );
  assert.match(
    prompt,
    /If it does, read it first and decide whether the work is already done, should be extended, or truly needs replacement\./,
    "execute-task prompt should require reading existing artifacts before replacement",
  );
});

test("guided resume prompt checks for pre-existing artifacts", () => {
  const prompt = readFileSync(join(promptsDir, "guided-resume-task.md"), "utf-8");

  assert.match(
    prompt,
    /Before you create any expected artifact or output file, check whether it already exists and read it first/i,
    "guided resume prompt should guard pre-existing artifacts",
  );
});
