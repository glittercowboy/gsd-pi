// Regression test for #3187: execute-task.md step 15 must treat known issues
// that contradict verification criteria as blocker_discovered: true triggers.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const promptPath = join(
  __dirname,
  "..",
  "prompts",
  "execute-task.md"
);

const content = readFileSync(promptPath, "utf-8");

// Test 1: The prompt contains "known issue" (the gate language added by the fix).
// Fails on unpatched prompt where the phrase is absent.
test("execute-task step 15 mentions 'known issue' as a blocker trigger", () => {
  assert.ok(
    content.toLowerCase().includes("known issue"),
    "Expected execute-task.md to contain 'known issue' in step 15 blocker discovery section"
  );
});

// Test 2: Sanity-check — file path is correct and blocker_discovered flag is present.
// Passes on both patched and unpatched prompt.
test("execute-task contains blocker_discovered flag reference", () => {
  assert.ok(
    content.includes("blocker_discovered: true"),
    "Expected execute-task.md to contain 'blocker_discovered: true'"
  );
});

// Test 3: The prompt contains specific gate language tying a known issue to negating
// verification criteria. Fails on unpatched prompt.
test("execute-task step 15 explicitly gates on known issue negating verification criteria", () => {
  assert.ok(
    content.includes("known issue") && content.includes("verification criteria"),
    "Expected execute-task.md to contain gate language connecting 'known issue' to 'verification criteria'"
  );
});
