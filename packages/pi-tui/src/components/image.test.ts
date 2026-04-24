/**
 * Regression test for #3455: Image component must not trigger infinite
 * re-render loop when dimensions resolve in cmux sessions.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Image } from "./image.js";

describe("Image component (#3455)", () => {
	const theme = { fallbackColor: (s: string) => s };

	test("getDimensions returns undefined when constructed without explicit dims", () => {
		// Previously this test was titled "returns undefined before resolution"
		// but only asserted `typeof getDimensions === 'function'`. The title
		// and the assertion had nothing to do with each other (#4794).
		// Now actually assert the undefined return.
		const img = new Image("base64data", "image/png", theme, {});
		assert.equal(
			img.getDimensions(),
			undefined,
			"without pre-resolved dims, getDimensions must return undefined until async resolve",
		);
	});

	test("getDimensions returns dimensions when provided at construction", () => {
		const dims = { widthPx: 100, heightPx: 200 };
		const img = new Image("base64data", "image/png", theme, {}, dims);
		const result = img.getDimensions();
		assert.deepEqual(result, dims, "Should return provided dimensions");
	});

	test("onDimensionsResolved callback is not called when dimensions provided", () => {
		let callCount = 0;
		const dims = { widthPx: 100, heightPx: 200 };
		const img = new Image("base64data", "image/png", theme, {}, dims);
		img.setOnDimensionsResolved(() => { callCount++; });
		// With pre-resolved dims, the async path is skipped entirely
		assert.equal(callCount, 0, "Callback should not fire for pre-resolved dimensions");
	});
});
