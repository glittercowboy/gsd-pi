import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { isContextOverflow } from "../overflow.js";
import type { AssistantMessage } from "../../types.js";

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("isContextOverflow", () => {
	test("detects overflow from provider errorMessage", () => {
		const message = makeAssistantMessage({
			errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
		});

		assert.equal(isContextOverflow(message, 200000), true);
	});

	test("detects claude-code overflow when text contains the error but errorMessage is generic (#3925)", () => {
		const message = makeAssistantMessage({
			provider: "claude-code",
			api: "anthropic-messages",
			model: "claude-sonnet-4-6",
			errorMessage: "success",
			content: [{ type: "text", text: "Prompt is too long" }],
		});

		assert.equal(isContextOverflow(message, 200000), true);
	});

	test("does not treat normal non-error text as overflow", () => {
		const message = makeAssistantMessage({
			stopReason: "stop",
			errorMessage: undefined,
			content: [{ type: "text", text: "Prompt is too long" }],
		});

		assert.equal(isContextOverflow(message, 200000), false);
	});
});
