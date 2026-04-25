// pi-tui Input component regression tests
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Input } from "../input.js";

describe("Input", () => {
	it("paste buffer is cleared when focus is lost", () => {
		const input = new Input();
		input.focused = true;

		// Simulate starting a paste (bracket paste start marker)
		input.handleInput("\x1b[200~partial");

		// Now lose focus mid-paste
		input.focused = false;

		// Regain focus — should not have stale paste state
		input.focused = true;

		// Typing normal text should work without paste buffer corruption
		input.handleInput("hello");
		assert.equal(input.getValue(), "hello");
	});

	it("focused getter/setter works correctly", () => {
		const input = new Input();
		assert.equal(input.focused, false);
		input.focused = true;
		assert.equal(input.focused, true);
		input.focused = false;
		assert.equal(input.focused, false);
	});

	it("secure mode obscures typed characters in render output", () => {
		const input = new Input();
		input.secure = true;
		input.focused = true;
		const SECRET = "secret123";
		input.handleInput(SECRET);

		const line = input.render(40)[0] ?? "";
		// Previous assertion was `line.includes("*********")` — a literal
		// 9-star string that silently goes stale if SECRET is renamed to
		// a different length (#4796). Match any run of asterisks and
		// assert its length covers the secret.
		assert.ok(
			!line.includes(SECRET),
			"rendered line must not expose raw secret text",
		);
		const maskMatch = line.match(/\*+/);
		assert.ok(
			maskMatch,
			`rendered line must include masked characters, got: ${JSON.stringify(line)}`,
		);
		assert.ok(
			maskMatch[0].length >= SECRET.length,
			`mask must cover at least the secret length (${SECRET.length}), got ${maskMatch[0].length} asterisks`,
		);
	});

	it("maps kitty keypad digits to text instead of inserting private-use glyphs", () => {
		const input = new Input();
		input.focused = true;

		input.handleInput("\x1b[57400;129u");

		assert.equal(input.getValue(), "1");
	});

	it("ignores kitty keypad navigation keys in text input", () => {
		const input = new Input();
		input.focused = true;

		input.handleInput("\x1b[57417u");

		assert.equal(input.getValue(), "");
	});
});
