import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test("commands-config source-level: tool key lookup skips empty api_key entries", () => {
  // pi 0.67.2: getCredentialsForProvider removed; replaced with auth.get(providerId)
  // which returns a single credential. Empty api_key entries are still skipped
  // via the `cred?.type === "api_key" ? cred.key : undefined` guard.
  const source = readFileSync(join(__dirname, "..", "commands-config.ts"), "utf-8");
  assert.ok(
    source.includes('auth.get(providerId)'),
    "commands-config should use auth.get(providerId) to read credentials",
  );
  assert.ok(
    source.includes('cred?.type === "api_key" ? cred.key : undefined'),
    "commands-config should require a non-empty api_key when resolving stored tool keys",
  );
  assert.ok(
    !source.includes("auth.get(tool.id)"),
    "commands-config should not rely on auth.get(tool.id), which can return an empty shadowing entry",
  );
});
