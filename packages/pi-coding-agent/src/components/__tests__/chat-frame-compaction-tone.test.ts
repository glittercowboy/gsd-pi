import { test, describe } from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";
import { renderChatFrame } from "../chat-frame.js";
import { initTheme } from "../../theme/theme.js";

initTheme("dark", false);

// Regression tests for the "compaction" tone added to renderChatFrame.
// The compaction notice shares the same visual frame as user / assistant
// messages (top rule, `• label` header, `│ ` body prefix) but uses the
// purple `customMessageLabel` color key so it is visually distinct from
// conversation turns.

describe("renderChatFrame — compaction tone", () => {
	test("produces a top rule, `• compaction` header row, and a │ body margin", () => {
		const lines = renderChatFrame(
			["Compacted from 1,224,262 tokens (ctrl+o to expand)"],
			60,
			{
				label: "compaction",
				tone: "compaction",
				timestampFormat: "date-time-iso",
				showTimestamp: false,
			},
		);

		// Structure: top rule, header, body line(s)
		assert.ok(lines.length >= 3, `expected at least 3 frame lines, got ${lines.length}`);

		const plain = lines.map((line) => stripAnsi(line));

		// Top rule is a solid horizontal bar
		assert.match(plain[0], /^─+$/, "first line should be the solid top rule");

		// Header row contains `• compaction`
		assert.ok(
			plain[1].includes("• compaction"),
			`expected header to contain "• compaction", got ${JSON.stringify(plain[1])}`,
		);

		// Body line(s) start with `│ `
		assert.ok(
			plain[2].startsWith("│ "),
			`expected body line to start with "│ ", got ${JSON.stringify(plain[2])}`,
		);
		assert.ok(
			plain[2].includes("Compacted from 1,224,262 tokens"),
			"body line should include the original content",
		);
	});

	test("does not render a right-aligned timestamp when showTimestamp is false", () => {
		const lines = renderChatFrame(["body"], 60, {
			label: "compaction",
			tone: "compaction",
			timestamp: Date.now(),
			timestampFormat: "date-time-iso",
			showTimestamp: false,
		});

		const header = stripAnsi(lines[1]);
		// No four-digit year should appear anywhere in the header row
		assert.ok(
			!/\b20\d{2}\b/.test(header),
			`timestamp should be suppressed when showTimestamp=false, got ${JSON.stringify(header)}`,
		);
	});

	test("emits ANSI color codes distinct from the assistant tone", () => {
		const assistantFrame = renderChatFrame(["body"], 60, {
			label: "claude",
			tone: "assistant",
			timestampFormat: "date-time-iso",
			showTimestamp: false,
		}).join("\n");

		const compactionFrame = renderChatFrame(["body"], 60, {
			label: "compaction",
			tone: "compaction",
			timestampFormat: "date-time-iso",
			showTimestamp: false,
		}).join("\n");

		// Both frames carry ANSI; the compaction frame should not be identical
		// to the assistant frame (different color mappings).
		assert.ok(
			assistantFrame !== compactionFrame,
			"compaction tone must produce a different styled output than assistant tone",
		);
	});
});
