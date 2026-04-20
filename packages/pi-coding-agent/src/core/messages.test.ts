/**
 * messages.test.ts — Tests for convertToLlm custom message handling.
 *
 * Reproduction test for #3026: background job completion notifications
 * delivered as custom messages must be clearly distinguishable from
 * user-typed input when converted to LLM messages.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { convertToLlm, type CustomMessage } from "./messages.js";

/** Extract the first content block from a message, asserting array content. */
function firstTextBlock(msg: ReturnType<typeof convertToLlm>[number]) {
	const { content } = msg;
	assert.ok(Array.isArray(content), "Expected content to be an array");
	const block = content[0];
	assert.ok(typeof block === "object" && block !== null, "Expected first block to be an object");
	return block;
}

test("convertToLlm wraps custom messages with system notification prefix", () => {
	const customMsg: CustomMessage = {
		role: "custom",
		customType: "async_job_result",
		content: "**Background job done: bg_abc123** (sleep 2, 2.1s)\n\ndone",
		display: true,
		timestamp: Date.now(),
	};

	const result = convertToLlm([customMsg]);
	assert.equal(result.length, 1);
	assert.equal(result[0].role, "user");

	// The content must include a system notification wrapper so the LLM
	// does not confuse it with user input (#3026).
	const text = firstTextBlock(result[0]);
	assert.equal(text.type, "text");
	assert.ok(
		"text" in text && text.text.includes("[system notification"),
		"Custom message should be wrapped with system notification marker",
	);
});

test("convertToLlm wraps custom messages with array content", () => {
	const customMsg: CustomMessage = {
		role: "custom",
		customType: "bg-shell-status",
		content: [{ type: "text", text: "Background processes:\n  ✓ bg1 dev-server :3000" }],
		display: false,
		timestamp: Date.now(),
	};

	const result = convertToLlm([customMsg]);
	assert.equal(result.length, 1);
	assert.equal(result[0].role, "user");

	const text = firstTextBlock(result[0]);
	assert.equal(text.type, "text");
	assert.ok(
		"text" in text && text.text.includes("[system notification"),
		"Custom message with array content should be wrapped with system notification marker",
	);
});

test("convertToLlm includes customType in notification wrapper", () => {
	const customMsg: CustomMessage = {
		role: "custom",
		customType: "async_job_result",
		content: "job output here",
		display: true,
		timestamp: Date.now(),
	};

	const result = convertToLlm([customMsg]);
	const text = firstTextBlock(result[0]);
	assert.ok(
		"text" in text && text.text.includes("async_job_result"),
		"Notification wrapper should include the customType for context",
	);
});

test("convertToLlm notification wrapper instructs LLM not to treat as user input", () => {
	const customMsg: CustomMessage = {
		role: "custom",
		customType: "async_job_result",
		content: "**Background job done: bg_abc123** (sleep 2, 2.1s)\n\ndone",
		display: true,
		timestamp: Date.now(),
	};

	const result = convertToLlm([customMsg]);
	const text = firstTextBlock(result[0]);
	assert.ok(
		"text" in text && text.text.includes("not user input"),
		"Notification should explicitly state this is not user input",
	);
});

test("convertToLlm preserves user messages without wrapper", () => {
	const userMsg = {
		role: "user" as const,
		content: [{ type: "text" as const, text: "Hello world" }],
		timestamp: Date.now(),
	};

	const result = convertToLlm([userMsg]);
	assert.equal(result.length, 1);
	const text = firstTextBlock(result[0]);
	assert.ok(
		"text" in text && text.text === "Hello world",
		"User messages should pass through unchanged",
	);
});
