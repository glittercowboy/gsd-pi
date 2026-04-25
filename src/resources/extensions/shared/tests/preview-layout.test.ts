import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@gsd/pi-tui";
import { mergeSideBySide, padRight } from "../layout-utils.js";

// ─── mergeSideBySide ──────────────────────────────────────────────────────────

describe("mergeSideBySide", () => {
  const plainDivider = " | ";

  it("merges equal-length line arrays", () => {
    const left = ["aaa", "bbb"];
    const right = ["111", "222"];
    const merged = mergeSideBySide(left, right, 6, plainDivider, 80);
    assert.equal(merged.length, 2);
    // left padded to 6, then divider, then right
    assert.ok(merged[0].includes("aaa"));
    assert.ok(merged[0].includes("111"));
    assert.ok(merged[1].includes("bbb"));
    assert.ok(merged[1].includes("222"));
  });

  it("pads short left lines to leftWidth", () => {
    const left = ["ab"];
    const right = ["xy"];
    const merged = mergeSideBySide(left, right, 6, plainDivider, 80);
    // "ab" padded to 6 = "ab    ", then " | ", then "xy"
    assert.ok(merged[0].startsWith("ab    "));
  });

  it("handles empty left array", () => {
    const merged = mergeSideBySide([], ["aaa", "bbb"], 6, plainDivider, 80);
    assert.equal(merged.length, 2);
    // Left side should be blank (just padding)
    assert.ok(merged[0].startsWith("      "));
  });

  it("handles empty right array", () => {
    const merged = mergeSideBySide(["aaa", "bbb"], [], 6, plainDivider, 80);
    assert.equal(merged.length, 2);
    assert.ok(merged[0].includes("aaa"));
  });

  it("handles both arrays empty", () => {
    const merged = mergeSideBySide([], [], 6, plainDivider, 80);
    assert.equal(merged.length, 0);
  });

  it("handles mismatched lengths — left longer", () => {
    const left = ["a", "b", "c"];
    const right = ["1"];
    const merged = mergeSideBySide(left, right, 6, plainDivider, 80);
    assert.equal(merged.length, 3);
    assert.ok(merged[0].includes("1"));
    // Lines 2 and 3 have empty right side
    assert.ok(merged[2].includes("c"));
  });

  it("handles mismatched lengths — right longer", () => {
    const left = ["a"];
    const right = ["1", "2", "3"];
    const merged = mergeSideBySide(left, right, 6, plainDivider, 80);
    assert.equal(merged.length, 3);
    assert.ok(merged[2].includes("3"));
  });

  it("truncates merged output to totalWidth", () => {
    const left = ["aaaaaaaaaa"];  // 10 chars
    const right = ["bbbbbbbbbb"]; // 10 chars
    const merged = mergeSideBySide(left, right, 10, plainDivider, 15);
    // Should be truncated to 15 visible chars
    assert.ok(visibleWidth(merged[0]) <= 15);
  });

  it("handles ANSI-colored left content correctly", () => {
    const red = "\x1b[31m";
    const reset = "\x1b[0m";
    const left = [`${red}hello${reset}`]; // visible: "hello" (5 chars)
    const right = ["world"];
    const merged = mergeSideBySide(left, right, 8, plainDivider, 80);
    // "hello" is 5 visible chars, padded to 8 = 3 spaces of padding
    // The ANSI codes don't count toward visible width
    assert.ok(merged[0].includes(red));
    assert.ok(merged[0].includes("world"));
    // Verify padding is correct (8 visible chars on left side)
    const beforeDivider = merged[0].split(" | ")[0];
    assert.equal(visibleWidth(beforeDivider), 8);
  });

  it("handles ANSI-colored divider", () => {
    const dim = "\x1b[2m";
    const reset = "\x1b[0m";
    const styledDivider = `${dim} │ ${reset}`;
    const left = ["abc"];
    const right = ["xyz"];
    const merged = mergeSideBySide(left, right, 6, styledDivider, 80);
    assert.equal(merged.length, 1);
    assert.ok(merged[0].includes("abc"));
    assert.ok(merged[0].includes("xyz"));
  });
});

// ─── padRight with ANSI ───────────────────────────────────────────────────────

describe("padRight with ANSI content", () => {
  it("pads based on visible width, not string length", () => {
    const red = "\x1b[31m";
    const reset = "\x1b[0m";
    const colored = `${red}hi${reset}`;
    // colored.length >> 2, but visible width is 2
    const padded = padRight(colored, 6);
    assert.equal(visibleWidth(padded), 6);
  });

  it("does not over-pad plain text", () => {
    const padded = padRight("hello", 5);
    assert.equal(padded, "hello");
    assert.equal(visibleWidth(padded), 5);
  });
});
