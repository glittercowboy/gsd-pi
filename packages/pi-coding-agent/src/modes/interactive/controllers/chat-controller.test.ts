import assert from "node:assert/strict";
import test from "node:test";

import { findLatestPinnableText } from "./chat-controller.js";

test("findLatestPinnableText: empty content returns empty string", () => {
	assert.equal(findLatestPinnableText([]), "");
});

test("findLatestPinnableText: no tool calls returns empty string", () => {
	const blocks = [
		{ type: "text", text: "hello" },
		{ type: "text", text: "world" },
	];
	assert.equal(findLatestPinnableText(blocks), "");
});

test("findLatestPinnableText: returns text preceding a tool call", () => {
	const blocks = [
		{ type: "text", text: "doing the thing" },
		{ type: "toolCall", id: "1", name: "Read" },
	];
	assert.equal(findLatestPinnableText(blocks), "doing the thing");
});

test("findLatestPinnableText: ignores trailing streaming text after the last tool call (regression: pinned mirror duplicated chat-container tokens)", () => {
	const blocks = [
		{ type: "text", text: "first prose" },
		{ type: "toolCall", id: "1", name: "Read" },
		{ type: "text", text: "second prose still streaming" },
	];
	assert.equal(findLatestPinnableText(blocks), "first prose");
});

test("findLatestPinnableText: with multiple tools, picks text before the most recent tool call", () => {
	const blocks = [
		{ type: "text", text: "first" },
		{ type: "toolCall", id: "1", name: "Read" },
		{ type: "text", text: "second" },
		{ type: "toolCall", id: "2", name: "Grep" },
		{ type: "text", text: "third streaming" },
	];
	assert.equal(findLatestPinnableText(blocks), "second");
});

test("findLatestPinnableText: treats serverToolUse the same as toolCall", () => {
	const blocks = [
		{ type: "text", text: "before web search" },
		{ type: "serverToolUse", id: "ws1", name: "web_search" },
		{ type: "text", text: "answer streaming" },
	];
	assert.equal(findLatestPinnableText(blocks), "before web search");
});

test("findLatestPinnableText: skips empty/whitespace-only text blocks", () => {
	const blocks = [
		{ type: "text", text: "real prose" },
		{ type: "text", text: "   " },
		{ type: "text", text: "" },
		{ type: "toolCall", id: "1", name: "Read" },
	];
	assert.equal(findLatestPinnableText(blocks), "real prose");
});

test("findLatestPinnableText: thinking blocks are not pinnable", () => {
	const blocks = [
		{ type: "thinking", thinking: "internal" },
		{ type: "toolCall", id: "1", name: "Read" },
	];
	assert.equal(findLatestPinnableText(blocks), "");
});
