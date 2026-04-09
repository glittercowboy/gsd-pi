// Agent activeInferenceModel regression tests
// Verifies that activeInferenceModel is set/cleared correctly in _runLoop,
// and that the footer reads activeInferenceModel instead of state.model.
// Regression test for https://github.com/gsd-build/gsd-2/issues/1844 Bug 2

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("Agent — activeInferenceModel (#1844 Bug 2)", () => {
	it("activeInferenceModel is declared in AgentState interface", () => {
		const typesSource = readFileSync(join(__dirname, "types.ts"), "utf-8");
		assert.match(typesSource, /activeInferenceModel\??:\s*Model/,
			"AgentState must declare activeInferenceModel field");
	});

	it("_runLoop sets activeInferenceModel before streaming and clears in finally", () => {
		const agentSource = readFileSync(join(__dirname, "agent.ts"), "utf-8");

		// Must set activeInferenceModel = model before streaming starts
		const setLine = agentSource.indexOf("this._state.activeInferenceModel = model");
		assert.ok(setLine > -1, "agent.ts must set activeInferenceModel = model in _runLoop");

		// Must clear activeInferenceModel = undefined after streaming completes
		const clearLine = agentSource.indexOf("this._state.activeInferenceModel = undefined");
		assert.ok(clearLine > -1, "agent.ts must clear activeInferenceModel in finally block");

		// The set must come before the clear
		assert.ok(setLine < clearLine, "activeInferenceModel must be set before cleared");
	});

	it("footer displays activeInferenceModel instead of state.model", () => {
		const footerPath = join(__dirname, "..", "..", "pi-coding-agent", "src",
			"modes", "interactive", "components", "footer.ts");
		const footerSource = readFileSync(footerPath, "utf-8");
		assert.match(footerSource, /activeInferenceModel/,
			"footer.ts must reference activeInferenceModel for display");
	});

	it("activeInferenceModel is set before AbortController creation", () => {
		const agentSource = readFileSync(join(__dirname, "agent.ts"), "utf-8");

		const setLine = agentSource.indexOf("this._state.activeInferenceModel = model");
		const abortLine = agentSource.indexOf("this.abortController = new AbortController");
		assert.ok(setLine > -1 && abortLine > -1);
		assert.ok(setLine < abortLine,
			"activeInferenceModel must be set before streaming infrastructure is created");
	});
});
