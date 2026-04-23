/**
 * Unit tests for openai-completions provider, focusing on stripReasoningFromHistory compat flag.
 *
 * Tests verify that thinking blocks are correctly handled when:
 * - Default behavior (stripReasoningFromHistory: false) replays reasoning fields
 * - stripReasoningFromHistory: true strips reasoning_content, reasoning, and reasoning_details
 * - Assistant text content is preserved when stripping
 * - Flag priority when combined with requiresThinkingAsText
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { convertMessages } from "./openai-completions.js";
import type { Model, Context, OpenAICompletionsCompat, AssistantMessage } from "../types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal openai-completions model fixture with optional compat overrides. */
function makeModel(compatOverrides: Partial<OpenAICompletionsCompat> = {}): Model<"openai-completions"> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions" as const,
		provider: "local-llm",
		baseUrl: "http://localhost:8002/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat: compatOverrides,
	} as Model<"openai-completions">;
}

/** Build a fully-resolved compat object with safe defaults, optionally overriding specific fields. */
function makeCompat(overrides: Partial<OpenAICompletionsCompat> = {}): Required<OpenAICompletionsCompat> {
	return {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		reasoningEffortMap: {},
		supportsUsageInStreaming: false,
		maxTokensField: "max_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		stripReasoningFromHistory: false,
		thinkingFormat: "openai",
		openRouterRouting: {},
		vercelGatewayRouting: {},
		supportsStrictMode: false,
		...overrides,
	};
}

/** Build a minimal user message fixture. */
function makeUserMsg(text: string) {
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
}

/** Build a minimal assistant message fixture with usage zeroed out. */
function makeAssistantMsg(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "local-llm",
		model: "test-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

// ─── stripReasoningFromHistory ────────────────────────────────────────────────

describe("convertMessages — stripReasoningFromHistory", () => {
	it("replays reasoning_content by default (stripReasoningFromHistory: false)", () => {
		const model = makeModel();
		const compat = makeCompat({ stripReasoningFromHistory: false });
		const context: Context = {
			messages: [
				makeUserMsg("Hello"),
				makeAssistantMsg({
					content: [
						{ type: "thinking", thinking: "I should greet the user.", thinkingSignature: "reasoning_content" },
						{ type: "text", text: "Hello!" },
					],
				}),
				makeUserMsg("How are you?"),
			],
		};

		const params = convertMessages(model, context, compat);
		const assistantMsg = params.find((p) => p.role === "assistant") as any;

		assert.ok(assistantMsg, "assistant message should be present");
		assert.equal(
			assistantMsg.reasoning_content,
			"I should greet the user.",
			"reasoning_content should be re-injected when stripReasoningFromHistory is false",
		);
	});

	it("strips reasoning_content from history when stripReasoningFromHistory: true", () => {
		const model = makeModel({ stripReasoningFromHistory: true });
		const compat = makeCompat({ stripReasoningFromHistory: true });
		const context: Context = {
			messages: [
				makeUserMsg("Hello"),
				makeAssistantMsg({
					content: [
						{ type: "thinking", thinking: "I should greet the user.", thinkingSignature: "reasoning_content" },
						{ type: "text", text: "Hello!" },
					],
				}),
				makeUserMsg("How are you?"),
			],
		};

		const params = convertMessages(model, context, compat);
		const assistantMsg = params.find((p) => p.role === "assistant") as any;

		assert.ok(assistantMsg, "assistant message should be present");
		assert.equal(
			assistantMsg.reasoning_content,
			undefined,
			"reasoning_content must not appear in the serialized payload",
		);
		assert.equal(
			assistantMsg.reasoning,
			undefined,
			"reasoning must not appear in the serialized payload",
		);
	});

	it("preserves assistant text content when stripping reasoning", () => {
		const model = makeModel({ stripReasoningFromHistory: true });
		const compat = makeCompat({ stripReasoningFromHistory: true });
		const context: Context = {
			messages: [
				makeUserMsg("Hello"),
				makeAssistantMsg({
					content: [
						{ type: "thinking", thinking: "Some deep thought.", thinkingSignature: "reasoning_content" },
						{ type: "text", text: "The answer is 42." },
					],
				}),
				makeUserMsg("Thanks"),
			],
		};

		const params = convertMessages(model, context, compat);
		const assistantMsg = params.find((p) => p.role === "assistant") as any;

		assert.ok(assistantMsg, "assistant message should be present");
		const textContent = Array.isArray(assistantMsg.content)
			? assistantMsg.content.find((c: any) => c.type === "text")?.text
			: assistantMsg.content;
		assert.equal(textContent, "The answer is 42.", "answer text must be preserved");
	});

	it("strips any reasoning field (reasoning, reasoning_text) not just reasoning_content", () => {
		// Test multiple field names that servers can use for thinking content
		const fieldNames = ["reasoning", "reasoning_text", "reasoning_content"];
		for (const fieldName of fieldNames) {
			const model = makeModel({ stripReasoningFromHistory: true });
			const compat = makeCompat({ stripReasoningFromHistory: true });
			const context: Context = {
				messages: [
					makeUserMsg("Hi"),
					makeAssistantMsg({
						content: [
							{ type: "thinking", thinking: "Thinking...", thinkingSignature: fieldName },
							{ type: "text", text: "Hi back!" },
						],
					}),
					makeUserMsg("Bye"),
				],
			};

			const params = convertMessages(model, context, compat);
			const assistantMsg = params.find((p) => p.role === "assistant") as any;

			assert.ok(assistantMsg, `assistant message should be present for fieldName="${fieldName}"`);
			assert.equal(
				(assistantMsg as any)[fieldName],
				undefined,
				`${fieldName} field must be stripped`,
			);
		}
	});

	it("stripReasoningFromHistory takes priority when both flags are set", () => {
		// If both stripReasoningFromHistory and requiresThinkingAsText are true, stripping wins:
		// thinking blocks are not converted to text, nor re-injected as fields
		const model = makeModel({ requiresThinkingAsText: true, stripReasoningFromHistory: true });
		const compat = makeCompat({ requiresThinkingAsText: true, stripReasoningFromHistory: true });
		const context: Context = {
			messages: [
				makeUserMsg("Hello"),
				makeAssistantMsg({
					content: [
						{ type: "thinking", thinking: "My reasoning.", thinkingSignature: "reasoning_content" },
						{ type: "text", text: "Answer." },
					],
				}),
				makeUserMsg("Next"),
			],
		};

		const params = convertMessages(model, context, compat);
		const assistantMsg = params.find((p) => p.role === "assistant") as any;

		assert.ok(assistantMsg, "assistant message should be present");
		assert.equal(assistantMsg.reasoning_content, undefined, "reasoning_content must not be in payload");
		// With stripReasoningFromHistory: true, thinking is dropped entirely (not converted to text)
		const textContent = Array.isArray(assistantMsg.content)
			? assistantMsg.content.map((c: any) => c.text).join(" ")
			: assistantMsg.content;
		assert.ok(
			!textContent.includes("My reasoning."),
			"thinking must NOT be folded into text when stripping is active",
		);
	});

	it("strips reasoning_details from tool calls when stripReasoningFromHistory: true", () => {
		const model = makeModel({ stripReasoningFromHistory: true });
		const compat = makeCompat({ stripReasoningFromHistory: true });
		const reasoningPayload = JSON.stringify([{ type: "thinking", thinking: "tool reasoning" }]);
		const context: Context = {
			messages: [
				makeUserMsg("Do something"),
				makeAssistantMsg({
					content: [
						{
							type: "toolCall",
							id: "call_1",
							name: "some_tool",
							arguments: { x: 1 },
							thoughtSignature: reasoningPayload,
						},
					],
				}),
				makeUserMsg("Done"),
			],
		};

		const params = convertMessages(model, context, compat);
		const assistantMsg = params.find((p) => p.role === "assistant") as any;

		assert.ok(assistantMsg, "assistant message should be present");
		assert.equal(assistantMsg.reasoning_details, undefined, "reasoning_details must not appear in the serialized payload");
		assert.ok(Array.isArray(assistantMsg.tool_calls) && assistantMsg.tool_calls.length === 1, "tool_calls must still be present");
	});

	it("replays reasoning_details on tool calls by default (stripReasoningFromHistory: false)", () => {
		const model = makeModel();
		const compat = makeCompat({ stripReasoningFromHistory: false });
		const reasoningPayload = JSON.stringify([{ type: "thinking", thinking: "tool reasoning" }]);
		const context: Context = {
			messages: [
				makeUserMsg("Do something"),
				makeAssistantMsg({
					content: [
						{
							type: "toolCall",
							id: "call_1",
							name: "some_tool",
							arguments: { x: 1 },
							thoughtSignature: reasoningPayload,
						},
					],
				}),
				makeUserMsg("Done"),
			],
		};

		const params = convertMessages(model, context, compat);
		const assistantMsg = params.find((p) => p.role === "assistant") as any;

		assert.ok(assistantMsg, "assistant message should be present");
		assert.ok(Array.isArray(assistantMsg.reasoning_details) && assistantMsg.reasoning_details.length > 0, "reasoning_details must be re-injected when stripReasoningFromHistory is false");
	});
});
