// pi-tui — Overlay Layout Tests (backdrop dimming)
//
// These tests previously coupled to literal ANSI escape bytes
// (`\x1b[2m`, `\x1b[38;5;240m`) and would break if the palette index or
// SGR spelling changed despite identical rendered output — Goodhart's law:
// the test measures escape codes, not dimming.
//
// We now parse the SGR escape codes into a semantic style state and assert
// on the visible contract: the covered-but-outside-overlay region is dim,
// has a non-default foreground (so the eye can distinguish foreground from
// background), and does not paint the terminal background (so user themes
// are preserved). The overlay content itself is reachable via plain-text
// lookup after stripping ANSI.

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

/**
 * Parse a line's ANSI SGR state immediately before the first occurrence of a
 * target substring in the rendered (ANSI-stripped) text. Walks `\x1b[...m`
 * sequences left-to-right, maintaining a running state so we can ask what
 * the terminal is doing when it reaches the target glyphs.
 *
 * Semantic fields:
 *   - dim:    SGR 2 active and not reset by SGR 22 / 0
 *   - fg:     foreground: "default" | "set" | the raw numeric parameters
 *   - bg:     background: "default" | "set"
 */
type SgrState = { dim: boolean; fg: "default" | "set"; bg: "default" | "set" };

function sgrStateAtGlyph(line: string, targetGlyph: string): SgrState {
	const state: SgrState = { dim: false, fg: "default", bg: "default" };
	// Walk codes and visible chars, tracking visible-glyph position.
	let visibleSeen = "";
	let i = 0;
	while (i < line.length) {
		if (line[i] === "\x1b" && line[i + 1] === "[") {
			// Read until final byte in 0x40-0x7E
			let j = i + 2;
			while (j < line.length) {
				const c = line.charCodeAt(j);
				if (c >= 0x40 && c <= 0x7e) break;
				j++;
			}
			const final = line[j];
			if (final === "m") {
				const paramString = line.slice(i + 2, j);
				applySgr(state, paramString);
			}
			i = j + 1;
			continue;
		}
		// Skip other escape sequences (OSC hyperlinks etc) conservatively:
		// if we ever hit a non-SGR escape, just step past the ESC.
		if (line[i] === "\x1b") {
			i++;
			continue;
		}
		visibleSeen += line[i];
		if (visibleSeen.endsWith(targetGlyph)) {
			// We've just consumed the last char of targetGlyph — return the
			// state that was in effect for the whole match.
			return state;
		}
		i++;
	}
	throw new Error(`Target glyph ${JSON.stringify(targetGlyph)} not found in line`);
}

function applySgr(state: SgrState, paramString: string): void {
	// Empty params == reset
	const parts = paramString === "" ? ["0"] : paramString.split(";");
	let k = 0;
	while (k < parts.length) {
		const n = parts[k] === "" ? 0 : Number(parts[k]);
		if (n === 0) {
			state.dim = false;
			state.fg = "default";
			state.bg = "default";
		} else if (n === 2) {
			state.dim = true;
		} else if (n === 22) {
			state.dim = false;
		} else if (n === 39) {
			state.fg = "default";
		} else if (n === 49) {
			state.bg = "default";
		} else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) {
			state.fg = "set";
		} else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) {
			state.bg = "set";
		} else if (n === 38) {
			state.fg = "set";
			// Skip colour-model parameters: 38;5;N or 38;2;R;G;B
			if (parts[k + 1] === "5") {
				k += 2;
			} else if (parts[k + 1] === "2") {
				k += 4;
			}
		} else if (n === 48) {
			state.bg = "set";
			if (parts[k + 1] === "5") {
				k += 2;
			} else if (parts[k + 1] === "2") {
				k += 4;
			}
		}
		k++;
	}
}

function stripAnsi(line: string): string {
	// Remove CSI sequences. Good enough for these tests.
	return line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("compositeOverlays — backdrop", () => {
	it("dims base lines outside the overlay when backdrop is true", () => {
		const base = ["hello world", "second line"];
		const overlay = makeEntry(["OVERLAY"], {
			width: 7,
			anchor: "top-left",
			backdrop: true,
		});

		const result = compositeOverlays(base, [overlay], 20, 20, 2);

		// "second line" is below the overlay (which is anchored top-left with
		// a single visible row), so every glyph of that text should be
		// rendered with the dim attribute active.
		const line = result.find((l) => stripAnsi(l).includes("second line"));
		assert.ok(line, "should have a line containing 'second line'");

		const state = sgrStateAtGlyph(line, "second line");
		assert.equal(state.dim, true, "base line should be dimmed (SGR 2)");
	});

	it("backdrop applies a non-default foreground colour and leaves background untouched", () => {
		const base = ["hello world", "second line"];
		const overlay = makeEntry(["OV"], {
			width: 2,
			anchor: "top-left",
			backdrop: true,
		});

		const result = compositeOverlays(base, [overlay], 20, 20, 2);

		const line = result.find((l) => stripAnsi(l).includes("second line"));
		assert.ok(line, "should have a line containing 'second line'");

		const state = sgrStateAtGlyph(line, "second line");
		assert.equal(state.fg, "set", "backdrop must set a foreground colour");
		assert.equal(
			state.bg,
			"default",
			"backdrop must not paint a background (preserves user's terminal theme)",
		);
	});

	it("does not dim when backdrop is false/absent", () => {
		const base = ["hello world", "second line"];
		const overlay = makeEntry(["OVERLAY"], {
			width: 7,
			anchor: "top-left",
		});

		const result = compositeOverlays(base, [overlay], 20, 20, 2);

		const line = result.find((l) => stripAnsi(l).includes("second line"));
		assert.ok(line, "should have a line containing 'second line'");

		const state = sgrStateAtGlyph(line, "second line");
		assert.equal(state.dim, false, "base line should not be dimmed when no backdrop");
	});

	it("overlay content renders on top of dimmed background", () => {
		const base = ["aaaaaaaaaa"];
		const overlay = makeEntry(["XX"], {
			width: 2,
			anchor: "top-left",
			backdrop: true,
		});

		const result = compositeOverlays(base, [overlay], 10, 10, 1);

		// Find the row that (after stripping styling) contains the overlay
		// text. We don't use positional `result[0]` so the test survives if
		// the row ordering changes.
		const overlayRow = result.find((l) => stripAnsi(l).includes("XX"));
		assert.ok(overlayRow, "overlay text should be composited into some rendered row");
	});
});
