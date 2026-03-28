import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { replaceClipboardImageMarkers } from "../../packages/pi-coding-agent/src/modes/interactive/clipboard-markers.js";

describe("replaceClipboardImageMarkers", () => {
	test("expands tracked markers to their file paths", () => {
		const text = "See [image #1] and [image #2]. Duplicate: [image #1]";
		const clipboardImages = new Map<number, string>([
			[1, "/tmp/one.png"],
			[2, "/tmp/two.png"],
		]);

		assert.equal(
			replaceClipboardImageMarkers(text, clipboardImages),
			"See /tmp/one.png and /tmp/two.png. Duplicate: /tmp/one.png",
		);
	});

	test("leaves unknown markers untouched", () => {
		const text = "Known [image #1], unknown [image #2]";
		const clipboardImages = new Map<number, string>([[1, "/tmp/one.png"]]);

		assert.equal(
			replaceClipboardImageMarkers(text, clipboardImages),
			"Known /tmp/one.png, unknown [image #2]",
		);
	});
});
