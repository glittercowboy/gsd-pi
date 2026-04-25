import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("onboarding exposes MiniMax providers in API-key list", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "onboarding.ts"), "utf-8");
  assert.match(src, /value:\s*['"]minimax['"]/);
  assert.match(src, /value:\s*['"]minimax-cn['"]/);
});

test("custom OpenAI flow auto-routes MiniMax endpoints to native providers", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "onboarding.ts"), "utf-8");
  assert.match(src, /detectNativeProviderFromBaseUrl/);
  assert.match(src, /authStorage\.set\(nativeProvider,\s*\{\s*type:\s*'api_key'/);
  assert.match(src, /persistDefaultProvider\(nativeProvider\)/);
  assert.match(src, /persistDefaultModel\(trimmedModelId\)/);
});
