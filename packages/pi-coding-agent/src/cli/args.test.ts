// Regression tests for #4479: subagents launching with empty tools list when
// --tools includes capitalized built-in names or extension/MCP tool names.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./args.js";

describe("#4479 — --tools parsing", () => {
	test("matches built-in names case-insensitively", () => {
		const args = parseArgs(["--tools", "Read,Bash,Edit,Write"]);
		assert.deepEqual(args.tools, ["read", "bash", "edit", "write"]);
		assert.equal(args.extraToolNames, undefined);
	});

	test("preserves lowercase built-in names unchanged", () => {
		const args = parseArgs(["--tools", "read,bash"]);
		assert.deepEqual(args.tools, ["read", "bash"]);
		assert.equal(args.extraToolNames, undefined);
	});

	test("defers unrecognized names as extraToolNames (likely extension/MCP)", () => {
		const args = parseArgs(["--tools", "read,gsd_complete_task,browser_navigate"]);
		assert.deepEqual(args.tools, ["read"]);
		assert.deepEqual(args.extraToolNames, ["gsd_complete_task", "browser_navigate"]);
	});

	test("normalizes only the built-in match; extras keep original casing", () => {
		const args = parseArgs(["--tools", "Read,GSD_Complete_Task"]);
		assert.deepEqual(args.tools, ["read"]);
		assert.deepEqual(args.extraToolNames, ["GSD_Complete_Task"]);
	});

	test("filters empty entries from comma-separated list", () => {
		const args = parseArgs(["--tools", "read,,bash, , "]);
		assert.deepEqual(args.tools, ["read", "bash"]);
		assert.equal(args.extraToolNames, undefined);
	});

	test("only-extension-tools input yields empty tools but populated extras", () => {
		const args = parseArgs(["--tools", "gsd_complete_task"]);
		assert.deepEqual(args.tools, []);
		assert.deepEqual(args.extraToolNames, ["gsd_complete_task"]);
	});
});
