import test from "node:test";
import assert from "node:assert/strict";

import { createObservationMask } from "../context-masker.js";

// These helpers produce messages in the pi-ai LLM payload format
// (post-convertToLlm, pre-provider), which is what before_provider_request sees.

function userMsg(content: string) {
  return { role: "user", content: [{ type: "text", text: content }] };
}

function assistantMsg(content: string) {
  return { role: "assistant", content: [{ type: "text", text: content }] };
}

/** toolResult in pi-ai format: role "toolResult", content as TextContent[] */
function toolResult(text: string) {
  return { role: "toolResult", content: [{ type: "text", text }], toolCallId: "toolu_test", toolName: "Read", isError: false };
}

/** bashExecution after convertToLlm: becomes a user message with "Ran `cmd`" prefix */
function bashResult(text: string) {
  return { role: "user", content: [{ type: "text", text: `Ran \`echo test\`\n\`\`\`\n${text}\n\`\`\`` }] };
}

const MASK_TEXT = "[result masked — within summarized history]";

test("masks nothing when message count is within keepRecentTurns", () => {
  const mask = createObservationMask(8);
  const messages = [
    userMsg("hello"),
    assistantMsg("hi"),
    toolResult("file contents"),
  ];
  const result = mask(messages as any);
  assert.equal(result.length, 3);
  assert.deepEqual((result[2].content as any)[0].text, "file contents");
});

test("masks tool results older than keepRecentTurns", () => {
  const mask = createObservationMask(2);
  const messages = [
    userMsg("turn 1"),
    toolResult("old tool output"),
    assistantMsg("response 1"),
    userMsg("turn 2"),
    toolResult("newer tool output"),
    assistantMsg("response 2"),
    userMsg("turn 3"),
    toolResult("newest tool output"),
    assistantMsg("response 3"),
  ];
  const result = mask(messages as any);
  // Old tool result (before boundary) should be masked
  assert.equal((result[1].content as any)[0].text, MASK_TEXT);
  // Recent tool results (within keep window) should be preserved
  assert.equal((result[4].content as any)[0].text, "newer tool output");
  assert.equal((result[7].content as any)[0].text, "newest tool output");
});

test("never masks assistant messages", () => {
  const mask = createObservationMask(1);
  const messages = [
    userMsg("turn 1"),
    assistantMsg("old reasoning"),
    userMsg("turn 2"),
    assistantMsg("new reasoning"),
  ];
  const result = mask(messages as any);
  assert.equal((result[1].content as any)[0].text, "old reasoning");
  assert.equal((result[3].content as any)[0].text, "new reasoning");
});

test("never masks user messages", () => {
  const mask = createObservationMask(1);
  const messages = [
    userMsg("old user message"),
    assistantMsg("response"),
    userMsg("new user message"),
    assistantMsg("response"),
  ];
  const result = mask(messages as any);
  assert.equal((result[0].content as any)[0].text, "old user message");
});

test("masks bash result user messages", () => {
  const mask = createObservationMask(1);
  const messages = [
    userMsg("turn 1"),
    bashResult("huge log output"),
    assistantMsg("response 1"),
    userMsg("turn 2"),
    assistantMsg("response 2"),
  ];
  const result = mask(messages as any);
  assert.equal((result[1].content as any)[0].text, MASK_TEXT);
});

test("returns same array length", () => {
  const mask = createObservationMask(1);
  const messages = [
    userMsg("a"), toolResult("b"), assistantMsg("c"),
    userMsg("d"), toolResult("e"), assistantMsg("f"),
  ];
  const result = mask(messages as any);
  assert.equal(result.length, messages.length);
});

test("masks toolResult by role, not by type field", () => {
  const mask = createObservationMask(1);
  const messages = [
    userMsg("turn 1"),
    // This is the actual pi-ai format: role "toolResult", no type field
    { role: "toolResult", content: [{ type: "text", text: "old result" }], toolCallId: "t1", toolName: "Read", isError: false },
    assistantMsg("response 1"),
    userMsg("turn 2"),
    assistantMsg("response 2"),
  ];
  const result = mask(messages as any);
  assert.equal((result[1].content as any)[0].text, MASK_TEXT);
});
