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
  "gsd-agent-modes",
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
    /const hasToolContent = message\.content\.some\(\(c\) => c\.type === "toolCall" \|\| isServerToolUseBlock\(c\)\);/,
    "assistant-message should detect tool blocks in mixed turns",
  );

  // pi-tui 0.67.2: maxLines removed from Markdown component; thinking blocks render at full height.
  // The cap policy variable (_shouldCapThinking) is preserved for future restoration.
  assert.match(
    src,
    /const _shouldCapThinking = hasTextContent \|\| hasToolContent \|\| message\.provider === "claude-code";/,
    "assistant-message should derive a cap policy that also covers claude-code long reasoning traces",
  );
});
