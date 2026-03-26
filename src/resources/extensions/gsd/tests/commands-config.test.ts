import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test("commands-config source-level: tool key lookup skips empty api_key entries", () => {
  const source = readFileSync(join(__dirname, "..", "commands-config.ts"), "utf-8");
  assert.ok(
    source.includes('getCredentialsForProvider(providerId)'),
    "commands-config should read the full credential list",
  );
  assert.ok(
    source.includes('c.type === "api_key" && c.key'),
    "commands-config should require a non-empty api_key when resolving stored tool keys",
  );
  assert.ok(
    !source.includes("auth.get(tool.id)"),
    "commands-config should not rely on auth.get(tool.id), which can return an empty shadowing entry",
  );
});
