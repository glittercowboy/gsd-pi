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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertMessages } from "./anthropic-shared.js";
import type { AssistantMessage } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, "anthropic.ts"), "utf-8");

describe("MiniMax fine-grained-tool-streaming exclusion (#4538)", () => {
	test("minimax is excluded from fine-grained-tool-streaming-2025-05-14 beta", () => {
		// The skipBetaHeaders flag must include minimax so it never receives the
		// fine-grained-tool-streaming beta that causes empty tool names.
		assert.match(
			source,
			/skipBetaHeaders.*minimax/s,
			"minimax must be included in skipBetaHeaders to suppress fine-grained-tool-streaming",
		);
	});

	test("minimax-cn is excluded from fine-grained-tool-streaming-2025-05-14 beta", () => {
		assert.match(
			source,
			/skipBetaHeaders.*minimax-cn/s,
			"minimax-cn must be included in skipBetaHeaders to suppress fine-grained-tool-streaming",
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
