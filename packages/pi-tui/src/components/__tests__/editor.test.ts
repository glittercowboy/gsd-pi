import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Editor, type EditorTheme } from "../editor.js";
import { CURSOR_MARKER, TUI } from "../../tui.js";
import type { Terminal } from "../../terminal.js";

function makeTerminal(): Terminal {
	return {
		isTTY: true,
		columns: 80,
		rows: 24,
		kittyProtocolActive: false,
		start() {},
		stop() {},
		drainInput: async () => {},
		write() {},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
	};
}

const theme: EditorTheme = {
	borderColor: (text) => text,
	selectList: {
		selectedPrefix: (text) => text,
		selectedText: (text) => text,
		description: (text) => text,
		scrollInfo: (text) => text,
		noMatch: (text) => text,
	},
};

describe("Editor", () => {
	it("clears bracketed paste state when focus is lost", () => {
		const editor = new Editor(new TUI(makeTerminal()), theme);
		editor.focused = true;

		editor.handleInput("\x1b[200~partial");
		editor.focused = false;
		editor.focused = true;
		editor.handleInput("hello");

		assert.equal(editor.getText(), "hello");
	});

	it("keeps the hardware cursor marker visible while autocomplete is open", () => {
		const editor = new Editor(new TUI(makeTerminal()), theme);
		editor.focused = true;
		editor.setText("/se");

		(editor as any).autocompleteState = "regular";
		(editor as any).autocompleteList = { render: () => [] };

		const rendered = editor.render(40).join("\n");

		assert.ok(rendered.includes(CURSOR_MARKER));
	});
});
