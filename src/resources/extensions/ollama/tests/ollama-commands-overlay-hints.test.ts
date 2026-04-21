import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, "..", "ollama-commands.ts"), "utf-8");

function functionBlock(name: string, nextName?: string): string {
	const start = source.indexOf(`async function ${name}`);
	assert.ok(start > -1, `Expected to find ${name}() in ollama-commands.ts`);
	if (!nextName) return source.slice(start);
	const end = source.indexOf(`async function ${nextName}`, start);
	assert.ok(end > start, `Expected to find ${nextName}() after ${name}()`);
	return source.slice(start, end);
}

test("/ollama overlays include a dismiss hint for consistency", () => {
	const statusBlock = functionBlock("handleStatus", "handleList");
	const listBlock = functionBlock("handleList", "handlePull");
	const psBlock = functionBlock("handlePs");

	for (const [name, block] of [
		["handleStatus", statusBlock],
		["handleList", listBlock],
		["handlePs", psBlock],
	] as const) {
		assert.match(
			block,
			/lines\.push\("Press any key to dismiss"\)/,
			`${name} should include a dismiss hint in its overlay body`,
		);
	}
});
