/**
 * Regression test for #3440: Ollama extension must register with
 * authMode "apiKey" (not "none") to avoid streamSimple requirement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("Ollama registers with authMode apiKey, not none (#3440)", () => {
  const src = readFileSync(join(__dirname, "index.ts"), "utf-8");
  // Find the registerProvider call
  const registerBlock = src.slice(src.indexOf("pi.registerProvider(\"ollama\""));
  const authLine = registerBlock.match(/authMode:\s*"(\w+)"/);
  assert.ok(authLine, "registerProvider must specify authMode");
  assert.equal(authLine![1], "apiKey", "authMode must be apiKey, not none");
});
