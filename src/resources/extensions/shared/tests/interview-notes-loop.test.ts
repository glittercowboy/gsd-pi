// GSD2 — Regression test for interview-ui "None of the above" notes loop
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

/**
 * Regression test for bug #3502:
 *
 * Selecting "None of the above" opens the notes field, but pressing Enter
 * after typing a note called goNextOrSubmit() which saw the cursor still
 * on the "None of the above" slot and re-opened notes — trapping the user
 * in an infinite loop.
 *
 * The fix adds a `!states[currentIdx].notes` guard so auto-open only fires
 * when notes are still empty.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { showInterviewRound, type Question, type RoundResult } from "../interview-ui.js";

// Raw terminal sequences that matchesKey() recognises
const ENTER = "\r";
const DOWN = "\x1b[B";
const TAB = "\t";

/**
 * Drive showInterviewRound with a scripted sequence of key inputs.
 * We mock ctx.ui.custom() to capture the widget, feed it inputs, and
 * resolve when done() is called.
 */
function runWithInputs(
	questions: Question[],
	inputs: string[],
): Promise<RoundResult> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Timed out — likely stuck in infinite loop")), 3000);

		const mockCtx = {
			ui: {
				custom: (factory: any) => {
					const mockTui = {
						requestRender: () => {},
					};
					const mockTheme = {
						// Minimal theme stubs — render output is not asserted
						fg: (_c: string, t: string) => t,
						bold: (t: string) => t,
						dim: (t: string) => t,
						italic: (t: string) => t,
						strikethrough: (t: string) => t,
						accent: (t: string) => t,
						success: (t: string) => t,
						warning: (t: string) => t,
						error: (t: string) => t,
						info: (t: string) => t,
						muted: (t: string) => t,
						dimmed: (t: string) => t,
					};
					const mockKb = {};

					const widget = factory(mockTui, mockTheme, mockKb, (result: RoundResult) => {
						clearTimeout(timeout);
						resolve(result);
					});

					// Feed each input sequentially
					for (const input of inputs) {
						widget.handleInput(input);
					}
				},
			},
		};

		showInterviewRound(questions, {}, mockCtx as any).catch(reject);
	});
}

describe("interview-ui notes loop regression (#3502)", () => {
	const questions: Question[] = [
		{
			id: "q1",
			header: "Project Type",
			question: "What type of project?",
			options: [
				{ label: "Web App", description: "Frontend or full-stack" },
				{ label: "CLI Tool", description: "Command-line utility" },
			],
		},
	];

	it("does not loop when Enter is pressed after typing a note on 'None of the above'", async () => {
		// With 2 options, "None of the above" is index 2 (0-based)
		// Cursor starts at 0, so press Down twice to reach it
		const result = await runWithInputs(questions, [
			DOWN,        // cursor → index 1 (CLI Tool)
			DOWN,        // cursor → index 2 (None of the above)
			ENTER,       // commit → auto-opens notes field
			"u", "n", "s", "u", "r", "e",  // type "unsure"
			ENTER,       // should advance to review, NOT reopen notes
			ENTER,       // submit from review screen
		]);

		// If we get here, the loop did not occur (timeout would have fired)
		assert.ok(result, "should return a result");
		assert.equal(result.endInterview, false);

		const answer = result.answers.q1;
		assert.ok(answer, "answer for q1 should exist");
		assert.equal(answer.notes, "unsure", "notes should contain typed text");
		assert.equal(answer.selected, "None of the above");
	});

	it("still auto-opens notes when selecting 'None of the above' with no prior notes", async () => {
		// Press Down twice to "None of the above", Enter to select
		// Then immediately Enter again (empty notes) — this should re-open notes
		// because the guard only skips when notes are non-empty.
		// Type something on second open, then Enter to proceed.
		const result = await runWithInputs(questions, [
			DOWN,        // cursor → 1
			DOWN,        // cursor → 2 (None of the above)
			ENTER,       // commit → auto-opens notes
			ENTER,       // empty notes → goNextOrSubmit → should re-open notes (empty guard)
			"o", "k",    // type "ok"
			ENTER,       // now notes = "ok" → should advance to review
			ENTER,       // submit
		]);

		assert.ok(result, "should return a result");
		const answer = result.answers.q1;
		assert.ok(answer, "answer for q1 should exist");
		assert.equal(answer.notes, "ok");
	});

	it("normal option selection is unaffected", async () => {
		const result = await runWithInputs(questions, [
			ENTER,       // select first option (Web App) and advance to review
			ENTER,       // submit from review screen
		]);

		assert.ok(result, "should return a result");
		const answer = result.answers.q1;
		assert.ok(answer, "answer for q1 should exist");
		assert.equal(answer.selected, "Web App");
	});
});
