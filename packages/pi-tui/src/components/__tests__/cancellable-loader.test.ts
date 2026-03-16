// pi-tui CancellableLoader component regression tests
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CancellableLoader } from "../cancellable-loader.js";

function makeMockTUI() {
	return { requestRender: mock.fn() } as any;
}

describe("CancellableLoader", () => {
	let loader: CancellableLoader;
	let tui: ReturnType<typeof makeMockTUI>;

	beforeEach(() => {
		tui = makeMockTUI();
	});

	afterEach(() => {
		loader?.dispose();
	});

	it("dispose() aborts the AbortController signal", () => {
		loader = new CancellableLoader(tui, (s) => s, (s) => s, "test");
		assert.equal(loader.aborted, false);
		loader.dispose();
		assert.equal(loader.aborted, true);
	});

	it("dispose() clears the onAbort callback", () => {
		loader = new CancellableLoader(tui, (s) => s, (s) => s, "test");
		loader.onAbort = () => {};
		loader.dispose();
		assert.equal(loader.onAbort, undefined);
	});

	it("signal is aborted after dispose()", () => {
		loader = new CancellableLoader(tui, (s) => s, (s) => s, "test");
		const signal = loader.signal;
		assert.equal(signal.aborted, false);
		loader.dispose();
		assert.equal(signal.aborted, true);
	});
});
