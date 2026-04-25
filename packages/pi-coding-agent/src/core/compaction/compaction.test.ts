/**
 * Tests for chunked compaction fallback when messages exceed model context window.
 * Regression test for #2932.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import type { AgentMessage } from "@gsd/pi-agent-core";
import type { Model, AssistantMessage } from "@gsd/pi-ai";

import { generateSummary, estimateTokens, chunkMessages, isDegenerateSummary, CompactionProducedNoSummaryError } from "./compaction.js";
import { estimateSerializedTokens } from "./utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a user message with approximately `tokenCount` tokens (chars = tokens * 4). */
function makeUserMessage(tokenCount: number): AgentMessage {
	const text = "x".repeat(tokenCount * 4);
	return { role: "user", content: text } as unknown as AgentMessage;
}

/**
 * Create a tool-result message of approximately `rawTokenCount` uncapped tokens.
 * Post-truncation, this estimates to ~500 tokens (TOOL_RESULT_MAX_CHARS / 4).
 *
 * Used to exercise the #4665 regression: before the fix, chunkMessages used
 * estimateTokens (pre-truncation), so a 100K-token tool result forced its own
 * chunk even though it serialized to ~500 tokens. After the fix, many tool
 * results coalesce into a single chunk.
 */
function makeToolResultMessage(rawTokenCount: number): AgentMessage {
	const text = "y".repeat(rawTokenCount * 4);
	return {
		role: "toolResult",
		toolCallId: `call_${rawTokenCount}`,
		content: [{ type: "text", text }],
	} as unknown as AgentMessage;
}

/**
 * Create a branch-summary message with a specific summary length. Summary
 * messages are intentionally NOT truncated by the serializer (they're already
 * concise), so this is the right tool to force chunking post-fix.
 */
function makeBranchSummaryMessage(approxTokens: number): AgentMessage {
	const summary = "z".repeat(approxTokens * 4);
	return {
		role: "branchSummary",
		summary,
		fromId: "test",
		timestamp: 0,
	} as unknown as AgentMessage;
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
		// Use branchSummary messages — they aren't capped by the serializer, so
		// their post-serialization size matches their raw size. Each 50k-token
		// summary must get its own chunk under an 80k budget.
		const messages: AgentMessage[] = [
			makeBranchSummaryMessage(50_000),
			makeBranchSummaryMessage(50_000),
			makeBranchSummaryMessage(50_000),
		];
		const chunks = chunkMessages(messages, 80_000);
		assert.ok(chunks.length > 1, `Expected multiple chunks, got ${chunks.length}`);
		const totalMessages = chunks.reduce((sum, c) => sum + c.length, 0);
		assert.equal(totalMessages, 3);
	});

	it("puts a single oversized message in its own chunk", () => {
		// Use branchSummary — not truncated by the serializer — to force the
		// oversized-single-message path. A user message with the same raw size
		// would cap to ~500 tokens and fit in any reasonable budget.
		const messages: AgentMessage[] = [makeBranchSummaryMessage(200_000)];
		const chunks = chunkMessages(messages, 80_000);
		assert.equal(chunks.length, 1);
		assert.equal(chunks[0].length, 1);
	});

	it("preserves message order across chunks", () => {
		const messages: AgentMessage[] = [
			makeBranchSummaryMessage(30_000),
			makeBranchSummaryMessage(30_000),
			makeBranchSummaryMessage(30_000),
			makeBranchSummaryMessage(30_000),
		];
		const chunks = chunkMessages(messages, 50_000);
		const flat = chunks.flat();
		assert.equal(flat.length, 4);
		for (let i = 0; i < flat.length; i++) {
			assert.strictEqual(flat[i], messages[i], `Message ${i} should be in order`);
		}
	});

	// ---------------------------------------------------------------------------
	// #4665 regression: token estimation must reflect serializer truncation
	// ---------------------------------------------------------------------------

	it("(#4665) does not over-split when tool results dominate — they serialize to ~500 tokens", () => {
		// Ten 100K-token tool results. Under the old pre-truncation estimator
		// this would estimate to ~1M tokens and force 10+ tiny chunks. Under
		// the new estimator each caps to ~500 tokens (TOOL_RESULT_MAX_CHARS/4),
		// so 10 of them total ~5K tokens and fit in a single generous budget.
		const messages: AgentMessage[] = Array.from({ length: 10 }, () =>
			makeToolResultMessage(100_000),
		);
		const chunks = chunkMessages(messages, 50_000);
		assert.equal(
			chunks.length,
			1,
			"ten 100K-token tool results should coalesce into one chunk (cap=2000 chars → ~500 tokens each)",
		);
		assert.equal(chunks[0].length, 10);
	});

	it("(#4665) estimateSerializedTokens caps toolResult at TOOL_RESULT_MAX_CHARS/4", () => {
		const huge = makeToolResultMessage(100_000);
		const serialized = estimateSerializedTokens(huge);
		const raw = estimateTokens(huge);
		assert.ok(raw > 50_000, `raw estimator should report the real size, got ${raw}`);
		assert.ok(
			serialized < 1_000,
			`serialized estimator should cap at ~500 tokens, got ${serialized}`,
		);
	});

	it("(#4665) estimateSerializedTokens also caps large user content and assistant thinking", () => {
		const hugeUser = makeUserMessage(50_000);
		assert.ok(
			estimateSerializedTokens(hugeUser) < 1_000,
			"user content > cap must be truncated in the estimator",
		);

		// Assistant with a huge thinking block + huge text block
		const hugeAssistant: AgentMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "t".repeat(100_000) },
				{ type: "text", text: "r".repeat(100_000) },
			],
		} as unknown as AgentMessage;
		assert.ok(
			estimateSerializedTokens(hugeAssistant) < 2_000,
			"assistant thinking + text must each cap; total under 2x TOOL_RESULT_MAX_CHARS/4",
		);
	});
});

// ---------------------------------------------------------------------------
// generateSummary chunked fallback tests
// ---------------------------------------------------------------------------

describe("generateSummary — chunked fallback (#2932)", () => {
	it("calls _completeFn multiple times when messages exceed model context window", async () => {
		// Use branchSummary messages — not capped by the serializer — so the
		// chunker's post-truncation view matches the raw view. 3 × 80k summaries
		// totalling 240k tokens must exceed a 200k context window.
		const messages: AgentMessage[] = [
			makeBranchSummaryMessage(80_000),
			makeBranchSummaryMessage(80_000),
			makeBranchSummaryMessage(80_000),
		];
		const model = makeModel(200_000);
		const reserveTokens = 16_384;

		// Verify our test setup: messages really do exceed the model window.
		// Use estimateSerializedTokens because that's what generateSummary uses
		// for its "does this fit?" decision post-#4665.
		let totalTokens = 0;
		for (const m of messages) totalTokens += estimateSerializedTokens(m);
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
			// Return a non-degenerate summary (>100 chars). Short responses like
			// "Summary of chunk" would trip the #4665 degenerate-output guard,
			// which is exactly what we don't want to test here.
			return makeFakeResponse(
				"## Goal\nDetailed summary of this chunk describing the work completed, files touched, and decisions made. At least 100 characters so the degenerate guard does not trip.",
			);
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
			makeBranchSummaryMessage(80_000),
			makeBranchSummaryMessage(80_000),
			makeBranchSummaryMessage(80_000),
		];
		const model = makeModel(200_000);
		const reserveTokens = 16_384;
		const previousSummary =
			"Previous session summary content — intentionally verbose enough to clear the degenerate-summary threshold so this test exercises the actual propagation path.";

		const prompts: string[] = [];
		const mockComplete = mock.fn(async (_model: any, context: any) => {
			const userMsg = context.messages?.[0];
			const text =
				typeof userMsg?.content === "string"
					? userMsg.content
					: userMsg?.content?.[0]?.text ?? "";
			prompts.push(text);
			return makeFakeResponse(
				"Chunk summary with sufficient length to clear the #4665 degenerate-output guard threshold of 100 characters — this must be longer.",
			);
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

// ---------------------------------------------------------------------------
// #4665 regression — iterative chain must not propagate degenerate summaries
// ---------------------------------------------------------------------------

describe("(#4665) degenerate summary guard", () => {
	it("isDegenerateSummary detects the known failure patterns", () => {
		assert.equal(isDegenerateSummary(undefined), false);
		assert.equal(isDegenerateSummary(""), true, "empty string is degenerate");
		assert.equal(isDegenerateSummary("too short"), true, "short output is degenerate");
		assert.equal(
			isDegenerateSummary("The user asked me to summarize an empty conversation"),
			true,
			"known failure phrase 'empty conversation' is degenerate",
		);
		assert.equal(
			isDegenerateSummary("No conversation to summarize"),
			true,
			"'no conversation to summarize' is degenerate",
		);
		assert.equal(
			isDegenerateSummary(
				"## Goal\nRefactor the compaction pipeline.\n## Done\n- Updated utils.ts\n- Added tests for #4665 regression path",
			),
			false,
			"a real multi-section summary over 100 chars is not degenerate",
		);
	});

	it("does not propagate a degenerate first-chunk summary forward (no 'preserve nothing' chain)", async () => {
		// Force the chunked path with uncapped summary messages.
		const messages: AgentMessage[] = [
			makeBranchSummaryMessage(80_000),
			makeBranchSummaryMessage(80_000),
			makeBranchSummaryMessage(80_000),
		];
		const model = makeModel(200_000);
		const reserveTokens = 16_384;

		// Responses: chunk 0 returns degenerate ("empty conversation"). Chunks
		// 1 and 2 return real summaries. Pre-fix behavior: the chunk-0 output
		// is fed into UPDATE_SUMMARIZATION_PROMPT for chunks 1+, which says
		// "PRESERVE all existing information" — so emptiness is preserved.
		// Post-fix: the degenerate chunk-0 output must not become runningSummary.
		let callIndex = 0;
		const responses = [
			"The user asked me to summarize an empty conversation.",
			"## Done\n- Refactored the serializer to head+tail truncation.\n- Updated chunker to use post-serialization token estimate.",
			"## Done\n- Added regression tests for #4665 including this propagation guard.\n- Verified isDegenerateSummary handles known failure patterns.",
		];
		const seenPrompts: string[] = [];
		const mockComplete = mock.fn(async (_model: any, context: any) => {
			const userMsg = context.messages?.[0];
			const text =
				typeof userMsg?.content === "string"
					? userMsg.content
					: userMsg?.content?.[0]?.text ?? "";
			seenPrompts.push(text);
			const response = responses[Math.min(callIndex, responses.length - 1)];
			callIndex++;
			return makeFakeResponse(response);
		});

		const summary = await generateSummary(
			messages,
			model,
			reserveTokens,
			undefined,
			undefined,
			undefined,
			undefined,
			mockComplete,
		);

		// The returned summary must be one of the real chunk summaries — not
		// the degenerate "empty conversation" output, and not an empty string.
		assert.ok(
			!isDegenerateSummary(summary),
			`final summary should not be degenerate. got: ${JSON.stringify(summary)}`,
		);
		assert.ok(
			summary.includes("Refactored") || summary.includes("regression tests"),
			"final summary should carry real information from chunks 1 or 2",
		);
	});

	it("retries the first chunk once with the initial prompt if the first pass is degenerate", async () => {
		// Force chunked path with a single large chunk. Mock returns degenerate
		// on the first call and a real summary on the retry.
		const messages: AgentMessage[] = [
			makeBranchSummaryMessage(80_000),
			makeBranchSummaryMessage(80_000),
		];
		const model = makeModel(100_000); // small window forces chunking
		const reserveTokens = 16_384;

		const responses = [
			"", // first attempt: empty string → degenerate
			"## Goal\nReal summary produced on the retry pass after the initial pass came back empty — this should land as the running summary.",
			"## Done\n- Added retry-on-degenerate-first-chunk behavior to the iterative summarizer so empty outputs don't poison the chain.",
		];
		let callIndex = 0;
		const mockComplete = mock.fn(async () => {
			const response = responses[Math.min(callIndex, responses.length - 1)];
			callIndex++;
			return makeFakeResponse(response);
		});

		const summary = await generateSummary(
			messages,
			model,
			reserveTokens,
			undefined,
			undefined,
			undefined,
			undefined,
			mockComplete,
		);

		assert.ok(
			!isDegenerateSummary(summary),
			"final summary must not be degenerate after the retry took effect",
		);
		assert.ok(
			mockComplete.mock.callCount() >= 3,
			`expected at least 3 calls (first attempt, retry, second chunk), got ${mockComplete.mock.callCount()}`,
		);
	});

	// -------------------------------------------------------------------------
	// R1 — retry non-first chunks too + observable log when both attempts fail
	// -------------------------------------------------------------------------

	it("(R1) retries a degenerate NON-FIRST chunk before silently dropping it", async () => {
		// Use a small model window to force exactly 2 chunks from 2 messages.
		// Chunk 0 ok, chunk 1 degenerate on first try then real on retry.
		// Chunk 1's recovered content must reach the final summary.
		const messages: AgentMessage[] = [
			makeBranchSummaryMessage(80_000),
			makeBranchSummaryMessage(80_000),
		];
		const model = makeModel(100_000);
		const reserveTokens = 16_384;

		const CHUNK0_SUMMARY = "## Done\n- Chunk 0 real summary with enough length to clear the degenerate threshold of 100 characters — easily.";
		const CHUNK1_RETRY_SUMMARY = "## Done\n- Chunk 1 recovered on retry — its content must appear in the final summary or the R1 fix regressed for non-first chunks.";

		let callIndex = 0;
		const responses = [
			CHUNK0_SUMMARY,           // chunk 0
			"empty conversation",     // chunk 1 first try → degenerate
			CHUNK1_RETRY_SUMMARY,     // chunk 1 retry → real
		];
		const mockComplete = mock.fn(async () => {
			const r = responses[Math.min(callIndex, responses.length - 1)];
			callIndex++;
			return makeFakeResponse(r);
		});

		const summary = await generateSummary(
			messages,
			model,
			reserveTokens,
			undefined,
			undefined,
			undefined,
			undefined,
			mockComplete,
		);

		assert.equal(
			mockComplete.mock.callCount(),
			3,
			"expected 3 calls: chunk 0 + chunk 1 initial + chunk 1 retry",
		);
		assert.ok(
			summary.includes("recovered on retry"),
			`final summary must include chunk 1's retry content (R1: non-first chunks must also retry), got: ${JSON.stringify(summary)}`,
		);
	});

	// -------------------------------------------------------------------------
	// R6 — empty output must not be silently written as a compaction entry
	// -------------------------------------------------------------------------

	it("(R6) throws CompactionProducedNoSummaryError when every chunk is degenerate AND no previousSummary", async () => {
		const messages: AgentMessage[] = [
			makeBranchSummaryMessage(80_000),
			makeBranchSummaryMessage(80_000),
		];
		const model = makeModel(100_000);
		const reserveTokens = 16_384;

		// Every response is degenerate, both initial and retry attempts.
		const mockComplete = mock.fn(async () => makeFakeResponse("empty conversation"));

		await assert.rejects(
			() => generateSummary(
				messages,
				model,
				reserveTokens,
				undefined,
				undefined,
				undefined,
				undefined, // no previousSummary
				mockComplete,
			),
			(err: unknown) => err instanceof CompactionProducedNoSummaryError,
			"expected CompactionProducedNoSummaryError when all chunks degenerate and no previousSummary",
		);
	});

	it("(R6) falls back to previousSummary when every chunk is degenerate", async () => {
		const messages: AgentMessage[] = [
			makeBranchSummaryMessage(80_000),
			makeBranchSummaryMessage(80_000),
		];
		const model = makeModel(100_000);
		const reserveTokens = 16_384;
		const previousSummary =
			"Previously-computed summary from the last compaction — deliberately long enough to clear the degenerate-output threshold.";

		const mockComplete = mock.fn(async () => makeFakeResponse("empty conversation"));

		const result = await generateSummary(
			messages,
			model,
			reserveTokens,
			undefined,
			undefined,
			undefined,
			previousSummary,
			mockComplete,
		);

		assert.equal(
			result,
			previousSummary,
			"when all chunks degenerate, must fall back to previousSummary rather than return empty string",
		);
	});
});
