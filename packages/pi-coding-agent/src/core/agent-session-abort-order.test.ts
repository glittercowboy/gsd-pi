import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
	join(process.cwd(), "packages/pi-coding-agent/src/core/agent-session.ts"),
	"utf-8",
);

describe("#4243 — abort() must be called before _disconnectFromAgent()", () => {
	test("newSession() calls abort() before _disconnectFromAgent()", () => {
		// Find the newSession method body where the fix was applied
		const newSessionStart = source.indexOf("async newSession(options?:");
		assert.ok(newSessionStart >= 0, "should find newSession method");

		// Get a window that includes the abort/disconnect section
		const window = source.slice(newSessionStart, newSessionStart + 1200);

		// Find the abort and _disconnectFromAgent calls
		const abortIdx = window.indexOf("await this.abort();");
		const disconnectIdx = window.indexOf("this._disconnectFromAgent();");

		assert.ok(abortIdx >= 0, "newSession should call await this.abort()");
		assert.ok(disconnectIdx >= 0, "newSession should call this._disconnectFromAgent()");
		assert.ok(
			abortIdx < disconnectIdx,
			"abort() must be called BEFORE _disconnectFromAgent() so that message_end/agent_end events fire before unsubscribing from the event bus",
		);
	});

	test("newSession() references #4243 in the abort/disconnect comment", () => {
		const idx = source.indexOf("#4243");
		assert.ok(idx >= 0, "source should reference issue #4243 for the abort-order fix");
	});

	test("switchSession() calls abort() before _disconnectFromAgent()", () => {
		// Find the switchSession method body
		const switchStart = source.indexOf("async switchSession(sessionPath:");
		assert.ok(switchStart >= 0, "should find switchSession method");

		// Get a window that includes the abort/disconnect section
		const window = source.slice(switchStart, switchStart + 800);

		// Find the abort and _disconnectFromAgent calls
		const abortIdx = window.indexOf("await this.abort();");
		const disconnectIdx = window.indexOf("this._disconnectFromAgent();");

		assert.ok(abortIdx >= 0, "switchSession should call await this.abort()");
		assert.ok(disconnectIdx >= 0, "switchSession should call this._disconnectFromAgent()");
		assert.ok(
			abortIdx < disconnectIdx,
			"abort() must be called BEFORE _disconnectFromAgent() in switchSession so that events fire before unsubscribing",
		);
	});
});
