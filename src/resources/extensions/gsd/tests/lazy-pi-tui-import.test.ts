// Behavioral contract: shared/mod.ts must be importable without pulling in @gsd/pi-tui.
// TUI-dependent exports live in shared/tui.ts instead.
// We verify the barrel exports work correctly — if pi-tui leaked in, the test
// environment would fail to resolve it (no terminal) and tests would throw.

import test from "node:test";
import assert from "node:assert/strict";
import {
  stripAnsi,
  formatTokenCount,
  sparkline,
  normalizeStringArray,
  truncateWithEllipsis,
} from "../../shared/mod.js";

test("stripAnsi removes ANSI color escape sequences", () => {
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red");
});

test("stripAnsi passes through plain strings unchanged", () => {
  assert.equal(stripAnsi("hello world"), "hello world");
});

test("formatTokenCount formats sub-1k counts as plain numbers", () => {
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(999), "999");
});

test("formatTokenCount formats thousands with k suffix", () => {
  assert.equal(formatTokenCount(1000), "1.0k");
  assert.equal(formatTokenCount(12500), "12.5k");
});

test("formatTokenCount formats millions with M suffix", () => {
  assert.equal(formatTokenCount(1_500_000), "1.50M");
});

test("sparkline returns empty string for empty input", () => {
  assert.equal(sparkline([]), "");
});

test("sparkline returns a string of the same length as input", () => {
  const result = sparkline([1, 2, 3, 4, 5]);
  assert.equal(result.length, 5);
});

test("normalizeStringArray filters non-string values", () => {
  assert.deepEqual(normalizeStringArray([1, "a", null, "b", true]), ["a", "b"]);
});

test("normalizeStringArray deduplicates when option set", () => {
  assert.deepEqual(normalizeStringArray(["a", "a", "b"], { dedupe: true }), ["a", "b"]);
});

test("truncateWithEllipsis leaves short strings intact", () => {
  assert.equal(truncateWithEllipsis("hello", 10), "hello");
});

test("truncateWithEllipsis truncates long strings with ellipsis", () => {
  const result = truncateWithEllipsis("hello world", 7);
  assert.equal(result.length, 7);
  assert.ok(result.endsWith("…"));
});
