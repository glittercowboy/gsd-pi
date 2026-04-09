import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SessionManager } from "./session-manager.js";

function makeAssistantMessage(input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0) {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		usage: {
			input,
			output,
			cacheRead,
			cacheWrite,
			total: input + output + cacheRead + cacheWrite,
			cost: { total: cost },
		},
	} as any;
}

describe("SessionManager usage totals", () => {
	let dir: string;

	afterEach(() => {
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("tracks assistant usage incrementally without rescanning entries", () => {
		dir = mkdtempSync(join(tmpdir(), "gsd-session-manager-test-"));
		const manager = SessionManager.create(dir, dir);

		manager.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }] } as any);
		manager.appendMessage(makeAssistantMessage(10, 5, 3, 2, 0.25));
		manager.appendMessage(makeAssistantMessage(7, 4, 1, 0, 0.1));

		assert.deepEqual(manager.getUsageTotals(), {
			input: 17,
			output: 9,
			cacheRead: 4,
			cacheWrite: 2,
			cost: 0.35,
		});
	});

	it("resets totals when starting a new session", () => {
		dir = mkdtempSync(join(tmpdir(), "gsd-session-manager-test-"));
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage(makeAssistantMessage(5, 5, 0, 0, 0.05));
		assert.equal(manager.getUsageTotals().input, 5);

		manager.newSession();
		assert.deepEqual(manager.getUsageTotals(), {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
		});
	});
});
