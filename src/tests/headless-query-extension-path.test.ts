/**
 * Regression test for #3471: headless-query must load extensions from
 * the synced agent directory, not directly from src/resources/.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("headless-query resolves from agent extensions dir (#3471)", () => {
  const src = readFileSync(join(__dirname, "..", "headless-query.ts"), "utf-8");
  assert.ok(
    src.includes("agentExtensionsDir") || src.includes(".gsd/agent"),
    "headless-query must resolve from synced agent directory",
  );
});

test("cli.ts calls initResources before headless (#3471)", () => {
  const src = readFileSync(join(__dirname, "..", "cli.ts"), "utf-8");
  const headlessBlock = src.slice(src.indexOf("gsd headless"));
  const initIdx = headlessBlock.indexOf("initResources");
  const runIdx = headlessBlock.indexOf("runHeadless");
  assert.ok(initIdx !== -1, "initResources must be called before headless");
  assert.ok(initIdx < runIdx, "initResources must come before runHeadless");
});
