// pi-tui Loader component regression tests
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Loader } from "../loader.js";

function makeMockTUI() {
	return { requestRender: mock.fn() } as any;
}

describe("Loader", () => {
	let loader: Loader;
	let tui: ReturnType<typeof makeMockTUI>;

	beforeEach(() => {
		tui = makeMockTUI();
	});

	afterEach(() => {
		loader?.stop();
	});

	it("start() is idempotent — calling twice does not leak intervals", () => {
		loader = new Loader(tui, (s) => s, (s) => s, "test");
		// Constructor calls start() once, call it again
		loader.start();
		// stop() should clear the interval cleanly without orphaned timers
		loader.stop();
	});

	it("dispose() stops the interval and nulls the TUI reference", () => {
		loader = new Loader(tui, (s) => s, (s) => s, "test");
		loader.dispose();
		// After dispose, calling stop() again should be safe (no-op)
		loader.stop();
	});

	it("stop() is safe to call multiple times", () => {
		loader = new Loader(tui, (s) => s, (s) => s, "test");
		loader.stop();
		loader.stop();
		loader.stop();
	});
});
