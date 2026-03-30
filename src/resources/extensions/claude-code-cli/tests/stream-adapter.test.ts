import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	makeStreamExhaustedErrorMessage,
	buildPromptFromContext,
	buildSdkOptions,
} from "../stream-adapter.ts";
import type { Context, Message } from "@gsd/pi-ai";

// ---------------------------------------------------------------------------
// Existing tests — exhausted stream fallback (#2575)
// ---------------------------------------------------------------------------

describe("stream-adapter — exhausted stream fallback (#2575)", () => {
	test("generator exhaustion becomes an error message instead of clean completion", () => {
		const message = makeStreamExhaustedErrorMessage("claude-sonnet-4-20250514", "partial answer");

		assert.equal(message.stopReason, "error");
		assert.equal(message.errorMessage, "stream_exhausted_without_result");
		assert.deepEqual(message.content, [{ type: "text", text: "partial answer" }]);
	});

	test("generator exhaustion without prior text still exposes a classifiable error", () => {
		const message = makeStreamExhaustedErrorMessage("claude-sonnet-4-20250514", "");

		assert.equal(message.stopReason, "error");
		assert.equal(message.errorMessage, "stream_exhausted_without_result");
		assert.match(String((message.content[0] as any)?.text ?? ""), /Claude Code error: stream_exhausted_without_result/);
	});
});

// ---------------------------------------------------------------------------
// Bug #2859 — stateless provider regression tests
// ---------------------------------------------------------------------------

describe("stream-adapter — full context prompt (#2859)", () => {
	test("buildPromptFromContext includes all user and assistant messages, not just the last user message", () => {
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [
				{ role: "user", content: "What is 2+2?" } as Message,
				{
					role: "assistant",
					content: [{ type: "text", text: "4" }],
					api: "anthropic-messages",
					provider: "claude-code",
					model: "claude-sonnet-4-20250514",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: Date.now(),
				} as Message,
				{ role: "user", content: "Now multiply that by 3" } as Message,
			],
		};

		const prompt = buildPromptFromContext(context);

		// Must contain content from BOTH user messages, not just the last
		assert.ok(prompt.includes("2+2"), "prompt must include first user message");
		assert.ok(prompt.includes("multiply"), "prompt must include second user message");
		// Must contain assistant response for continuity
		assert.ok(prompt.includes("4"), "prompt must include assistant reply for context");
	});

	test("buildPromptFromContext includes system prompt when present", () => {
		const context: Context = {
			systemPrompt: "You are a coding assistant.",
			messages: [
				{ role: "user", content: "Write a function" } as Message,
			],
		};

		const prompt = buildPromptFromContext(context);
		assert.ok(prompt.includes("coding assistant"), "prompt must include system prompt");
	});

	test("buildPromptFromContext handles array content parts in user messages", () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "First part" },
						{ type: "text", text: "Second part" },
					],
				} as Message,
				{ role: "user", content: "Follow-up" } as Message,
			],
		};

		const prompt = buildPromptFromContext(context);
		assert.ok(prompt.includes("First part"), "prompt must include array content parts");
		assert.ok(prompt.includes("Second part"), "prompt must include all text parts");
		assert.ok(prompt.includes("Follow-up"), "prompt must include follow-up message");
	});

	test("buildPromptFromContext returns empty string for empty messages", () => {
		const context: Context = { messages: [] };
		const prompt = buildPromptFromContext(context);
		assert.equal(prompt, "");
	});
});

describe("stream-adapter — session persistence (#2859)", () => {
	test("buildSdkOptions enables persistSession by default", () => {
		const options = buildSdkOptions("claude-sonnet-4-20250514", "test prompt");
		assert.equal(options.persistSession, true, "persistSession must default to true");
	});

	test("buildSdkOptions sets model and prompt correctly", () => {
		const options = buildSdkOptions("claude-sonnet-4-20250514", "hello world");
		assert.equal(options.model, "claude-sonnet-4-20250514");
	});

	test("buildSdkOptions enables betas for sonnet models", () => {
		const sonnetOpts = buildSdkOptions("claude-sonnet-4-20250514", "test");
		assert.ok(
			Array.isArray(sonnetOpts.betas) && sonnetOpts.betas.length > 0,
			"sonnet models should have betas enabled",
		);

		const opusOpts = buildSdkOptions("claude-opus-4-20250514", "test");
		assert.ok(
			Array.isArray(opusOpts.betas) && opusOpts.betas.length === 0,
			"non-sonnet models should have empty betas",
		);
	});
});
