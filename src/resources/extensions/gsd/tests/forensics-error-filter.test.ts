/**
 * Regression test for #2539: extractTrace should not count benign bash
 * exit-code-1 (grep no-match) or user skips as errors.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { extractTrace } from "../session-forensics.ts";

/**
 * Build a minimal JSONL entry pair: assistant tool_use → toolResult.
 * This is the shape extractTrace() expects from session activity files.
 */
function makeToolPair(
  toolName: string,
  input: Record<string, unknown>,
  resultText: string,
  isError: boolean,
): unknown[] {
  const toolCallId = `toolu_${Math.random().toString(36).slice(2, 10)}`;
  return [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: toolName,
            arguments: input,
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId,
        toolName,
        isError,
        content: [{ type: "text", text: resultText }],
      },
    },
  ];
}

describe("extractTrace error filtering (#2539)", () => {
  test("grep exit-code-1 (no matches) is not counted as an error", () => {
    const entries = makeToolPair(
      "bash",
      { command: "grep -rn 'nonexistent' src/" },
      "(no output)\nCommand exited with code 1",
      true,
    );
    const trace = extractTrace(entries);
    assert.equal(trace.errors.length, 0, "grep no-match should not be an error");
  });

  test("user skip is not counted as an error", () => {
    const entries = makeToolPair(
      "bash",
      { command: "npm run test" },
      "Skipped due to queued user message",
      true,
    );
    const trace = extractTrace(entries);
    assert.equal(trace.errors.length, 0, "user skip should not be an error");
  });

  test("real bash error is still counted", () => {
    const entries = makeToolPair(
      "bash",
      { command: "cat /nonexistent" },
      "cat: /nonexistent: No such file or directory\nCommand exited with code 1",
      true,
    );
    const trace = extractTrace(entries);
    assert.equal(trace.errors.length, 1, "real error should still be counted");
    assert.match(trace.errors[0], /No such file or directory/);
  });

  test("non-bash tool error is still counted", () => {
    const entries = makeToolPair(
      "edit",
      { path: "foo.ts", oldText: "x", newText: "y" },
      "oldText not found in file",
      true,
    );
    const trace = extractTrace(entries);
    assert.equal(trace.errors.length, 1, "non-bash tool errors should still be counted");
  });

  test("mixed entries: only real errors are counted", () => {
    const entries = [
      // benign grep no-match
      ...makeToolPair("bash", { command: "grep -rn 'pattern' src/" }, "(no output)\nCommand exited with code 1", true),
      // user skip
      ...makeToolPair("bash", { command: "npm test" }, "Skipped due to queued user message", true),
      // real error
      ...makeToolPair("bash", { command: "node broken.js" }, "SyntaxError: Unexpected token\nCommand exited with code 1", true),
      // successful command (not an error)
      ...makeToolPair("bash", { command: "echo hello" }, "hello", false),
    ];
    const trace = extractTrace(entries);
    assert.equal(trace.errors.length, 1, "only the real error should be counted");
    assert.match(trace.errors[0], /SyntaxError/);
  });

  test("exit code 1 with actual output is still an error", () => {
    const entries = makeToolPair(
      "bash",
      { command: "npm run lint" },
      "src/foo.ts:10:5 - error TS2304: Cannot find name 'x'\nCommand exited with code 1",
      true,
    );
    const trace = extractTrace(entries);
    assert.equal(trace.errors.length, 1, "lint error with output should be counted");
  });
});
