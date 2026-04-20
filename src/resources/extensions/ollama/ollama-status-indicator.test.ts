/**
 * Regression test: don't show an Ollama footer status unless Ollama is
 * actually usable (running with at least one discovered model).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "index.ts"), "utf-8");

test("probeAndRegister returns false when no Ollama models are discovered", () => {
	assert.match(
		src,
		/if \(models\.length === 0\)[\s\S]*return false;/,
		"running-without-models should not be treated as available",
	);
});

test("interactive session clears ollama footer status when unavailable", () => {
	assert.match(
		src,
		/ctx\.ui\.setStatus\("ollama", found \? "Ollama" : undefined\)/,
		"status should be cleared when probeAndRegister reports unavailable",
	);
});
