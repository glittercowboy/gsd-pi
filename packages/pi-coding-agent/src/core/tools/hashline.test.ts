import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	computeLineHash,
	formatHashLines,
	formatLineTag,
	parseTag,
	validateLineRef,
	applyHashlineEdits,
	HashlineMismatchError,
	parseHashlineText,
	stripNewLinePrefixes,
	type HashlineEdit,
	type Anchor,
} from "./hashline.js";

function makeTag(line: number, content: string): Anchor {
	return parseTag(formatLineTag(line, content));
}

// ═══════════════════════════════════════════════════════════════════════════
// computeLineHash
// ═══════════════════════════════════════════════════════════════════════════

describe("computeLineHash", () => {
	it("returns 2-character hash string from nibble alphabet", () => {
		const hash = computeLineHash(1, "hello");
		assert.match(hash, /^[ZPMQVRWSNKTXJBYH]{2}$/);
	});

	it("same content at same line produces same hash", () => {
		const a = computeLineHash(1, "hello");
		const b = computeLineHash(1, "hello");
		assert.equal(a, b);
	});

	it("different content produces different hash", () => {
		const a = computeLineHash(1, "hello");
		const b = computeLineHash(1, "world");
		assert.notEqual(a, b);
	});

	it("empty line produces valid hash", () => {
		const hash = computeLineHash(1, "");
		assert.match(hash, /^[ZPMQVRWSNKTXJBYH]{2}$/);
	});

	it("uses line number for symbol-only lines", () => {
		const a = computeLineHash(1, "***");
		const b = computeLineHash(2, "***");
		assert.notEqual(a, b);
	});

	it("does not use line number for alphanumeric lines", () => {
		const a = computeLineHash(1, "hello");
		const b = computeLineHash(2, "hello");
		assert.equal(a, b);
	});

	it("strips trailing whitespace before hashing", () => {
		const a = computeLineHash(1, "hello");
		const b = computeLineHash(1, "hello   ");
		assert.equal(a, b);
	});

	it("strips CR before hashing", () => {
		const a = computeLineHash(1, "hello");
		const b = computeLineHash(1, "hello\r");
		assert.equal(a, b);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// formatHashLines
// ═══════════════════════════════════════════════════════════════════════════

describe("formatHashLines", () => {
	it("formats single line", () => {
		const result = formatHashLines("hello");
		const hash = computeLineHash(1, "hello");
		assert.equal(result, `1#${hash}:hello`);
	});

	it("formats multiple lines with 1-indexed numbers", () => {
		const result = formatHashLines("foo\nbar\nbaz");
		const lines = result.split("\n");
		assert.equal(lines.length, 3);
		assert.ok(lines[0].startsWith("1#"));
		assert.ok(lines[1].startsWith("2#"));
		assert.ok(lines[2].startsWith("3#"));
	});

	it("respects custom startLine", () => {
		const result = formatHashLines("foo\nbar", 10);
		const lines = result.split("\n");
		assert.ok(lines[0].startsWith("10#"));
		assert.ok(lines[1].startsWith("11#"));
	});

	it("handles empty lines in content", () => {
		const result = formatHashLines("foo\n\nbar");
		const lines = result.split("\n");
		assert.equal(lines.length, 3);
		assert.match(lines[1], /^2#[ZPMQVRWSNKTXJBYH]{2}:$/);
	});

	it("round-trips with computeLineHash", () => {
		const content = "function hello() {\n  return 42;\n}";
		const formatted = formatHashLines(content);
		const lines = formatted.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const match = lines[i].match(/^(\d+)#([ZPMQVRWSNKTXJBYH]{2}):(.*)$/);
			assert.ok(match, `Line ${i} should match hashline format`);
			const lineNum = Number.parseInt(match![1], 10);
			const hash = match![2];
			const lineContent = match![3];
			assert.equal(computeLineHash(lineNum, lineContent), hash);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// parseTag
// ═══════════════════════════════════════════════════════════════════════════

describe("parseTag", () => {
	it("parses valid reference", () => {
		const ref = parseTag("5#QQ");
		assert.deepEqual(ref, { line: 5, hash: "QQ" });
	});

	it("rejects single-character hash", () => {
		assert.throws(() => parseTag("1#Q"), /Invalid line reference/);
	});

	it("parses long hash by taking strict 2-char prefix", () => {
		const ref = parseTag("100#QQQQ");
		assert.deepEqual(ref, { line: 100, hash: "QQ" });
	});

	it("rejects missing separator", () => {
		assert.throws(() => parseTag("5QQ"), /Invalid line reference/);
	});

	it("rejects non-numeric line", () => {
		assert.throws(() => parseTag("abc#Q"), /Invalid line reference/);
	});

	it("rejects line number 0", () => {
		assert.throws(() => parseTag("0#QQ"), /Line number must be >= 1/);
	});

	it("rejects empty string", () => {
		assert.throws(() => parseTag(""), /Invalid line reference/);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// validateLineRef
// ═══════════════════════════════════════════════════════════════════════════

describe("validateLineRef", () => {
	it("accepts valid ref with matching hash", () => {
		const lines = ["hello", "world"];
		const hash = computeLineHash(1, "hello");
		assert.doesNotThrow(() => validateLineRef({ line: 1, hash }, lines));
	});

	it("rejects line out of range", () => {
		const lines = ["hello"];
		const hash = computeLineHash(1, "hello");
		assert.throws(() => validateLineRef({ line: 2, hash }, lines), /does not exist/);
	});

	it("rejects mismatched hash", () => {
		const lines = ["hello", "world"];
		assert.throws(() => validateLineRef({ line: 1, hash: "ZZ" }, lines), /has changed since last read/);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// applyHashlineEdits — replace
// ═══════════════════════════════════════════════════════════════════════════

describe("applyHashlineEdits — replace", () => {
	it("replaces single line", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [{ op: "replace", pos: makeTag(2, "bbb"), lines: ["BBB"] }];
		const result = applyHashlineEdits(content, edits);
		assert.equal(result.lines, "aaa\nBBB\nccc");
		assert.equal(result.firstChangedLine, 2);
	});

	it("range replace (shrink)", () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: HashlineEdit[] = [{ op: "replace", pos: makeTag(2, "bbb"), end: makeTag(3, "ccc"), lines: ["ONE"] }];
		const result = applyHashlineEdits(content, edits);
		assert.equal(result.lines, "aaa\nONE\nddd");
	});

	it("range replace (same count)", () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: HashlineEdit[] = [
			{ op: "replace", pos: makeTag(2, "bbb"), end: makeTag(3, "ccc"), lines: ["XXX", "YYY"] },
		];
		const result = applyHashlineEdits(content, edits);
		assert.equal(result.lines, "aaa\nXXX\nYYY\nddd");
	});

	it("replaces first line", () => {
		const content = "first\nsecond\nthird";
		const edits: HashlineEdit[] = [{ op: "replace", pos: makeTag(1, "first"), lines: ["FIRST"] }];
		const result = applyHashlineEdits(content, edits);
		assert.equal(result.lines, "FIRST\nsecond\nthird");
	});

	it("replaces last line", () => {
		const content = "first\nsecond\nthird";
		const edits: HashlineEdit[] = [{ op: "replace", pos: makeTag(3, "third"), lines: ["THIRD"] }];
		const result = applyHashlineEdits(content, edits);
		assert.equal(result.lines, "first\nsecond\nTHIRD");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// applyHashlineEdits — delete
// ═══════════════════════════════════════════════════════════════════════════

describe("applyHashlineEdits — delete", () => {
	it("deletes single line", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [{ op: "replace", pos: makeTag(2, "bbb"), lines: [] }];
		const result = applyHashlineEdits(content, edits);
		assert.equal(result.lines, "aaa\nccc");
	});

	it("deletes range of lines", () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: HashlineEdit[] = [{ op: "replace", pos: makeTag(2, "bbb"), end: makeTag(3, "ccc"), lines: [] }];
		const result = applyHashlineEdits(content, edits);
		assert.equal(result.lines, "aaa\nddd");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// applyHashlineEdits — append
// ═══════════════════════════════════════════════════════════════════════════

describe("applyHashlineEdits — append", () => {
	it("inserts after a line", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [{ op: "append", pos: makeTag(1, "aaa"), lines: ["NEW"] }];
		const result = applyHashlineEdits(content, edits);
		assert.equal(result.lines, "aaa\nNEW\nbbb\nccc");
		assert.equal(result.firstChangedLine, 2);
	});

	it("inserts multiple lines", () => {
		const content = "aaa\nbbb";
		const edits: HashlineEdit[] = [{ op: "append", pos: makeTag(1, "aaa"), lines: ["x", "y", "z"] }];
		const result = applyHashlineEdits(content, edits);
		assert.equal(result.lines, "aaa\nx\ny\nz\nbbb");
	});

	it("inserts at EOF without anchors", () => {
		const content = "aaa\nbbb";
		const edits = [{ op: "append", lines: ["NEW"] }] as unknown as HashlineEdit[];
		const result = applyHashlineEdits(content, edits);
		assert.equal(result.lines, "aaa\nbbb\nNEW");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// applyHashlineEdits — prepend
// ═══════════════════════════════════════════════════════════════════════════

describe("applyHashlineEdits — prepend", () => {
	it("inserts before a line", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [{ op: "prepend", pos: makeTag(2, "bbb"), lines: ["NEW"] }];
		const result = applyHashlineEdits(content, edits);
		assert.equal(result.lines, "aaa\nNEW\nbbb\nccc");
	});

	it("prepends at BOF without anchor", () => {
		const content = "aaa\nbbb";
		const edits = [{ op: "prepend", lines: ["NEW"] }] as unknown as HashlineEdit[];
		const result = applyHashlineEdits(content, edits);
		assert.equal(result.lines, "NEW\naaa\nbbb");
	});

	it("insert before and insert after at same line produce correct order", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [
			{ op: "prepend", pos: makeTag(2, "bbb"), lines: ["BEFORE"] },
			{ op: "append", pos: makeTag(2, "bbb"), lines: ["AFTER"] },
		];
		const result = applyHashlineEdits(content, edits);
		assert.equal(result.lines, "aaa\nBEFORE\nbbb\nAFTER\nccc");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// applyHashlineEdits — multiple edits
// ═══════════════════════════════════════════════════════════════════════════

describe("applyHashlineEdits — multiple edits", () => {
	it("applies two non-overlapping replaces (bottom-up safe)", () => {
		const content = "aaa\nbbb\nccc\nddd\neee";
		const edits: HashlineEdit[] = [
			{ op: "replace", pos: makeTag(2, "bbb"), lines: ["BBB"] },
			{ op: "replace", pos: makeTag(4, "ddd"), lines: ["DDD"] },
		];
		const result = applyHashlineEdits(content, edits);
		assert.equal(result.lines, "aaa\nBBB\nccc\nDDD\neee");
	});

	it("empty edits array is a no-op", () => {
		const content = "aaa\nbbb";
		const result = applyHashlineEdits(content, []);
		assert.equal(result.lines, content);
		assert.equal(result.firstChangedLine, undefined);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// applyHashlineEdits — error cases
// ═══════════════════════════════════════════════════════════════════════════

describe("applyHashlineEdits — errors", () => {
	it("rejects stale hash", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [{ op: "replace", pos: parseTag("2#QQ"), lines: ["BBB"] }];
		assert.throws(() => applyHashlineEdits(content, edits), (err: any) => err instanceof HashlineMismatchError);
	});

	it("stale hash error shows >>> markers with correct hashes", () => {
		const content = "aaa\nbbb\nccc\nddd\neee";
		const edits: HashlineEdit[] = [{ op: "replace", pos: parseTag("2#QQ"), lines: ["BBB"] }];

		try {
			applyHashlineEdits(content, edits);
			assert.fail("should have thrown");
		} catch (err: any) {
			assert.ok(err instanceof HashlineMismatchError);
			assert.ok(err.message.includes(">>>"));
			const correctHash = computeLineHash(2, "bbb");
			assert.ok(err.message.includes(`2#${correctHash}:bbb`));
		}
	});

	it("rejects out-of-range line", () => {
		const content = "aaa\nbbb";
		const edits: HashlineEdit[] = [{ op: "replace", pos: parseTag("10#ZZ"), lines: ["X"] }];
		assert.throws(() => applyHashlineEdits(content, edits), /does not exist/);
	});

	it("rejects range with start > end", () => {
		const content = "aaa\nbbb\nccc\nddd\neee";
		const edits: HashlineEdit[] = [{ op: "replace", pos: makeTag(5, "eee"), end: makeTag(2, "bbb"), lines: ["X"] }];
		assert.throws(() => applyHashlineEdits(content, edits));
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// stripNewLinePrefixes
// ═══════════════════════════════════════════════════════════════════════════

describe("stripNewLinePrefixes", () => {
	it("strips leading '+' when majority of lines start with '+'", () => {
		const lines = ["+line one", "+line two", "+line three"];
		assert.deepEqual(stripNewLinePrefixes(lines), ["line one", "line two", "line three"]);
	});

	it("does NOT strip leading '-' from Markdown list items", () => {
		const lines = ["- item one", "- item two", "- item three"];
		assert.deepEqual(stripNewLinePrefixes(lines), ["- item one", "- item two", "- item three"]);
	});

	it("strips hashline prefixes when all non-empty lines carry them", () => {
		const lines = ["1#WQ:foo", "2#TZ:bar", "3#HX:baz"];
		assert.deepEqual(stripNewLinePrefixes(lines), ["foo", "bar", "baz"]);
	});

	it("does NOT strip hashline prefixes when any non-empty line is plain content", () => {
		const lines = ["1#WQ:foo", "bar", "3#HX:baz"];
		assert.deepEqual(stripNewLinePrefixes(lines), ["1#WQ:foo", "bar", "3#HX:baz"]);
	});

	it("does NOT strip comment lines that look like hashline prefixes", () => {
		assert.deepEqual(stripNewLinePrefixes(["  # Note: Using a fixed version"]), ["  # Note: Using a fixed version"]);
		assert.deepEqual(stripNewLinePrefixes(["# TODO: remove this"]), ["# TODO: remove this"]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// parseHashlineText
// ═══════════════════════════════════════════════════════════════════════════

describe("parseHashlineText", () => {
	it("returns empty array for null", () => {
		assert.deepEqual(parseHashlineText(null), []);
	});

	it("returns array input as-is when no strip heuristic applies", () => {
		const input = ["- [x] done", "- [ ] todo"];
		assert.equal(parseHashlineText(input), input);
	});

	it("splits string on newline and preserves Markdown list '-' prefix", () => {
		const result = parseHashlineText("- item one\n- item two\n- item three");
		assert.deepEqual(result, ["- item one", "- item two", "- item three"]);
	});

	it("strips '+' diff markers from string input", () => {
		const result = parseHashlineText("+line one\n+line two");
		assert.deepEqual(result, ["line one", "line two"]);
	});

	it("still strips trailing empty from string split", () => {
		assert.deepEqual(parseHashlineText("foo\n"), ["foo"]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Auto-correction heuristics
// ═══════════════════════════════════════════════════════════════════════════

describe("applyHashlineEdits — heuristics", () => {
	it("auto-corrects off-by-one range end that duplicates a closing brace", () => {
		const content = "if (ok) {\n  run();\n}\nafter();";
		const edits: HashlineEdit[] = [
			{
				op: "replace",
				pos: makeTag(1, "if (ok) {"),
				end: makeTag(2, "  run();"),
				lines: ["if (ok) {", "  runSafe();", "}"],
			},
		];
		const result = applyHashlineEdits(content, edits);
		assert.equal(result.lines, "if (ok) {\n  runSafe();\n}\nafter();");
		assert.ok(result.warnings);
		assert.equal(result.warnings!.length, 1);
		assert.ok(result.warnings![0].includes("Auto-corrected range replace"));
	});

	it("auto-corrects escaped tab indentation", () => {
		const content = "root\n\tchild\n\t\tvalue\nend";
		const edits: HashlineEdit[] = [{ op: "replace", pos: makeTag(3, "\t\tvalue"), lines: ["\\t\\treplaced"] }];
		const result = applyHashlineEdits(content, edits);
		assert.equal(result.lines, "root\n\tchild\n\t\treplaced\nend");
		assert.ok(result.warnings);
		assert.ok(result.warnings![0].includes("Auto-corrected escaped tab indentation"));
	});
});
