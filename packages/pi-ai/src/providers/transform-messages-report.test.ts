// GSD-2 — ProviderSwitchReport Tests (ADR-005 Phase 3)
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { transformMessages, createEmptyReport, hasTransformations } from "./transform-messages.js";
import type { ProviderSwitchReport } from "./transform-messages.js";
import type { Message, Model, AssistantMessage, ToolCall } from "../types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeModel(overrides: Partial<Model<any>> = {}): Model<any> {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
    ...overrides,
  } as Model<any>;
}

function makeAssistantMsg(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─── createEmptyReport / hasTransformations ─────────────────────────────────

describe("createEmptyReport", () => {
  test("creates report with zero counters", () => {
    const report = createEmptyReport("anthropic-messages", "openai-responses");
    assert.equal(report.fromApi, "anthropic-messages");
    assert.equal(report.toApi, "openai-responses");
    assert.equal(report.thinkingBlocksDropped, 0);
    assert.equal(report.thinkingBlocksDowngraded, 0);
    assert.equal(report.toolCallIdsRemapped, 0);
    assert.equal(report.syntheticToolResultsInserted, 0);
    assert.equal(report.thoughtSignaturesDropped, 0);
  });
});

describe("hasTransformations", () => {
  test("returns false for empty report", () => {
    const report = createEmptyReport("a", "b");
    assert.equal(hasTransformations(report), false);
  });

  test("returns true when any counter is non-zero", () => {
    const report = createEmptyReport("a", "b");
    report.thinkingBlocksDropped = 1;
    assert.equal(hasTransformations(report), true);
  });
});

// ─── Report Tracking in transformMessages ───────────────────────────────────

describe("transformMessages with report tracking", () => {
  test("tracks thinking blocks dropped for redacted cross-model", () => {
    const model = makeModel({ id: "gpt-5", api: "openai-responses", provider: "openai" });
    const messages: Message[] = [
      makeAssistantMsg({
        content: [
          { type: "thinking", thinking: "", redacted: true },
          { type: "text", text: "Hello" },
        ],
      }),
    ];
    const report = createEmptyReport("anthropic-messages", "openai-responses");
    transformMessages(messages, model, undefined, report);
    assert.equal(report.thinkingBlocksDropped, 1);
  });

  test("tracks thinking blocks downgraded to plain text", () => {
    const model = makeModel({ id: "gpt-5", api: "openai-responses", provider: "openai" });
    const messages: Message[] = [
      makeAssistantMsg({
        content: [
          { type: "thinking", thinking: "Let me think about this..." },
          { type: "text", text: "Here is my answer" },
        ],
      }),
    ];
    const report = createEmptyReport("anthropic-messages", "openai-responses");
    transformMessages(messages, model, undefined, report);
    assert.equal(report.thinkingBlocksDowngraded, 1);
  });

  test("tracks tool call IDs remapped", () => {
    const model = makeModel({ id: "claude-sonnet-4-6", api: "anthropic-messages", provider: "anthropic" });
    const toolCall: ToolCall = {
      type: "toolCall",
      id: "original-long-id-that-needs-normalization|with-special-chars",
      name: "bash",
      arguments: { command: "ls" },
    };
    const messages: Message[] = [
      makeAssistantMsg({
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5",
        content: [toolCall],
      }),
    ];
    const normalizer = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    const report = createEmptyReport("openai-responses", "anthropic-messages");
    transformMessages(messages, model, normalizer, report);
    assert.equal(report.toolCallIdsRemapped, 1);
  });

  test("tracks thought signatures dropped", () => {
    const model = makeModel({ id: "claude-sonnet-4-6", api: "anthropic-messages", provider: "anthropic" });
    const toolCall: ToolCall = {
      type: "toolCall",
      id: "tc_001",
      name: "bash",
      arguments: { command: "ls" },
      thoughtSignature: "some-opaque-signature",
    };
    const messages: Message[] = [
      makeAssistantMsg({
        provider: "google",
        api: "google-generative-ai",
        model: "gemini-2.5-pro",
        content: [toolCall],
      }),
    ];
    const report = createEmptyReport("google-generative-ai", "anthropic-messages");
    transformMessages(messages, model, undefined, report);
    assert.equal(report.thoughtSignaturesDropped, 1);
  });

  test("tracks synthetic tool results inserted", () => {
    const model = makeModel();
    const toolCall: ToolCall = {
      type: "toolCall",
      id: "tc_orphan",
      name: "bash",
      arguments: { command: "ls" },
    };
    // Assistant message with tool call followed by another assistant (no tool result)
    const messages: Message[] = [
      makeAssistantMsg({ content: [toolCall, { type: "text", text: "Using bash" }] }),
      makeAssistantMsg({ content: [{ type: "text", text: "Next message" }] }),
    ];
    const report = createEmptyReport("anthropic-messages", "anthropic-messages");
    transformMessages(messages, model, undefined, report);
    assert.equal(report.syntheticToolResultsInserted, 1);
  });

  test("does not count transformations for same-model messages", () => {
    const model = makeModel();
    const messages: Message[] = [
      makeAssistantMsg({
        content: [
          { type: "thinking", thinking: "Let me think..." },
          { type: "text", text: "Answer" },
        ],
      }),
    ];
    const report = createEmptyReport("anthropic-messages", "anthropic-messages");
    transformMessages(messages, model, undefined, report);
    assert.equal(report.thinkingBlocksDowngraded, 0);
    assert.equal(report.thinkingBlocksDropped, 0);
  });

  test("works without report parameter (backward compatible)", () => {
    const model = makeModel();
    const messages: Message[] = [
      makeAssistantMsg({ content: [{ type: "text", text: "Hello" }] }),
    ];
    // Should not throw
    const result = transformMessages(messages, model);
    assert.ok(Array.isArray(result));
  });
});
