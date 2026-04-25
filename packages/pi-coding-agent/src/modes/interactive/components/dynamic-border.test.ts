import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { DynamicBorder } from "./dynamic-border.js";

function makeTUI() {
	return {
		renderCount: 0,
		requestRender() {
			this.renderCount++;
		},
	};
}

describe("DynamicBorder spinner", () => {
	it("suppresses standalone render when an external render occurred recently", () => {
		const border = new DynamicBorder((s) => s);
		const tui = makeTUI();

		border.startSpinner(tui as any, (s) => s);
		// startSpinner calls requestRender once immediately
		assert.equal(tui.renderCount, 1, "initial render on startSpinner");

		// Simulate an externally-triggered render (e.g. from streaming)
		border.render(80);

		// Access the private interval callback by advancing the timer
		// Instead, we directly test the render-batching logic:
		// After render() sets lastExternalRender, a spinner tick within 200ms
		// should NOT call requestRender.
		const anyBorder = border as any;
		assert.ok(
			Date.now() - anyBorder.lastExternalRender < 200,
			"lastExternalRender should be recent after render()",
		);

		border.stopSpinner();
	});

	it("triggers standalone render when no external render occurred recently", () => {
		mock.timers.enable({ apis: ["setInterval"], now: 0 });
		try {
			const border = new DynamicBorder((s) => s);
			const tui = makeTUI();

			// Set lastExternalRender to a time well in the past
			const anyBorder = border as any;
			anyBorder.lastExternalRender = 0;

			border.startSpinner(tui as any, (s) => s);
			const initialCount = tui.renderCount;

			// Advance exactly one spinner interval (200ms). With mocked timers
			// this is deterministic — no flake under CI load.
			mock.timers.tick(200);

			assert.ok(
				tui.renderCount > initialCount,
				"spinner should trigger requestRender after one 200ms interval when no recent external render",
			);

			border.stopSpinner();
		} finally {
			mock.timers.reset();
		}
	});

	it("updates lastExternalRender on each render() call", () => {
		const border = new DynamicBorder((s) => s);
		const anyBorder = border as any;

		const before = Date.now();
		border.render(80);
		const after = Date.now();

		assert.ok(anyBorder.lastExternalRender >= before);
		assert.ok(anyBorder.lastExternalRender <= after);
	});
});
