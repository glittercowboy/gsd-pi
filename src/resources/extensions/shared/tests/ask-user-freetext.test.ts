/**
 * Tests for ask-user-questions free-text input behavior.
 *
 * Bug #2715: The ask-user-questions UI lacks free-text input and can trap
 * users in a loop when the agent needs an explanation rather than a fixed
 * choice.
 *
 * These tests exercise the RPC fallback path (ctx.ui.select) in
 * ask-user-questions.ts to ensure that selecting "None of the above"
 * triggers a follow-up free-text input prompt via ctx.ui.input().
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// The ask-user-questions extension registers a tool via pi.registerTool().
// We capture that registration and call execute() directly with a mock context.
import AskUserQuestions from "../../ask-user-questions.js";
import { resetAskUserQuestionsCache } from "../../ask-user-questions.js";

interface CapturedTool {
	name: string;
	execute: (...args: any[]) => Promise<any>;
}

function captureTool(): CapturedTool {
	let captured: CapturedTool | null = null;
	const fakePi = {
		registerTool(tool: any) {
			captured = { name: tool.name, execute: tool.execute };
		},
	};
	AskUserQuestions(fakePi as any);
	if (!captured) throw new Error("No tool registered");
	return captured;
}

function makeQuestion(id: string, options: string[]) {
	return {
		id,
		header: id,
		question: `Pick for ${id}`,
		options: options.map((label) => ({ label, description: `Desc for ${label}` })),
	};
}

function makeMockCtx(opts: {
	selectReturns: (string | string[] | undefined)[];
	inputReturns?: (string | undefined)[];
}) {
	let selectCallIdx = 0;
	let inputCallIdx = 0;
	const selectCalls: { title: string; options: string[] }[] = [];
	const inputCalls: { title: string; placeholder?: string }[] = [];

	return {
		ctx: {
			hasUI: true,
			ui: {
				custom: () => undefined, // force RPC fallback
				select: async (title: string, options: string[], selectOpts?: any) => {
					selectCalls.push({ title, options });
					return opts.selectReturns[selectCallIdx++];
				},
				input: async (title: string, placeholder?: string) => {
					inputCalls.push({ title, placeholder });
					return (opts.inputReturns ?? [])[inputCallIdx++];
				},
			},
		},
		selectCalls,
		inputCalls,
	};
}

describe("ask-user-questions RPC fallback free-text", () => {
	beforeEach(() => {
		resetAskUserQuestionsCache();
	});

	it("prompts for free-text input when user selects 'None of the above'", async () => {
		const tool = captureTool();
		const { ctx, selectCalls, inputCalls } = makeMockCtx({
			selectReturns: ["None of the above"],
			inputReturns: ["I need to explain my reasoning"],
		});

		const params = {
			questions: [makeQuestion("q1", ["Option A", "Option B"])],
		};

		const result = await tool.execute("call-1", params, undefined, undefined, ctx);

		// The select should have been called with "None of the above" appended
		assert.equal(selectCalls.length, 1);
		assert.ok(
			selectCalls[0].options.includes("None of the above"),
			"select options should include 'None of the above'",
		);

		// A follow-up input() call should have been made to collect free text
		assert.equal(inputCalls.length, 1, "should call ctx.ui.input() for free-text after 'None of the above'");

		// The result should include the user's free-text note
		const text = result.content[0]?.text;
		assert.ok(text, "result should have text content");
		const parsed = JSON.parse(text);
		assert.ok(
			parsed.answers.q1,
			"answer for q1 should exist",
		);
		const q1Answers = parsed.answers.q1.answers;
		assert.ok(
			q1Answers.some((a: string) => a.includes("I need to explain my reasoning")),
			"answer should include the free-text explanation",
		);
	});

	it("does NOT prompt for free-text when user selects a normal option", async () => {
		const tool = captureTool();
		const { ctx, inputCalls } = makeMockCtx({
			selectReturns: ["Option A"],
		});

		const params = {
			questions: [makeQuestion("q1", ["Option A", "Option B"])],
		};

		const result = await tool.execute("call-2", params, undefined, undefined, ctx);

		// No input() call should have been made
		assert.equal(inputCalls.length, 0, "should NOT call ctx.ui.input() for a normal option");

		const text = result.content[0]?.text;
		const parsed = JSON.parse(text);
		assert.deepStrictEqual(parsed.answers.q1.answers, ["Option A"]);
	});

	it("handles cancelled free-text input gracefully", async () => {
		const tool = captureTool();
		const { ctx, inputCalls } = makeMockCtx({
			selectReturns: ["None of the above"],
			inputReturns: [undefined], // user cancelled the input
		});

		const params = {
			questions: [makeQuestion("q1", ["Option A", "Option B"])],
		};

		const result = await tool.execute("call-3", params, undefined, undefined, ctx);

		// Input should still have been called
		assert.equal(inputCalls.length, 1, "should call ctx.ui.input() even if user cancels");

		// Result should still contain "None of the above" without a note
		const text = result.content[0]?.text;
		assert.ok(text, "result should have text content");
		const parsed = JSON.parse(text);
		assert.deepStrictEqual(parsed.answers.q1.answers, ["None of the above"]);
	});
});
