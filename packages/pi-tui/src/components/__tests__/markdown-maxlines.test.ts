import assert from "node:assert/strict";
import { test } from "node:test";

import { Markdown, type MarkdownTheme } from "../markdown.js";

function noopTheme(): MarkdownTheme {
	const identity = (text: string) => text;
	return {
		heading: identity,
		link: identity,
		linkUrl: identity,
		code: identity,
		codeBlock: identity,
		codeBlockBorder: identity,
		quote: identity,
		quoteBorder: identity,
		hr: identity,
		listBullet: identity,
		bold: identity,
		italic: identity,
		strikethrough: identity,
		underline: identity,
	};
}

test("Markdown renders all lines when maxLines is not set", () => {
	const text = "Line 1\n\nLine 2\n\nLine 3\n\nLine 4\n\nLine 5";
	const md = new Markdown(text, 0, 0, noopTheme());
	const lines = md.render(80);
	// Each paragraph produces a line + an inter-paragraph blank line
	const contentLines = lines.filter((l) => l.trim().length > 0);
	// Verify all 5 content lines are present (not just a lower bound)
	assert.equal(contentLines.length, 5);
	assert.ok(contentLines.some((l) => l.includes("Line 1")));
	assert.ok(contentLines.some((l) => l.includes("Line 5")));
});

test("Markdown truncates from the top when maxLines is exceeded", () => {
	const text = "Line 1\n\nLine 2\n\nLine 3\n\nLine 4\n\nLine 5";
	const md = new Markdown(text, 0, 0, noopTheme());
	md.maxLines = 3;
	const lines = md.render(80);
	assert.ok(lines.length <= 3, `expected at most 3 lines, got ${lines.length}`);
	// First line should contain an ellipsis indicator (not tied to English copy)
	assert.ok(lines[0].includes("…"), "first line should contain ellipsis indicator");
	// The remaining lines (after removing the ellipsis line) should include recent content
	const recentLines = lines.filter((l) => !l.includes("…"));
	assert.ok(recentLines.some((l) => l.includes("Line 5")), "truncated output should include most recent content");
});

test("Markdown preserves most recent content when truncating", () => {
	const text = "First paragraph\n\nSecond paragraph\n\nThird paragraph\n\nFourth paragraph\n\nFifth paragraph";
	const md = new Markdown(text, 0, 0, noopTheme());
	md.maxLines = 3;
	const lines = md.render(80);
	// The last rendered line should contain "Fifth paragraph" (the most recent content)
	const lastContentLine = lines.filter((l) => !l.includes("…")).pop() ?? "";
	assert.ok(
		lastContentLine.includes("Fifth paragraph"),
		`expected last content line to contain "Fifth paragraph", got "${lastContentLine}"`,
	);
});

test("Markdown does not truncate when content fits within maxLines", () => {
	const text = "Short text";
	const md = new Markdown(text, 0, 0, noopTheme());
	md.maxLines = 10;
	const lines = md.render(80);
	assert.ok(!lines.some((l) => l.includes("…")), "should not contain ellipsis when content fits");
	assert.ok(lines.some((l) => l.includes("Short text")), "should contain the original text");
});

test("Markdown trims trailing empty lines", () => {
	const text = "Some text\n\n";
	const md = new Markdown(text, 0, 0, noopTheme());
	const lines = md.render(80);
	// Last line should not be empty (trailing empties are trimmed)
	const lastLine = lines[lines.length - 1];
	// Assert the trimmed invariant directly: if there's content, last line is non-empty;
	// if only one line exists, it must be the content (no trailing empties)
	if (lines.length === 1) {
		assert.ok(lastLine.trim().length > 0, "single-line output must be non-empty");
	} else {
		assert.ok(lastLine.trim().length > 0, "last line must not be empty (trailing empties trimmed)");
	}
});
