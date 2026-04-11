// GSD-2 — Regression tests for #3616: tool list persistence across newSession() calls
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
	join(process.cwd(), "packages/pi-coding-agent/src/core/agent-session.ts"),
	"utf-8",
);

describe("#3616 — newSession() must restore full tool set", () => {
	test("newSession() calls _refreshToolRegistry with includeAllExtensionTools when cwd is unchanged", () => {
		// Find the newSession method
		const newSessionStart = source.indexOf("async newSession(options?:");
		assert.ok(newSessionStart >= 0, "should find newSession method");

		// Get the method body (up to the next top-level method)
		const methodBody = source.slice(newSessionStart, newSessionStart + 3000);

		// Verify the cwd-changed branch rebuilds tools
		assert.ok(
			methodBody.includes("if (this._cwd !== previousCwd)"),
			"should have cwd-change guard",
		);

		// Verify the else branch exists and refreshes tools with includeAllExtensionTools
		const elseIdx = methodBody.indexOf("} else {");
		assert.ok(elseIdx >= 0, "should have else branch for cwd-unchanged case");

		const elseBranch = methodBody.slice(elseIdx, elseIdx + 800);
		assert.ok(
			elseBranch.includes("_refreshToolRegistry"),
			"else branch should call _refreshToolRegistry",
		);
		assert.ok(
			elseBranch.includes("includeAllExtensionTools: true"),
			"else branch should pass includeAllExtensionTools: true to restore narrowed tools",
		);
	});

	test("newSession() references #3616 in the else-branch comment", () => {
		const idx = source.indexOf("#3616");
		assert.ok(idx >= 0, "source should reference issue #3616 for the tool restore fix");
	});

	test("agent.reset() does not clear _state.tools (tools persist across reset)", () => {
		// This is a structural invariant — if reset() starts clearing tools,
		// the newSession() refresh becomes the only defense against tool loss.
		const agentSource = readFileSync(
			join(process.cwd(), "packages/pi-agent-core/src/agent.ts"),
			"utf-8",
		);
		const resetStart = agentSource.indexOf("reset()");
		assert.ok(resetStart >= 0, "should find reset() method");
		const resetBody = agentSource.slice(resetStart, resetStart + 400);
		assert.ok(
			!resetBody.includes("tools"),
			"reset() should NOT touch _state.tools — tools are managed by agent-session",
		);
	});
});
