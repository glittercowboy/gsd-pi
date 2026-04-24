/**
 * Regression tests for MiniMax error 2013 "function name or parameters is empty" (#4538).
 *
 * Root cause: the `fine-grained-tool-streaming-2025-05-14` beta header is sent to
 * MiniMax. MiniMax's Anthropic-compatible API implements this beta by streaming the
 * tool name as a delta (empty string in `content_block_start`). The empty name gets
 * stored in conversation history and sent back on the next request, causing MiniMax
 * to return error 2013.
 *
 * Fix: exclude MiniMax (and minimax-cn) from the fine-grained-tool-streaming beta,
 * same as alibaba-coding-plan. Also guard against storing empty tool names.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { convertMessages } from "./anthropic-shared.js";
import { buildAnthropicClientConfig } from "./anthropic.js";
import type { AssistantMessage, Model } from "../types.js";

const FGTS_BETA = "fine-grained-tool-streaming-2025-05-14";

function makeAnthropicModel(provider: Model<"anthropic-messages">["provider"]): Model<"anthropic-messages"> {
	return {
		id: `test-${provider}`,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://api.example.com",
		reasoning: false,
		input: ["text"],
		name: `${provider} model`,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_192,
	} as Model<"anthropic-messages">;
}

function getBetaHeader(
	provider: Model<"anthropic-messages">["provider"],
): string | undefined {
	const config = buildAnthropicClientConfig(makeAnthropicModel(provider), "some-key", false);
	return config.defaultHeaders["anthropic-beta"];
}

describe("MiniMax fine-grained-tool-streaming exclusion (#4538)", () => {
	test("minimax receives no anthropic-beta header (fine-grained-tool-streaming suppressed)", () => {
		const beta = getBetaHeader("minimax");
		assert.ok(
			beta === undefined || !beta.includes(FGTS_BETA),
			`minimax must not receive ${FGTS_BETA}; got anthropic-beta = ${JSON.stringify(beta)}`,
		);
	});

	test("minimax-cn receives no anthropic-beta header (fine-grained-tool-streaming suppressed)", () => {
		const beta = getBetaHeader("minimax-cn");
		assert.ok(
			beta === undefined || !beta.includes(FGTS_BETA),
			`minimax-cn must not receive ${FGTS_BETA}; got anthropic-beta = ${JSON.stringify(beta)}`,
		);
	});

	test("alibaba-coding-plan also suppresses fine-grained-tool-streaming (same bug class)", () => {
		const beta = getBetaHeader("alibaba-coding-plan");
		assert.ok(
			beta === undefined || !beta.includes(FGTS_BETA),
			`alibaba-coding-plan must not receive ${FGTS_BETA}; got anthropic-beta = ${JSON.stringify(beta)}`,
		);
	});

	test("regular anthropic provider still receives the fine-grained-tool-streaming beta", () => {
		// Sanity check — skipping the beta is specific to bug-class providers.
		const beta = getBetaHeader("anthropic");
		assert.ok(
			beta?.includes(FGTS_BETA),
			`anthropic provider should still opt into ${FGTS_BETA}; got anthropic-beta = ${JSON.stringify(beta)}`,
		);
	});
});

describe("empty tool name guard in convertMessages (#4538)", () => {
	// When fine-grained-tool-streaming causes a tool name to arrive as empty in
	// content_block_start, we must not store '' in conversation history.
	// convertMessages must skip tool_use blocks with empty/missing names.
	const minimaxModel = {
		id: "MiniMax-M2",
		api: "anthropic-messages" as const,
		provider: "minimax" as const,
		baseUrl: "https://api.minimax.io/anthropic",
		reasoning: true,
		input: ["text"] as ["text"],
		name: "MiniMax-M2",
		cost: { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 196608,
		maxTokens: 128000,
	};

	test("tool_use blocks with empty name are dropped from converted messages", () => {
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "toolu_01",
					name: "",        // empty — the bug: fine-grained streaming left name as ""
					arguments: { path: "/foo" },
				},
			],
			api: "anthropic-messages",
			provider: "minimax",
			model: "MiniMax-M2",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		const messages = [assistantMsg];
		const result = convertMessages(messages, minimaxModel, false, undefined);

		// The assistant block with the empty-name toolCall must not appear in the output.
		// If it does appear, its tool_use name must not be empty.
		for (const param of result) {
			if (param.role === "assistant" && Array.isArray(param.content)) {
				for (const block of param.content) {
					if ((block as any).type === "tool_use") {
						assert.ok(
							(block as any).name && (block as any).name.length > 0,
							`tool_use block must never have an empty name; got: "${(block as any).name}"`,
						);
					}
				}
			}
		}
	});
});
