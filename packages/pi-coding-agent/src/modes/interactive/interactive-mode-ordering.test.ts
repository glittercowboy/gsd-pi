import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAssistantReplaySegments } from "./interactive-mode.js";

test("buildAssistantReplaySegments preserves tool-first ordering", () => {
	const segments = buildAssistantReplaySegments([
		{ type: "toolCall", id: "t1", name: "read", arguments: {} },
		{ type: "text", text: "Done." },
	]);

	assert.deepEqual(segments, [
		{ kind: "tool", contentIndex: 0 },
		{ kind: "assistant", startIndex: 1, endIndex: 1 },
	]);
});

test("buildAssistantReplaySegments preserves interleaved assistant-tool-assistant runs", () => {
	const segments = buildAssistantReplaySegments([
		{ type: "text", text: "Let me check." },
		{ type: "serverToolUse", id: "s1", name: "mcp__fs__glob", input: {} },
		{ type: "thinking", thinking: "Tool result looks good." },
		{ type: "text", text: "Here is the answer." },
	]);

	assert.deepEqual(segments, [
		{ kind: "assistant", startIndex: 0, endIndex: 0 },
		{ kind: "tool", contentIndex: 1 },
		{ kind: "assistant", startIndex: 2, endIndex: 3 },
	]);
});

test("buildAssistantReplaySegments ignores non-rendered non-tool blocks", () => {
	const segments = buildAssistantReplaySegments([
		{ type: "text", text: "before" },
		{ type: "webSearchResult", toolUseId: "s1", content: {} },
		{ type: "text", text: "after" },
	]);

	assert.deepEqual(segments, [
		{ kind: "assistant", startIndex: 0, endIndex: 0 },
		{ kind: "assistant", startIndex: 2, endIndex: 2 },
	]);
});
