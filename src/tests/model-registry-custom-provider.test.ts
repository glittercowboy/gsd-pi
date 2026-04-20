/**
 * Regression test for #3531: models.json custom providers must be registered
 * in registeredProviders so isProviderRequestReady() returns true.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("parseModels registers custom providers in registeredProviders (#3531)", () => {
  const src = readFileSync(
    join(__dirname, "..", "..", "packages", "pi-coding-agent", "src", "core", "model-registry.ts"),
    "utf-8",
  );
  // The fix adds registeredProviders.set() inside parseModels
  const parseModelsBlock = src.slice(src.indexOf("private parseModels"));
  assert.ok(
    parseModelsBlock.includes("registeredProviders.set") ||
    parseModelsBlock.includes("this.registeredProviders.set"),
    "parseModels must register custom providers in registeredProviders",
  );
});
