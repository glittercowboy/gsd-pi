import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function runFallbackProbe(script: string): string {
  return execFileSync("node", ["--input-type=module", "-e", script], {
    cwd: rootDir,
    encoding: "utf8",
    env: {
      ...process.env,
      GSD_FORCE_NO_NATIVE: "1",
    },
  }).trim();
}

test("native text helpers fall back to JS when the addon is unavailable", () => {
  const output = runFallbackProbe(
    "import { visibleWidth, wrapTextWithAnsi } from './packages/native/dist/text/index.js';" +
      "console.log(JSON.stringify({ width: visibleWidth('\\u001b[31mhi\\u001b[0m'), lines: wrapTextWithAnsi('hello world', 5) }));",
  );
  assert.deepEqual(JSON.parse(output), { width: 2, lines: ["hello", "world"] });
});

test("wrapTextWithAnsi fallback preserves active ANSI styles across wrapped lines", () => {
  const output = runFallbackProbe(
    "import { wrapTextWithAnsi } from './packages/native/dist/text/index.js';" +
      "console.log(JSON.stringify(wrapTextWithAnsi('\\u001b[31mhello world\\u001b[0m', 5)));",
  );
  assert.deepEqual(JSON.parse(output), ["\x1b[31mhello\x1b[0m", "\x1b[31mworld\x1b[0m"]);
});

test("wrapTextWithAnsi fallback reopens OSC 8 hyperlinks on continuation lines", () => {
  const output = runFallbackProbe(
    "import { wrapTextWithAnsi } from './packages/native/dist/text/index.js';" +
      "const url='https://example.com'; const open=`\\u001b]8;;${url}\\u0007`; const close='\\u001b]8;;\\u0007';" +
      "console.log(JSON.stringify(wrapTextWithAnsi(`${open}click here please${close}`, 10)));",
  );
  assert.deepEqual(JSON.parse(output), [
    "\x1b]8;;https://example.com\x07click here\x1b]8;;\x07",
    "\x1b]8;;https://example.com\x07please\x1b]8;;\x07",
  ]);
});
