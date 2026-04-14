// Regression test for #4181:
// When assistant messages include both thinking + text, cap visible thinking
// lines so question/chat text remains visible without toggling thinking off.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const assistantMessagePath = join(
  process.cwd(),
  "packages",
  "pi-coding-agent",
  "src",
  "modes",
  "interactive",
  "components",
  "assistant-message.ts",
);

test("assistant-message caps thinking block height when text content is present", () => {
  const src = readFileSync(assistantMessagePath, "utf-8");

  assert.match(
    src,
    /const hasTextContent = message\.content\.some\(\(c\) => c\.type === "text" && c\.text\.trim\(\)\.length > 0\);/,
    "assistant-message should detect text presence in mixed thinking+text messages",
  );

  assert.match(
    src,
    /if \(hasTextContent\)\s*\{\s*thinkingMarkdown\.maxLines = 8;\s*\}/s,
    "assistant-message should cap visible thinking lines when assistant text also exists",
  );
});
