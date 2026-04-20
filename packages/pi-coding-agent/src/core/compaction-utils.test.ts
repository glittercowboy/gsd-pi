import assert from "node:assert/strict";
import test from "node:test";

import type { Message } from "@gsd/pi-ai";

import { serializeConversation } from "./compaction/index.js";

test("serializeConversation uses narrative role markers instead of chat-style delimiters (#4054)", () => {
	const messages: Message[] = [
		{ role: "user", content: "Please refactor the parser." } as Message,
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "I should inspect the parser entry points first." },
				{ type: "text", text: "I'll start with the parser entry points." },
				{ type: "toolCall", id: "tool-1", name: "Read", arguments: { path: "src/parser.ts" } },
			],
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
			stopReason: "stop",
			timestamp: Date.now(),
		} as Message,
		{
			role: "toolResult",
			content: [{ type: "text", text: "parser contents" }],
			toolName: "Read",
			toolCallId: "tool-1",
		} as Message,
	];

	const serialized = serializeConversation(messages);

	assert.match(serialized, /\*\*User said:\*\* Please refactor the parser\./);
	assert.match(serialized, /\*\*Assistant thinking:\*\* I should inspect the parser entry points first\./);
	assert.match(serialized, /\*\*Assistant responded:\*\* I'll start with the parser entry points\./);
	assert.match(serialized, /\*\*Assistant tool calls:\*\* Read\(path="src\/parser\.ts"\)/);
	assert.match(serialized, /\*\*Tool result:\*\* parser contents/);
	assert.ok(!serialized.includes("[User]:"), "chat-style [User]: markers should not remain");
	assert.ok(!serialized.includes("[Assistant]:"), "chat-style [Assistant]: markers should not remain");
	assert.ok(!serialized.includes("[Tool result]:"), "chat-style [Tool result]: markers should not remain");
});
