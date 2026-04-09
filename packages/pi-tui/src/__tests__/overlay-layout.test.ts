// pi-tui — Overlay Layout Tests (backdrop dimming)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compositeOverlays, type OverlayEntry } from "../overlay-layout.js";

function makeEntry(
	lines: string[],
	options?: OverlayEntry["options"],
): OverlayEntry {
	return {
		component: { render: () => lines },
		options,
		hidden: false,
		focusOrder: 1,
	};
}

describe("compositeOverlays — backdrop", () => {
	it("dims base lines when backdrop is true", () => {
		const base = ["hello world", "second line"];
		const overlay = makeEntry(["OVERLAY"], {
			width: 7,
			anchor: "top-left",
			backdrop: true,
		});

		const result = compositeOverlays(base, [overlay], 20, 20, 2);

		// All base lines in viewport should contain dim escape (\x1b[2m)
		// The overlay line itself is composited on top, but underlying lines get dimmed
		const dimmedLine = result.find((l) => l.includes("second line"));
		assert.ok(dimmedLine, "should have a line containing 'second line'");
		assert.ok(dimmedLine.includes("\x1b[2m"), "base line should be dimmed");
	});

	it("backdrop uses gray foreground for dimming", () => {
		const base = ["hello world", "second line"];
		const overlay = makeEntry(["OV"], {
			width: 2,
			anchor: "top-left",
			backdrop: true,
		});

		const result = compositeOverlays(base, [overlay], 20, 20, 2);

		// Check a non-overlay line for backdrop codes (dim + gray fg, no bg)
		const line = result.find((l) => l.includes("second line"));
		assert.ok(line, "should have a line containing 'second line'");
		assert.ok(line.includes("\x1b[38;5;240m"), "backdrop should set gray foreground");
		assert.ok(!line.includes("\x1b[48;"), "backdrop should not set background color");
	});

	it("does not dim when backdrop is false/absent", () => {
		const base = ["hello world", "second line"];
		const overlay = makeEntry(["OVERLAY"], {
			width: 7,
			anchor: "top-left",
		});

		const result = compositeOverlays(base, [overlay], 20, 20, 2);

		// Lines not covered by overlay should remain undimmed
		const secondLine = result.find((l) => l.includes("second line"));
		assert.ok(secondLine, "should have a line containing 'second line'");
		assert.ok(!secondLine.includes("\x1b[2m"), "base line should not be dimmed");
	});

	it("overlay content renders on top of dimmed background", () => {
		const base = ["aaaaaaaaaa"];
		const overlay = makeEntry(["XX"], {
			width: 2,
			anchor: "top-left",
			backdrop: true,
		});

		const result = compositeOverlays(base, [overlay], 10, 10, 1);

		// The first line should contain the overlay text
		assert.ok(result[0].includes("XX"), "overlay text should be composited");
	});
});
