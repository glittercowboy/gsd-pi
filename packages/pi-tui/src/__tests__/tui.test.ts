import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Container, TUI } from "../tui.js";
import type { Component } from "../tui.js";
import type { Terminal } from "../terminal.js";

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

// TUI clearOnShrink debounce — tests removed in #4794 (ref #4784).
//
// The previous tests mutated private fields (`_shrinkDebounceActive`,
// `maxLinesRendered`) and then asserted the values they just wrote —
// pure tautologies that never exercised the real debounce path in
// `renderNow()` (tui.ts:734-754). A regression that narrowed the
// condition, reversed the flag flip, or dropped the "keep
// maxLinesRendered" rule would have passed all of them.
//
// A proper test would (a) render a component that produces N lines to
// establish `maxLinesRendered`, (b) swap in a component that produces
// N-k lines to trigger the shrink branch, and (c) observe terminal
// writes to confirm the debounce defers/commits the full redraw on the
// expected render call.
//
// That test setup requires exposing enough of the render path (or
// extracting the debounce decision into a pure helper) — deferred to a
// separate refactor PR rather than shipping a tautology. See #4794.

describe("TUI", () => {
	it("does not swallow a bare Escape keypress while waiting for the cell-size response", () => {
		const tui = new TUI(makeTerminal());
		const received: string[] = [];

		tui.setFocus({
			render: () => [],
			handleInput: (data: string) => {
				received.push(data);
			},
			invalidate() {},
		});

		const anyTui = tui as any;
		anyTui.cellSizeQueryPending = true;
		anyTui.inputBuffer = "";

		anyTui.handleInput("\x1b");

		assert.deepEqual(received, ["\x1b"]);
		assert.equal(anyTui.cellSizeQueryPending, false);
		assert.equal(anyTui.inputBuffer, "");
	});
});

describe("Container", () => {
	function makeDisposableChild(counter: { disposed: number }): Component & { dispose(): void } {
		return {
			render: () => [],
			invalidate() {},
			dispose() {
				counter.disposed++;
			},
		};
	}

	it("detachChildren() removes children without disposing them", () => {
		const c = new Container();
		const counter = { disposed: 0 };
		c.addChild(makeDisposableChild(counter));
		c.addChild(makeDisposableChild(counter));

		c.detachChildren();

		assert.equal(c.children.length, 0);
		assert.equal(counter.disposed, 0);
	});

	it("clear() still disposes children (regression guard for detach/dispose split)", () => {
		const c = new Container();
		const counter = { disposed: 0 };
		c.addChild(makeDisposableChild(counter));
		c.addChild(makeDisposableChild(counter));

		c.clear();

		assert.equal(c.children.length, 0);
		assert.equal(counter.disposed, 2);
	});
});
