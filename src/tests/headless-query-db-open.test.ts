/**
 * Regression test for #4123: headless-query must open the project DB
 * before deriveState(), otherwise it falls back to filesystem parsing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "..", "headless-query.ts"), "utf-8");

test("headless-query loads openProjectDbIfPresent from extension modules (#4123)", () => {
  assert.match(
    src,
    /openProjectDbIfPresent:\s*autoStartModule\.openProjectDbIfPresent/,
    "headless-query should load openProjectDbIfPresent from auto-start.ts",
  );
});

test("headless-query opens the DB before deriveState (#4123)", () => {
  const openIdx = src.indexOf("await openProjectDbIfPresent(basePath)");
  const deriveIdx = src.indexOf("const state = await deriveState(basePath)");
  assert.ok(openIdx !== -1, "headless-query should open the project DB");
  assert.ok(deriveIdx !== -1, "headless-query should still derive state");
  assert.ok(openIdx < deriveIdx, "headless-query should open the DB before deriveState()");
});
