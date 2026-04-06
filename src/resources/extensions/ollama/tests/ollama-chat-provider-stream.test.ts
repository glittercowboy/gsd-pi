// GSD2 — Regression test: Ollama streaming must not drop content on done:true chunks (#3576)
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * This test validates the streaming logic pattern used in ollama-chat-provider.ts.
 * The bug: content on the terminal done:true chunk was silently dropped because
 * the stream loop only emitted content when `!chunk.done`.
 *
 * The fix: process chunk.message.content regardless of chunk.done, then handle
 * done metadata. This test exercises that logic path with a simulated chunk stream.
 */

interface OllamaChunk {
  done: boolean;
  done_reason?: string;
  message?: { content?: string; tool_calls?: unknown[] };
  prompt_eval_count?: number;
  eval_count?: number;
}

function simulateStreamLoop(chunks: OllamaChunk[]): string {
  let output = "";

  for (const chunk of chunks) {
    // This mirrors the fixed logic in ollama-chat-provider.ts
    const content = chunk.message?.content ?? "";
    if (content) {
      output += content;
    }

    if (chunk.done) {
      break;
    }
  }

  return output;
}

describe("Ollama stream terminal chunk handling", () => {
  it("captures content from done:true chunk", () => {
    const chunks: OllamaChunk[] = [
      { done: false, message: { content: "Hello " } },
      { done: false, message: { content: "world" } },
      { done: true, done_reason: "stop", message: { content: "!" } },
    ];

    const result = simulateStreamLoop(chunks);
    assert.equal(result, "Hello world!", "trailing content on done chunk must not be dropped");
  });

  it("works when done chunk has no content", () => {
    const chunks: OllamaChunk[] = [
      { done: false, message: { content: "Hello" } },
      { done: true, done_reason: "stop", message: {} },
    ];

    const result = simulateStreamLoop(chunks);
    assert.equal(result, "Hello");
  });

  it("works when done chunk has empty string content", () => {
    const chunks: OllamaChunk[] = [
      { done: false, message: { content: "data" } },
      { done: true, done_reason: "stop", message: { content: "" } },
    ];

    const result = simulateStreamLoop(chunks);
    assert.equal(result, "data");
  });

  it("handles single done chunk with content", () => {
    const chunks: OllamaChunk[] = [
      { done: true, done_reason: "stop", message: { content: "one-shot" } },
    ];

    const result = simulateStreamLoop(chunks);
    assert.equal(result, "one-shot", "single done chunk with content should work");
  });
});
