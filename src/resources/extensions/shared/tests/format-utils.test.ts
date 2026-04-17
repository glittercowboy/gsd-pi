import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatDuration,
  sparkline,
  stripAnsi,
} from "../format-utils.js";
import {
  padRight,
  joinColumns,
  centerLine,
  fitColumns,
} from "../layout-utils.js";
import { visibleWidth } from "@gsd/pi-tui";

describe("formatDuration", () => {
  it("formats seconds", () => {
    assert.equal(formatDuration(0), "0s");
    assert.equal(formatDuration(5_000), "5s");
    assert.equal(formatDuration(59_000), "59s");
  });

  it("formats minutes and seconds", () => {
    assert.equal(formatDuration(60_000), "1m 0s");
    assert.equal(formatDuration(90_000), "1m 30s");
    assert.equal(formatDuration(3_540_000), "59m 0s");
  });

  it("formats hours and minutes", () => {
    assert.equal(formatDuration(3_600_000), "1h 0m");
    assert.equal(formatDuration(5_400_000), "1h 30m");
    assert.equal(formatDuration(7_200_000), "2h 0m");
  });
});

describe("padRight", () => {
  it("pads plain text to width", () => {
    const result = padRight("abc", 6);
    assert.equal(result, "abc   ");
  });

  it("does not pad when text fills width", () => {
    const result = padRight("abcdef", 6);
    assert.equal(result, "abcdef");
  });

  it("does not pad when text exceeds width", () => {
    const result = padRight("abcdefgh", 6);
    assert.equal(result, "abcdefgh");
  });
});

describe("joinColumns", () => {
  it("joins left and right with spacing", () => {
    const result = joinColumns("left", "right", 20);
    assert.equal(result.length, 20);
    assert.ok(result.startsWith("left"));
    assert.ok(result.endsWith("right"));
  });

  it("truncates when content overflows", () => {
    const result = joinColumns("a".repeat(20), "b".repeat(20), 30);
    // Should be truncated to 30 visible columns (ANSI reset codes may make string length > 30)
    assert.ok(visibleWidth(result) <= 30);
  });
});

describe("centerLine", () => {
  it("centers text within width", () => {
    const result = centerLine("hi", 10);
    assert.equal(result, "    hi");
  });

  it("truncates when content exceeds width", () => {
    const result = centerLine("abcdefgh", 4);
    // Should be truncated to 4 visible columns (ANSI reset codes may make string length > 4)
    assert.ok(visibleWidth(result) <= 4);
  });
});

describe("fitColumns", () => {
  it("joins parts that fit", () => {
    const result = fitColumns(["aaa", "bbb", "ccc"], 20);
    assert.ok(result.includes("aaa"));
    assert.ok(result.includes("bbb"));
    assert.ok(result.includes("ccc"));
  });

  it("drops parts that overflow", () => {
    const result = fitColumns(["aaa", "bbb", "ccc"], 10);
    assert.ok(result.includes("aaa"));
    // May or may not include bbb depending on separator width
  });

  it("returns empty string for empty array", () => {
    assert.equal(fitColumns([], 80), "");
  });

  it("filters out empty strings", () => {
    const result = fitColumns(["aaa", "", "bbb"], 80);
    assert.ok(result.includes("aaa"));
    assert.ok(result.includes("bbb"));
  });
});

describe("sparkline", () => {
  it("returns empty string for empty array", () => {
    assert.equal(sparkline([]), "");
  });

  it("renders all lowest blocks for all-zero values", () => {
    const result = sparkline([0, 0, 0]);
    assert.equal(result.length, 3);
    // All chars should be the same (lowest block)
    assert.equal(result[0], result[1]);
    assert.equal(result[1], result[2]);
  });

  it("renders highest block for max value", () => {
    const result = sparkline([0, 10, 5]);
    assert.equal(result.length, 3);
    // Middle should be highest block (█)
    assert.equal(result[1], "\u2588");
  });

  it("handles single value", () => {
    const result = sparkline([42]);
    assert.equal(result.length, 1);
    assert.equal(result, "\u2588");
  });

  it("handles large arrays without stack overflow", () => {
    const largeArray = new Array(100_000).fill(0).map((_, i) => i);
    const result = sparkline(largeArray);
    assert.equal(result.length, 100_000);
  });
});

describe("stripAnsi", () => {
  it("strips ANSI escape sequences", () => {
    const result = stripAnsi("\x1b[31mred\x1b[0m text");
    assert.equal(result, "red text");
  });

  it("returns plain text unchanged", () => {
    assert.equal(stripAnsi("plain text"), "plain text");
  });

  it("strips multiple escape sequences", () => {
    const result = stripAnsi("\x1b[1m\x1b[32mbold green\x1b[0m");
    assert.equal(result, "bold green");
  });

  it("handles empty string", () => {
    assert.equal(stripAnsi(""), "");
  });
});
