import test from "node:test";
import assert from "node:assert/strict";

import { createObservationMask } from "../context-masker.js";

function userMsg(content: string) {
  return { role: "user", content, type: "user" };
}

function assistantMsg(content: string) {
  return { role: "assistant", content, type: "assistant" };
}

function toolResult(content: string) {
  return { role: "user", content, type: "toolResult" };
}

function bashExecution(content: string) {
  return { role: "user", content, type: "bashExecution" };
}

test("masks nothing when message count is within keepRecentTurns", () => {
  const mask = createObservationMask(8);
  const messages = [
    userMsg("hello"),
    assistantMsg("hi"),
    toolResult("file contents"),
  ];
  const result = mask(messages as any);
  assert.equal(result.length, 3);
  assert.equal(result[2].content, "file contents");
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
  assert.ok(result[1].content.includes("[result masked"));
  assert.equal(result[4].content, "newer tool output");
  assert.equal(result[7].content, "newest tool output");
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
  assert.equal(result[1].content, "old reasoning");
  assert.equal(result[3].content, "new reasoning");
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
  assert.equal(result[0].content, "old user message");
});

test("masks bashExecution content", () => {
  const mask = createObservationMask(1);
  const messages = [
    userMsg("turn 1"),
    bashExecution("huge log output"),
    assistantMsg("response 1"),
    userMsg("turn 2"),
    assistantMsg("response 2"),
  ];
  const result = mask(messages as any);
  assert.ok(result[1].content.includes("[result masked"));
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

test("masks tool_result type (API format)", () => {
  const mask = createObservationMask(1);
  const messages = [
    userMsg("turn 1"),
    { role: "user", content: "old result", type: "tool_result" },
    assistantMsg("response 1"),
    userMsg("turn 2"),
    assistantMsg("response 2"),
  ];
  const result = mask(messages as any);
  assert.ok(typeof result[1].content === "string" && result[1].content.includes("[result masked"));
});

test("masks role=tool messages (OpenAI format)", () => {
  const mask = createObservationMask(1);
  const messages = [
    userMsg("turn 1"),
    { role: "tool", content: "tool output" },
    assistantMsg("response 1"),
    userMsg("turn 2"),
    assistantMsg("response 2"),
  ];
  const result = mask(messages as any);
  assert.ok(typeof result[1].content === "string" && result[1].content.includes("[result masked"));
});

test("masks content array blocks (Anthropic API format)", () => {
  const mask = createObservationMask(1);
  const messages = [
    userMsg("turn 1"),
    { role: "user", content: [{ type: "tool_result", content: "old output", tool_use_id: "t1" }] },
    assistantMsg("response 1"),
    { role: "user", content: "turn 2", type: "user" },
    assistantMsg("response 2"),
  ];
  const result = mask(messages as any);
  assert.ok(Array.isArray(result[1].content));
  const block = (result[1].content as { content: string }[])[0];
  assert.ok(block.content.includes("[result masked"));
});
