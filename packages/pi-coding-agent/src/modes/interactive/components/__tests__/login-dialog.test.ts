import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildAuthUrlPresentation } from "../login-dialog.js";

describe("LoginDialogComponent", () => {
	test("shows the full OAuth URL when the hyperlink label is truncated", () => {
		const presentation = buildAuthUrlPresentation(
			"https://auth.example.com/device?code=ABCD-1234&callback=oauth&state=needs-full-visibility",
			52,
		);

		assert.notEqual(
			presentation.displayUrl,
			"https://auth.example.com/device?code=ABCD-1234&callback=oauth&state=needs-full-visibility",
			"narrow terminals should still truncate the hyperlink label",
		);
		assert.ok(presentation.fullUrlLines.length > 1, "truncated URLs should expose wrapped full-url lines");
		assert.match(presentation.fullUrlLines[0] ?? "", /https:\/\/auth\.example\.com\/device\?code=ABCD-1234&/);
		assert.match(
			presentation.fullUrlLines[presentation.fullUrlLines.length - 1] ?? "",
			/state=needs-full-visibility/,
		);
	});
});
