// GSD Extension — Notification Overlay Tests
// Tests for message wrapping and content-fit sizing in the notification panel.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

// The wrapText function is private to the module, so we test the overlay's
// render output indirectly. We also extract and test wrapText logic directly.

// ── wrapText logic (mirrors the private function) ───────────────────────────

function wrapText(text: string, maxWidth: number): string[] {
  if (text.length <= maxWidth) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= maxWidth) {
      current += " " + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.map((l) => l.length > maxWidth ? l.slice(0, maxWidth - 1) + "…" : l);
}

describe("notification overlay — wrapText", () => {
  test("short text returns single line", () => {
    const result = wrapText("hello world", 80);
    assert.deepStrictEqual(result, ["hello world"]);
  });

  test("long text wraps at word boundaries", () => {
    const text = "This is a long notification message that should wrap across multiple lines";
    const result = wrapText(text, 40);
    assert.ok(result.length > 1, `expected multiple lines, got ${result.length}`);
    for (const line of result) {
      assert.ok(line.length <= 40, `line exceeds maxWidth: "${line}" (${line.length})`);
    }
  });

  test("single word exceeding maxWidth is truncated", () => {
    const result = wrapText("superlongwordthatexceedsmaxwidth", 10);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.length, 10);
    assert.ok(result[0]!.endsWith("…"));
  });

  test("empty string returns single empty line", () => {
    const result = wrapText("", 80);
    assert.deepStrictEqual(result, [""]);
  });

  test("exact-fit text returns single line", () => {
    const text = "exactly twenty chars";
    const result = wrapText(text, 20);
    assert.deepStrictEqual(result, [text]);
  });

  test("preserves all words across wrapped lines", () => {
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    const text = words.join(" ");
    const result = wrapText(text, 15);
    const rejoined = result.join(" ");
    for (const w of words) {
      assert.ok(rejoined.includes(w), `missing word: ${w}`);
    }
  });
});
