import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "packages/pi-coding-agent/src/core/agent-session.ts"), "utf-8");

test("agent-session: explicit model switches cancel retry before applying new model", () => {
	const start = source.indexOf("private async _applyModelChange(");
	assert.ok(start >= 0, "missing _applyModelChange");
	const window = source.slice(start, start + 900);
	const abortIdx = window.indexOf("this._retryHandler.abortRetry();");
	const setModelIdx = window.indexOf("this.agent.setModel(model);");

	assert.ok(abortIdx >= 0, "_applyModelChange should cancel any in-flight retry");
	assert.ok(setModelIdx >= 0, "_applyModelChange should set the new model");
	assert.ok(
		abortIdx < setModelIdx,
		"retry cancellation must happen before applying the new model to prevent stale provider retries",
	);
});

test("agent-session: transient model switches pass persist options into thinking-level application", () => {
	const start = source.indexOf("private async _applyModelChange(");
	assert.ok(start >= 0, "missing _applyModelChange");
	const window = source.slice(start, start + 900);

	assert.ok(
		window.includes("this._applyThinkingLevel(thinkingLevel, options);"),
		"_applyModelChange should forward persist options when applying thinking level during model switches",
	);
});

test("agent-session: transient model switches do not persist thinking level defaults", () => {
	const start = source.indexOf("private _applyThinkingLevel(");
	assert.ok(start >= 0, "missing _applyThinkingLevel");
	const window = source.slice(start, start + 1200);

	assert.ok(
		window.includes("if (options?.persist !== false)"),
		"_applyThinkingLevel should gate all persistence (settings AND session history) behind persist check",
	);
	assert.ok(
		window.includes("this.settingsManager.setDefaultThinkingLevel(effectiveLevel)"),
		"settings persistence should be inside the persist guard",
	);
});

test("agent-session: transient thinking-level changes do not leak into session history (#3486 review)", () => {
	// Verifies jeremymcs' review finding: appendThinkingLevelChange must NOT run
	// when persist:false, because session resume replays these entries via the
	// public setThinkingLevel() which always persists — defeating the isolation.
	const start = source.indexOf("private _applyThinkingLevel(");
	assert.ok(start >= 0, "missing _applyThinkingLevel");
	const window = source.slice(start, start + 900);

	// appendThinkingLevelChange must be INSIDE the persist guard, not before it
	const persistGuardIdx = window.indexOf("if (options?.persist !== false)");
	const appendIdx = window.indexOf("this.sessionManager.appendThinkingLevelChange(effectiveLevel)");
	assert.ok(persistGuardIdx >= 0, "missing persist guard in _applyThinkingLevel");
	assert.ok(appendIdx >= 0, "missing appendThinkingLevelChange call");
	assert.ok(
		appendIdx > persistGuardIdx,
		"appendThinkingLevelChange must be inside the persist:false guard — " +
		"otherwise transient thinking-level changes survive in session history " +
		"and get replayed on resume via setThinkingLevel() which always persists",
	);
});
