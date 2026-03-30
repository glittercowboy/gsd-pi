import test from "node:test";
import assert from "node:assert/strict";

import { visibleWidth, wrapTextWithAnsi } from "../../packages/native/dist/text/index.js";

test("native text helpers fall back to JS when the addon is unavailable", () => {
  assert.equal(visibleWidth("\x1b[31mhi\x1b[0m"), 2);
  assert.deepEqual(wrapTextWithAnsi("hello world", 5), ["hello", "world"]);
});

test("wrapTextWithAnsi fallback preserves active ANSI styles across wrapped lines", () => {
  const lines = wrapTextWithAnsi("\x1b[31mhello world\x1b[0m", 5);
  assert.deepEqual(lines, ["\x1b[31mhello\x1b[0m", "\x1b[31mworld\x1b[0m"]);
});

test("wrapTextWithAnsi fallback reopens OSC 8 hyperlinks on continuation lines", () => {
  const url = "https://example.com";
  const open = `\x1b]8;;${url}\x07`;
  const close = "\x1b]8;;\x07";
  const lines = wrapTextWithAnsi(`${open}click here please${close}`, 10);

  assert.deepEqual(lines, [
    `${open}click here${close}`,
    `${open}please${close}`,
  ]);
});
