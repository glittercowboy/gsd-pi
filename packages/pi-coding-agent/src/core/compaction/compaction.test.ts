/**
 * Tests for chunked compaction fallback when messages exceed model context window.
 * Regression test for #2932.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import type { AgentMessage } from "@gsd/pi-agent-core";
import type { Model, AssistantMessage } from "@gsd/pi-ai";

import { generateSummary, estimateTokens, chunkMessages } from "./compaction.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a user message with approximately `tokenCount` tokens (chars = tokens * 4). */
function makeUserMessage(tokenCount: number): AgentMessage {
	const text = "x".repeat(tokenCount * 4);
	return { role: "user", content: text } as unknown as AgentMessage;
}

/** Create a mock model with a given context window. */
function makeModel(contextWindow: number): Model<any> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 4096,
	} as Model<any>;
}

function makeFakeResponse(text: string): AssistantMessage {
	return {
		content: [{ type: "text", text }],
		stopReason: "end_turn",
	} as unknown as AssistantMessage;
}

// ---------------------------------------------------------------------------
// chunkMessages tests
// ---------------------------------------------------------------------------

describe("chunkMessages", () => {
	it("returns a single chunk when messages fit in budget", () => {
		const messages: AgentMessage[] = [
			makeUserMessage(1_000),
			makeUserMessage(1_000),
		];
		const chunks = chunkMessages(messages, 100_000);
		assert.equal(chunks.length, 1);
		assert.equal(chunks[0].length, 2);
	});

	it("splits messages into multiple chunks when they exceed budget", () => {
		const messages: AgentMessage[] = [
			makeUserMessage(50_000),
			makeUserMessage(50_000),
			makeUserMessage(50_000),
		];
		// Budget of 80k tokens means each 50k message gets its own chunk
		// (or two fit together if budget allows)
		const chunks = chunkMessages(messages, 80_000);
		assert.ok(chunks.length > 1, `Expected multiple chunks, got ${chunks.length}`);
		// All messages should be present across chunks
		const totalMessages = chunks.reduce((sum, c) => sum + c.length, 0);
		assert.equal(totalMessages, 3);
	});

	it("puts a single oversized message in its own chunk", () => {
		const messages: AgentMessage[] = [
			makeUserMessage(200_000), // Way over any reasonable budget
		];
		const chunks = chunkMessages(messages, 80_000);
		assert.equal(chunks.length, 1);
		assert.equal(chunks[0].length, 1);
	});

	it("preserves message order across chunks", () => {
		// Create messages with identifiable sizes
		const messages: AgentMessage[] = [
			makeUserMessage(30_000), // ~30k tokens
			makeUserMessage(30_000),
			makeUserMessage(30_000),
			makeUserMessage(30_000),
		];
		const chunks = chunkMessages(messages, 50_000);
		// Reconstruct original order
		const flat = chunks.flat();
		assert.equal(flat.length, 4);
		for (let i = 0; i < flat.length; i++) {
			assert.strictEqual(flat[i], messages[i], `Message ${i} should be in order`);
		}
	});
});

// ---------------------------------------------------------------------------
// generateSummary chunked fallback tests
// ---------------------------------------------------------------------------

describe("generateSummary — chunked fallback (#2932)", () => {
	it("calls _completeFn multiple times when messages exceed model context window", async () => {
		// Arrange: 3 messages of ~80k tokens each = ~240k total, model has 200k window
		const messages: AgentMessage[] = [
			makeUserMessage(80_000),
			makeUserMessage(80_000),
			makeUserMessage(80_000),
		];
		const model = makeModel(200_000);
		const reserveTokens = 16_384;

		// Verify our test setup: messages really do exceed the model window
		let totalTokens = 0;
		for (const m of messages) totalTokens += estimateTokens(m);
		assert.ok(
			totalTokens > model.contextWindow,
			`Test setup: ${totalTokens} tokens should exceed ${model.contextWindow} context window`,
		);

		// Track calls
		const calls: string[] = [];
		const mockComplete = mock.fn(async (_model: any, context: any, _options: any) => {
			const userMsg = context.messages?.[0];
			const text =
				typeof userMsg?.content === "string"
					? userMsg.content
					: userMsg?.content?.[0]?.text ?? "";

			if (text.includes("<previous-summary>")) {
				calls.push("update");
			} else {
				calls.push("initial");
			}
			return makeFakeResponse("Summary of chunk");
		});

		const summary = await generateSummary(
			messages,
			model,
			reserveTokens,
			undefined, // apiKey
			undefined, // signal
			undefined, // customInstructions
			undefined, // previousSummary
			mockComplete, // _completeFn override for testing
		);

		// Assert: should have called completeSimple more than once (chunked)
		assert.ok(
			mockComplete.mock.callCount() > 1,
			`Expected multiple calls for chunked summarization, got ${mockComplete.mock.callCount()}`,
		);

		// First call should be an initial summary, subsequent should be updates
		assert.equal(calls[0], "initial", "First chunk should use initial summarization prompt");
		for (let i = 1; i < calls.length; i++) {
			assert.equal(calls[i], "update", `Chunk ${i + 1} should use update summarization prompt`);
		}

		// Should return a non-empty summary
		assert.ok(summary.length > 0, "Summary should not be empty");
	});

	it("uses single-pass when messages fit within model context window", async () => {
		const messages: AgentMessage[] = [
			makeUserMessage(10_000),
			makeUserMessage(10_000),
		];
		const model = makeModel(200_000);
		const reserveTokens = 16_384;

		// Verify test setup
		let totalTokens = 0;
		for (const m of messages) totalTokens += estimateTokens(m);
		assert.ok(
			totalTokens < model.contextWindow,
			`Test setup: ${totalTokens} tokens should fit in ${model.contextWindow} context window`,
		);

		const mockComplete = mock.fn(async () => makeFakeResponse("Single pass summary"));

		await generateSummary(messages, model, reserveTokens, undefined, undefined, undefined, undefined, mockComplete);

		assert.equal(
			mockComplete.mock.callCount(),
			1,
			"Should use single-pass summarization when messages fit in context window",
		);
	});

	it("passes previousSummary through chunked summarization", async () => {
		const messages: AgentMessage[] = [
			makeUserMessage(80_000),
			makeUserMessage(80_000),
			makeUserMessage(80_000),
		];
		const model = makeModel(200_000);
		const reserveTokens = 16_384;
		const previousSummary = "Previous session summary content";

		const prompts: string[] = [];
		const mockComplete = mock.fn(async (_model: any, context: any) => {
			const userMsg = context.messages?.[0];
			const text =
				typeof userMsg?.content === "string"
					? userMsg.content
					: userMsg?.content?.[0]?.text ?? "";
			prompts.push(text);
			return makeFakeResponse("Chunk summary");
		});

		await generateSummary(
			messages,
			model,
			reserveTokens,
			undefined,
			undefined,
			undefined,
			previousSummary,
			mockComplete,
		);

		// First chunk should include the previousSummary
		assert.ok(
			prompts[0].includes(previousSummary),
			"First chunk should incorporate the previousSummary",
		);
	});
});
