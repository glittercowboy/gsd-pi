import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	computeEditDiff,
	fuzzyFindText,
	generateDiffString,
	normalizeForFuzzyMatch,
} from "./edit-diff.js";

describe("edit-diff", () => {
	it("normalizes quotes, dashes, spaces, and trailing whitespace", () => {
		const input = "“hello”\u00A0world — test  \nnext\t\t\n";
		assert.equal(normalizeForFuzzyMatch(input), "\"hello\" world - test\nnext\n");
	});

	it("falls back to fuzzy matching when unicode punctuation differs", () => {
		const result = fuzzyFindText("const title = “Hello”;\n", "const title = \"Hello\";\n");
		assert.equal(result.found, true);
		assert.equal(result.usedFuzzyMatch, true);
		assert.equal(result.contentForReplacement, "const title = \"Hello\";\n");
	});

	it("renders numbered diffs with the first changed line", () => {
		const result = generateDiffString("line 1\nline 2\nline 3\n", "line 1\nline two\nline 3\n");
		assert.equal(result.firstChangedLine, 2);
		assert.match(result.diff, /-2 line 2/);
		assert.match(result.diff, /\+2 line two/);
	});

	it("respects contextLines and inserts separators for distant changes", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
		const oldContent = lines.join("\n") + "\n";
		const modified = [...lines];
		modified[1] = "changed 2"; // line 2
		modified[17] = "changed 18"; // line 18
		const newContent = modified.join("\n") + "\n";

		const result = generateDiffString(oldContent, newContent, 2);
		// Should contain separator between the two distant change regions
		assert.match(result.diff, /\.\.\./);
		// Should NOT contain lines far from changes (e.g. line 10)
		assert.doesNotMatch(result.diff, /line 10/);
		// Should contain the changed lines
		assert.match(result.diff, /changed 2/);
		assert.match(result.diff, /changed 18/);
	});

	it("handles large files without OOM by falling back to linear diff", () => {
		// Create files large enough to exceed the DP threshold
		const lineCount = 3000;
		const oldLines = Array.from({ length: lineCount }, (_, i) => `line ${i}`);
		const newLines = [...oldLines];
		newLines[1500] = "CHANGED";
		const result = generateDiffString(oldLines.join("\n") + "\n", newLines.join("\n") + "\n");
		assert.ok(result.firstChangedLine !== undefined);
		assert.match(result.diff, /CHANGED/);
	});

	it("computes diffs for preview without native helpers", async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "edit-diff-test-"));
		t.after(() => {
			rmSync(dir, { recursive: true, force: true });
		});

		const file = join(dir, "sample.ts");
		writeFileSync(file, "const title = “Hello”;\n", "utf-8");

		const result = await computeEditDiff(
			file,
			"const title = \"Hello\";\n",
			"const title = \"Hi\";\n",
			dir,
		);

		assert.ok(!("error" in result), "expected a diff result");
		if (!("error" in result)) {
			assert.equal(result.firstChangedLine, 1);
			assert.match(result.diff, /\+1 const title = "Hi";/);
		}
	});
});
