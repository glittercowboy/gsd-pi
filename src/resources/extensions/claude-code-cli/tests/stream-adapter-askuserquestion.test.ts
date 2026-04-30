import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
	convertAskUserQuestionInputToQuestions,
	roundResultToAskUserQuestionAnswers,
} from "../stream-adapter.ts";

describe("convertAskUserQuestionInputToQuestions", () => {
	test("converts a valid single-question single-select input", () => {
		const input = {
			questions: [
				{
					question: "Pick one",
					header: "Q1",
					multiSelect: false,
					options: [
						{ label: "A", description: "First" },
						{ label: "B", description: "Second" },
					],
				},
			],
		};
		const result = convertAskUserQuestionInputToQuestions(input);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.questions.length, 1);
		assert.equal(result.questions[0].id, "q_0");
		assert.equal(result.questions[0].header, "Q1");
		assert.equal(result.questions[0].question, "Pick one");
		assert.equal(result.questions[0].allowMultiple, false);
		assert.equal(result.questions[0].options.length, 2);
		assert.equal(result.questions[0].options[0].label, "A");
		assert.equal(result.questions[0].options[0].description, "First");
	});
});

describe("convertAskUserQuestionInputToQuestions invalid inputs", () => {
	test("rejects missing questions array", () => {
		const r = convertAskUserQuestionInputToQuestions({});
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.match(r.reason, /missing questions array/);
	});
	test("rejects empty questions array", () => {
		const r = convertAskUserQuestionInputToQuestions({ questions: [] });
		assert.equal(r.ok, false);
	});
	test("rejects question missing question text", () => {
		const r = convertAskUserQuestionInputToQuestions({
			questions: [{ header: "H", multiSelect: false, options: [{ label: "A", description: "" }] }],
		});
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.match(r.reason, /question 0 missing question text/);
	});
	test("rejects question missing header", () => {
		const r = convertAskUserQuestionInputToQuestions({
			questions: [{ question: "Q", multiSelect: false, options: [{ label: "A", description: "" }] }],
		});
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.match(r.reason, /question 0 missing header/);
	});
	test("rejects question missing multiSelect boolean", () => {
		const r = convertAskUserQuestionInputToQuestions({
			questions: [{ question: "Q", header: "H", options: [{ label: "A", description: "" }] }],
		});
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.match(r.reason, /multiSelect boolean/);
	});
	test("rejects question with empty options array", () => {
		const r = convertAskUserQuestionInputToQuestions({
			questions: [{ question: "Q", header: "H", multiSelect: false, options: [] }],
		});
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.match(r.reason, /empty options array/);
	});
	test("rejects option missing label", () => {
		const r = convertAskUserQuestionInputToQuestions({
			questions: [{ question: "Q", header: "H", multiSelect: false, options: [{ description: "x" }] }],
		});
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.match(r.reason, /option 0 missing label/);
	});
	test("rejects option missing description", () => {
		const r = convertAskUserQuestionInputToQuestions({
			questions: [{ question: "Q", header: "H", multiSelect: false, options: [{ label: "L" }] }],
		});
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.match(r.reason, /option 0 missing description/);
	});
	test("preserves preview field when present", () => {
		const r = convertAskUserQuestionInputToQuestions({
			questions: [{
				question: "Q", header: "H", multiSelect: false,
				options: [{ label: "A", description: "d", preview: "```ts\nfoo\n```" }],
			}],
		});
		assert.equal(r.ok, true);
		if (!r.ok) return;
		assert.equal(r.questions[0].options[0].preview, "```ts\nfoo\n```");
	});
	test("converts multi-question multi-select input", () => {
		const r = convertAskUserQuestionInputToQuestions({
			questions: [
				{ question: "Q1", header: "H1", multiSelect: false,
					options: [{ label: "A", description: "" }, { label: "B", description: "" }] },
				{ question: "Q2", header: "H2", multiSelect: true,
					options: [{ label: "X", description: "" }, { label: "Y", description: "" }] },
			],
		});
		assert.equal(r.ok, true);
		if (!r.ok) return;
		assert.equal(r.questions.length, 2);
		assert.equal(r.questions[0].id, "q_0");
		assert.equal(r.questions[0].allowMultiple, false);
		assert.equal(r.questions[1].id, "q_1");
		assert.equal(r.questions[1].allowMultiple, true);
	});
	test("rejects payloads with duplicate question text", () => {
		const r = convertAskUserQuestionInputToQuestions({
			questions: [
				{ question: "Same?", header: "H1", multiSelect: false,
					options: [{ label: "A", description: "" }] },
				{ question: "Same?", header: "H2", multiSelect: false,
					options: [{ label: "B", description: "" }] },
			],
		});
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.match(r.reason, /duplicate question text: Same\?/);
	});
	test("rejects duplicate option labels within a question", () => {
		const r = convertAskUserQuestionInputToQuestions({
			questions: [
				{ question: "Q", header: "H", multiSelect: false,
					options: [
						{ label: "A", description: "first" },
						{ label: "A", description: "second" },
					] },
			],
		});
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.match(r.reason, /duplicate option label "A"/);
	});
});

describe("roundResultToAskUserQuestionAnswers", () => {
	const input = {
		questions: [
			{ question: "Pick one", header: "Q1", multiSelect: false,
				options: [{ label: "A", description: "" }, { label: "B", description: "" }] },
			{ question: "Pick many", header: "Q2", multiSelect: true,
				options: [{ label: "X", description: "" }, { label: "Y", description: "" }] },
		],
	};

	test("maps single-select string answer keyed by question text", () => {
		const r = roundResultToAskUserQuestionAnswers(input as any, {
			endInterview: false,
			answers: { q_0: { selected: "A", notes: "" } },
		});
		assert.equal(r["Pick one"], "A");
		assert.equal(r["Pick many"], undefined);
	});

	test("joins multi-select array with comma-space", () => {
		const r = roundResultToAskUserQuestionAnswers(input as any, {
			endInterview: false,
			answers: { q_1: { selected: ["X", "Y"], notes: "" } },
		});
		assert.equal(r["Pick many"], "X, Y");
	});

	test("includes both questions when both answered", () => {
		const r = roundResultToAskUserQuestionAnswers(input as any, {
			endInterview: false,
			answers: {
				q_0: { selected: "B", notes: "" },
				q_1: { selected: ["X"], notes: "" },
			},
		});
		assert.equal(r["Pick one"], "B");
		assert.equal(r["Pick many"], "X");
	});

	test("omits questions with no answer entry", () => {
		const r = roundResultToAskUserQuestionAnswers(input as any, {
			endInterview: false,
			answers: {},
		});
		assert.deepEqual(r, {});
	});

	test("omits questions with empty-string selected", () => {
		const r = roundResultToAskUserQuestionAnswers(input as any, {
			endInterview: false,
			answers: { q_0: { selected: "", notes: "" } },
		});
		assert.deepEqual(r, {});
	});

	test("omits questions with empty-array selected", () => {
		const r = roundResultToAskUserQuestionAnswers(input as any, {
			endInterview: false,
			answers: { q_1: { selected: [], notes: "" } },
		});
		assert.deepEqual(r, {});
	});
});

import { createClaudeCodeCanUseToolHandler } from "../stream-adapter.ts";

describe("createClaudeCodeCanUseToolHandler — AskUserQuestion intercept", () => {
	const validInput = {
		questions: [
			{
				question: "Pick one",
				header: "Q1",
				multiSelect: false,
				options: [
					{ label: "A", description: "first" },
					{ label: "B", description: "second" },
				],
			},
		],
	};

	test("uses ui.askInterview when present and returns answers", async () => {
		const ui: any = {
			askInterview: async () => ({
				endInterview: false,
				answers: { q_0: { selected: "A", notes: "" } },
			}),
			select: async () => "Allow",
		};
		const handler = createClaudeCodeCanUseToolHandler(ui);
		assert.ok(handler);
		const controller = new AbortController();
		const result = await handler!("AskUserQuestion", validInput as any, {
			signal: controller.signal,
			toolUseID: "tu_1",
			suggestions: [],
		} as any);
		assert.equal(result.behavior, "allow");
		if (result.behavior !== "allow") return;
		const updatedInput = result.updatedInput as { answers: Record<string, string> };
		assert.deepEqual(updatedInput.answers, { "Pick one": "A" });
	});

	test("denies with reason when input is malformed", async () => {
		const ui: any = { askInterview: async () => undefined, select: async () => undefined };
		const handler = createClaudeCodeCanUseToolHandler(ui);
		const result = await handler!("AskUserQuestion", { not: "valid" } as any, {
			signal: new AbortController().signal,
			toolUseID: "tu_2",
			suggestions: [],
		} as any);
		assert.equal(result.behavior, "deny");
		if (result.behavior !== "deny") return;
		assert.match(result.message ?? "", /^AskUserQuestion: /);
	});

	test("denies when askInterview returns empty answers", async () => {
		const ui: any = {
			askInterview: async () => ({ endInterview: false, answers: {} }),
		};
		const handler = createClaudeCodeCanUseToolHandler(ui);
		const result = await handler!("AskUserQuestion", validInput as any, {
			signal: new AbortController().signal,
			toolUseID: "tu_3",
			suggestions: [],
		} as any);
		assert.equal(result.behavior, "deny");
		if (result.behavior !== "deny") return;
		assert.equal(result.message, "User declined to answer questions");
	});

	test("denies when AbortSignal already fired", async () => {
		const ui: any = { askInterview: async () => ({ endInterview: false, answers: {} }) };
		const handler = createClaudeCodeCanUseToolHandler(ui);
		const controller = new AbortController();
		controller.abort();
		const result = await handler!("AskUserQuestion", validInput as any, {
			signal: controller.signal,
			toolUseID: "tu_4",
			suggestions: [],
		} as any);
		assert.equal(result.behavior, "deny");
		if (result.behavior !== "deny") return;
		assert.equal(result.message, "Aborted");
	});

	test("falls back to sequential ui.select when askInterview is undefined", async () => {
		const ui: any = {
			select: async (_title: string, options: string[]) => options[0],
		};
		const handler = createClaudeCodeCanUseToolHandler(ui);
		const result = await handler!("AskUserQuestion", validInput as any, {
			signal: new AbortController().signal,
			toolUseID: "tu_5",
			suggestions: [],
		} as any);
		assert.equal(result.behavior, "allow");
		if (result.behavior !== "allow") return;
		const updatedInput = result.updatedInput as { answers: Record<string, string> };
		assert.equal(updatedInput.answers["Pick one"], "A");
	});

	test("falls back to ui.select when askInterview returns undefined", async () => {
		const ui: any = {
			askInterview: async () => undefined,
			select: async (_title: string, options: string[]) => options[0],
		};
		const handler = createClaudeCodeCanUseToolHandler(ui);
		const result = await handler!("AskUserQuestion", validInput as any, {
			signal: new AbortController().signal,
			toolUseID: "tu_fb",
			suggestions: [],
		} as any);
		assert.equal(result.behavior, "allow");
		if (result.behavior !== "allow") return;
		const updatedInput = result.updatedInput as { answers: Record<string, string> };
		assert.equal(updatedInput.answers["Pick one"], "A");
	});

	test("fallback maps display labels back to original on collision", async () => {
		// Construct two options whose display strings would collide if
		// "label — description" weren't disambiguated:
		// option 0 — label="A — B", description=""        → "A — B"
		// option 1 — label="A",      description="B"       → "A — B"
		// The fallback's Map adds " (2)" to the second to make it injective.
		const collisionInput = {
			questions: [
				{
					question: "Pick",
					header: "Q",
					multiSelect: false,
					options: [
						{ label: "A — B", description: "" },
						{ label: "A", description: "B" },
					],
				},
			],
		};
		// Capture what ui.select was offered, then pick the second label.
		let offeredOptions: string[] = [];
		const ui: any = {
			select: async (_title: string, options: string[]) => {
				offeredOptions = options;
				return options[1];
			},
		};
		const handler = createClaudeCodeCanUseToolHandler(ui);
		const result = await handler!("AskUserQuestion", collisionInput as any, {
			signal: new AbortController().signal,
			toolUseID: "tu_collision",
			suggestions: [],
		} as any);
		assert.equal(result.behavior, "allow");
		if (result.behavior !== "allow") return;
		assert.notEqual(offeredOptions[0], offeredOptions[1]);
		const updatedInput = result.updatedInput as { answers: Record<string, string> };
		assert.equal(updatedInput.answers["Pick"], "A");
	});

	test("denies when answers are partial (count != questions)", async () => {
		const twoQuestionInput = {
			questions: [
				{ question: "Q1", header: "H1", multiSelect: false,
					options: [{ label: "A", description: "" }] },
				{ question: "Q2", header: "H2", multiSelect: false,
					options: [{ label: "B", description: "" }] },
			],
		};
		const ui: any = {
			askInterview: async () => ({
				endInterview: false,
				answers: { q_0: { selected: "A", notes: "" } },
			}),
		};
		const handler = createClaudeCodeCanUseToolHandler(ui);
		const result = await handler!("AskUserQuestion", twoQuestionInput as any, {
			signal: new AbortController().signal,
			toolUseID: "tu_6",
			suggestions: [],
		} as any);
		assert.equal(result.behavior, "deny");
		if (result.behavior !== "deny") return;
		assert.equal(result.message, "User declined to answer questions");
	});
});
