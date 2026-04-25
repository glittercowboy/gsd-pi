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
    /const hasToolContent = message\.content\.some\(\(c\) => c\.type === "toolCall" \|\| c\.type === "serverToolUse"\);/,
    "assistant-message should detect tool blocks in mixed turns",
  );

  assert.match(
    src,
    /const shouldCapThinking = hasTextContent \|\| hasToolContent \|\| message\.provider === "claude-code";/,
    "assistant-message should derive a cap policy that also covers claude-code long reasoning traces",
  );

  assert.match(
    src,
    /if \(shouldCapThinking\)\s*\{\s*thinkingMarkdown\.maxLines = 8;\s*\}/s,
    "assistant-message should cap visible thinking lines when the cap policy is active",
  );
});
