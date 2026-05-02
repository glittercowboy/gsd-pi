// DeepSeek reasoning_content round-trip.
// Docs: https://api-docs.deepseek.com/guides/thinking_mode
// Without this, DeepSeek returns 400: "The `reasoning_content` in the thinking mode must be passed back to the API."
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { convertMessages, getCompat } from "./openai-completions.js";
import type { AssistantMessage, Context, Model } from "../types.js";

function makeDeepseekModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		...overrides,
	} as Model<"openai-completions">;
}

function makeAssistantMsg(
	content: AssistantMessage["content"],
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("openai-completions: DeepSeek thinkingFormat auto-detection", () => {
	test("baseUrl matching deepseek.com → thinkingFormat=deepseek", () => {
		const compat = getCompat(makeDeepseekModel());
		assert.equal(compat.thinkingFormat, "deepseek");
	});

	test("provider=deepseek → thinkingFormat=deepseek even without URL match", () => {
		const compat = getCompat(makeDeepseekModel({ baseUrl: "https://example.com/v1" }));
		assert.equal(compat.thinkingFormat, "deepseek");
	});

	test("explicit compat.thinkingFormat wins over auto-detect", () => {
		const compat = getCompat(makeDeepseekModel({ compat: { thinkingFormat: "openai" } }));
		assert.equal(compat.thinkingFormat, "openai");
	});

	test("unrelated URL/provider → thinkingFormat stays openai", () => {
		const compat = getCompat(
			makeDeepseekModel({
				provider: "openai",
				baseUrl: "https://api.openai.com",
				id: "gpt-4",
			}),
		);
		assert.equal(compat.thinkingFormat, "openai");
	});
});

describe("openai-completions: convertMessages with thinkingFormat=deepseek", () => {
	test("thinking + text → reasoning_content at top level, content preserved", () => {
		const model = makeDeepseekModel();
		const compat = getCompat(model);
		const context: Context = {
			messages: [
				makeAssistantMsg([
					{ type: "thinking", thinking: "Let me reason about this." },
					{ type: "text", text: "The answer is 42." },
				]),
			],
		};
		const params = convertMessages(model, context, compat);
		assert.equal(params.length, 1);
		const asst = params[0] as any;
		assert.equal(asst.role, "assistant");
		assert.equal(asst.reasoning_content, "Let me reason about this.");
		assert.ok(Array.isArray(asst.content));
		assert.equal(asst.content[0].text, "The answer is 42.");
	});

	test("thinking + tool_calls (no text) → reasoning_content survives alongside tool_calls", () => {
		const model = makeDeepseekModel();
		const compat = getCompat(model);
		const context: Context = {
			messages: [
				makeAssistantMsg([
					{ type: "thinking", thinking: "I should call the search tool." },
					{
						type: "toolCall",
						id: "call_abc123",
						name: "search",
						arguments: { query: "hello" },
					},
				]),
				{
					role: "toolResult",
					toolCallId: "call_abc123",
					toolName: "search",
					content: [{ type: "text", text: "no results" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		};
		const params = convertMessages(model, context, compat);
		const asst = params[0] as any;
		assert.equal(asst.role, "assistant");
		assert.equal(asst.reasoning_content, "I should call the search tool.");
		assert.equal(asst.tool_calls.length, 1);
		assert.equal(asst.tool_calls[0].id, "call_abc123");
	});

	test("multiple thinking blocks joined with newline", () => {
		const model = makeDeepseekModel();
		const compat = getCompat(model);
		const context: Context = {
			messages: [
				makeAssistantMsg([
					{ type: "thinking", thinking: "First thought." },
					{ type: "thinking", thinking: "Second thought." },
					{ type: "text", text: "Done." },
				]),
			],
		};
		const params = convertMessages(model, context, compat);
		const asst = params[0] as any;
		assert.equal(asst.reasoning_content, "First thought.\nSecond thought.");
	});

	test("empty / whitespace-only thinking blocks are filtered out", () => {
		const model = makeDeepseekModel();
		const compat = getCompat(model);
		const context: Context = {
			messages: [
				makeAssistantMsg([
					{ type: "thinking", thinking: "" },
					{ type: "thinking", thinking: "   " },
					{ type: "thinking", thinking: "Real thought." },
					{ type: "text", text: "OK." },
				]),
			],
		};
		const params = convertMessages(model, context, compat);
		const asst = params[0] as any;
		assert.equal(asst.reasoning_content, "Real thought.");
	});

	test("no thinking blocks → reasoning_content is empty string (required by DeepSeek for tool_call turns)", () => {
		const model = makeDeepseekModel();
		const compat = getCompat(model);
		const context: Context = {
			messages: [makeAssistantMsg([{ type: "text", text: "Just text." }])],
		};
		const params = convertMessages(model, context, compat);
		const asst = params[0] as any;
		assert.equal(asst.reasoning_content, "");
	});

	test("tool_calls without thinking → reasoning_content is empty string (the 400-producing case)", () => {
		const model = makeDeepseekModel();
		const compat = getCompat(model);
		const context: Context = {
			messages: [
				makeAssistantMsg([
					{
						type: "toolCall",
						id: "call_xyz",
						name: "search",
						arguments: { query: "hi" },
					},
				]),
				{
					role: "toolResult",
					toolCallId: "call_xyz",
					toolName: "search",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		};
		const params = convertMessages(model, context, compat);
		const asst = params[0] as any;
		assert.equal(asst.reasoning_content, "");
		assert.equal(asst.tool_calls.length, 1);
	});
});

describe("openai-completions: requiresThinkingAsText path unaffected by deepseek branch", () => {
	test("thinkingFormat=openai + requiresThinkingAsText=true → thinking prefixed as text, no reasoning_content", () => {
		const model = {
			id: "some-model",
			name: "Some Model",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://example.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 8192,
			compat: { requiresThinkingAsText: true, thinkingFormat: "openai" as const },
		} as Model<"openai-completions">;
		const compat = getCompat(model);
		const context: Context = {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "reasoning here" },
						{ type: "text", text: "answer" },
					],
					api: "openai-completions",
					provider: "custom",
					model: "some-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			],
		};
		const params = convertMessages(model, context, compat);
		const asst = params[0] as any;
		assert.equal(asst.reasoning_content, undefined);
		assert.ok(Array.isArray(asst.content));
		assert.equal(asst.content[0].text, "reasoning here");
		assert.equal(asst.content[1].text, "answer");
	});
});
