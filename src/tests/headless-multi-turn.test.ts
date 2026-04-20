/**
 * Regression test for #3547: discuss and plan must be classified as
 * multi-turn commands in headless mode.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("headless.ts classifies discuss as multi-turn (#3547)", () => {
  const src = readFileSync(join(__dirname, "..", "headless.ts"), "utf-8");
  const multiTurnLine = src.match(/isMultiTurnCommand\s*=\s*[^;]+/);
  assert.ok(multiTurnLine, "isMultiTurnCommand must be defined");
  assert.ok(multiTurnLine![0].includes("discuss"), "discuss must be in multi-turn list");
  assert.ok(multiTurnLine![0].includes("plan"), "plan must be in multi-turn list");
});
