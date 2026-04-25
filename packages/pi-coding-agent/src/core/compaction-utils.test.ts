import assert from "node:assert/strict";
import test from "node:test";

import type { Message } from "@gsd/pi-ai";

import { serializeConversation, truncateForSummary } from "./compaction/index.js";

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

// ---------------------------------------------------------------------------
// #4665 regression: head+tail truncation keeps verdicts/results
// ---------------------------------------------------------------------------

test("(#4665) truncateForSummary keeps both head AND tail — tail carries result/verdict text", () => {
	// Construct a 10K-char fixture where the HEAD is "setup noise" and the TAIL
	// contains a result line. The old head-only truncation would drop the tail
	// and lose the result. The fix preserves both.
	const head = "setup log line A\n".repeat(500); // ~8500 chars of setup
	const tail = "RESULT: 258 passed, 0 failed. exit_code=0 commit=abc1234";
	const input = head + tail;

	const out = truncateForSummary(input, 2_000);

	assert.ok(out.length < input.length, "must truncate when over cap");
	assert.ok(out.includes("setup log line A"), "head content preserved");
	assert.ok(out.includes("RESULT: 258 passed"), "tail content preserved (issue #4665)");
	assert.match(out, /more characters truncated/, "emits an elision marker");
});

test("(#4665) truncateForSummary is a no-op when input is within the cap", () => {
	const input = "short enough";
	assert.equal(truncateForSummary(input, 2_000), input);
});

test("(#4665) serializeConversation caps large user content, not just tool results", () => {
	// Pre-fix, only toolResult blocks were capped. A large user paste could
	// still blow out the chunker's token math and the LLM's input budget.
	const hugeUserText = "U".repeat(100_000);
	const hugeAssistantText = "A".repeat(100_000);
	const hugeToolResult = "T".repeat(100_000);

	const messages: Message[] = [
		{ role: "user", content: hugeUserText } as Message,
		{
			role: "assistant",
			content: [{ type: "text", text: hugeAssistantText }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			usage: {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		} as Message,
		{
			role: "toolResult",
			content: [{ type: "text", text: hugeToolResult }],
			toolName: "Bash",
			toolCallId: "tool-huge",
		} as Message,
	];

	const serialized = serializeConversation(messages);

	// Each block is truncated independently to TOOL_RESULT_MAX_CHARS plus the
	// framing marker, so the serialized output should be a tiny fraction of
	// the raw 300K chars of content.
	assert.ok(
		serialized.length < 10_000,
		`serialized output should be small after capping all blocks, got ${serialized.length} chars`,
	);
	assert.match(serialized, /more characters truncated/, "truncation marker present");
});
