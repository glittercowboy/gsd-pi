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
});
