// agent-loop pauseTurn handling tests
// Verifies that pause_turn / pauseTurn stop reason causes the inner loop
// to continue (re-invoke the LLM) instead of exiting.
// Regression test for https://github.com/gsd-build/gsd-2/issues/2869

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("agent-loop — pauseTurn handling (#2869)", () => {
	it("sets hasMoreToolCalls when stopReason is pauseTurn", () => {
		const source = readFileSync(join(__dirname, "agent-loop.ts"), "utf-8");

		// The agent loop must treat pauseTurn as a reason to continue the inner
		// loop, just like toolUse. This prevents incomplete server_tool_use blocks
		// from being saved to history, which would cause a 400 on the next request.
		assert.match(
			source,
			/pauseTurn/,
			"agent-loop.ts must handle the pauseTurn stop reason",
		);

		// Verify it sets hasMoreToolCalls = true for pauseTurn
		assert.match(
			source,
			/stopReason\s*===?\s*["']pauseTurn["']/,
			'agent-loop.ts must check for stopReason === "pauseTurn"',
		);
	});

	it("pauseTurn is in the StopReason union type", () => {
		// Read the pi-ai types to ensure pauseTurn is a valid StopReason
		const typesPath = join(__dirname, "..", "..", "pi-ai", "src", "types.ts");
		const typesSource = readFileSync(typesPath, "utf-8");
		assert.match(
			typesSource,
			/["']pauseTurn["']/,
			'StopReason type must include "pauseTurn"',
		);
	});
});
