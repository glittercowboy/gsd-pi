// GSD-2 — Regression test for #3616: discuss tool scoping must not leak into subsequent sessions
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

/**
 * Bug #3616: After a discuss session narrows the active tool set via
 * setActiveTools(), the narrowed list persisted into the next auto-mode
 * session because newSession() did not restore extension tools when cwd
 * was unchanged. This caused gsd_plan_slice and other DB tools to be
 * missing from plan-slice subagent sessions.
 *
 * This test verifies the structural properties that prevent the leak:
 *   1. guided-flow.ts narrows tools ONLY for discuss-* unit types
 *   2. The narrowed set explicitly excludes gsd_plan_slice (a HEAVY_TOOL)
 *   3. agent-session.ts:newSession() has an else-branch that restores
 *      all extension tools even when cwd hasn't changed
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { DISCUSS_TOOLS_ALLOWLIST } from "../constants.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const guidedFlowSource = readFileSync(join(__dirname, "..", "guided-flow.ts"), "utf-8");

describe("#3616 — discuss tool scoping must not leak across sessions", () => {
	test("gsd_plan_slice is NOT in DISCUSS_TOOLS_ALLOWLIST", () => {
		assert.ok(
			!DISCUSS_TOOLS_ALLOWLIST.includes("gsd_plan_slice"),
			"gsd_plan_slice should be excluded from discuss scope (it's a heavy planning tool)",
		);
	});

	test("tool scoping only activates for discuss-* unit types", () => {
		// The guard must be: if (unitType?.startsWith("discuss-"))
		assert.ok(
			guidedFlowSource.includes('unitType?.startsWith("discuss-")'),
			"tool scoping should only trigger for discuss-* unit types",
		);
	});

	test("discuss tool scoping uses setActiveTools (not setTools) for reversibility", () => {
		// setActiveTools changes the active subset but doesn't remove tools from
		// the registry. newSession()'s _refreshToolRegistry can restore them.
		assert.ok(
			guidedFlowSource.includes("pi.setActiveTools(scopedTools)"),
			"should use pi.setActiveTools to narrow tools (preserving registry)",
		);
	});

	test("newSession() in agent-session.ts has defense against tool narrowing persistence", () => {
		const agentSessionSource = readFileSync(
			join(process.cwd(), "packages/pi-coding-agent/src/core/agent-session.ts"),
			"utf-8",
		);
		const newSessionStart = agentSessionSource.indexOf("async newSession(options?:");
		assert.ok(newSessionStart >= 0, "should find newSession");
		const body = agentSessionSource.slice(newSessionStart, newSessionStart + 3000);

		// Both branches (cwd-changed and cwd-unchanged) must include extension tools
		assert.ok(
			body.includes("includeAllExtensionTools: true"),
			"newSession() must include all extension tools in both branches",
		);

		// Count occurrences — should be at least 2 (one per branch)
		const matches = body.match(/includeAllExtensionTools:\s*true/g);
		assert.ok(
			matches && matches.length >= 2,
			`expected >=2 includeAllExtensionTools:true in newSession(), got ${matches?.length ?? 0}`,
		);
	});
});
