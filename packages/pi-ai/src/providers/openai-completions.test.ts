import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { convertMessages } from "./openai-completions.js";
import type { Model, Context, OpenAICompletionsCompat, AssistantMessage } from "../types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function makeUserMsg(text: string) {
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
}

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
		const model = makeModel({ stripReasoningFromHistory: true });
		const compat = makeCompat({ stripReasoningFromHistory: true });
		const context: Context = {
			messages: [
				makeUserMsg("Hi"),
				makeAssistantMsg({
					content: [
						{ type: "thinking", thinking: "Thinking...", thinkingSignature: "reasoning" },
						{ type: "text", text: "Hi back!" },
					],
				}),
				makeUserMsg("Bye"),
			],
		};

		const params = convertMessages(model, context, compat);
		const assistantMsg = params.find((p) => p.role === "assistant") as any;

		assert.equal(assistantMsg.reasoning, undefined, "reasoning field must be stripped");
	});

	it("requiresThinkingAsText takes priority over stripReasoningFromHistory", () => {
		// If both flags are set, requiresThinkingAsText wins (it's checked first in the if/else chain)
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

		assert.equal(assistantMsg.reasoning_content, undefined, "reasoning_content must not be in payload");
		// With requiresThinkingAsText the thinking is prepended as plain text
		const textContent = Array.isArray(assistantMsg.content)
			? assistantMsg.content.map((c: any) => c.text).join(" ")
			: assistantMsg.content;
		assert.ok(textContent.includes("My reasoning."), "thinking must be folded into text content");
	});
});
