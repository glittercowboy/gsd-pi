import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { convertTools, mapStopReason, mapThinkingLevelToEffort } from "./anthropic-shared.js";

const makeTool = (name: string) =>
	({
		name,
		description: `desc for ${name}`,
		parameters: {
			type: "object" as const,
			properties: { arg: { type: "string" } },
			required: ["arg"],
		},
	}) as any;

describe("convertTools cache_control", () => {
	it("adds cache_control to the last tool when cacheControl is provided", () => {
		const tools = [makeTool("Read"), makeTool("Write"), makeTool("Edit")];
		const cacheControl = { type: "ephemeral" as const };
		const result = convertTools(tools, false, cacheControl);

		assert.equal(result.length, 3);
		assert.equal((result[0] as any).cache_control, undefined);
		assert.equal((result[1] as any).cache_control, undefined);
		assert.deepEqual((result[2] as any).cache_control, { type: "ephemeral" });
	});

	it("does not add cache_control when cacheControl is undefined", () => {
		const tools = [makeTool("Read"), makeTool("Write")];
		const result = convertTools(tools, false);

		for (const tool of result) {
			assert.equal((tool as any).cache_control, undefined);
		}
	});

	it("handles empty tools array without error", () => {
		const result = convertTools([], false, { type: "ephemeral" });
		assert.equal(result.length, 0);
	});

	it("passes through ttl when provided", () => {
		const tools = [makeTool("Read")];
		const cacheControl = { type: "ephemeral" as const, ttl: "1h" as const };
		const result = convertTools(tools, false, cacheControl);

		assert.deepEqual((result[0] as any).cache_control, { type: "ephemeral", ttl: "1h" });
	});

	it("single tool gets cache_control", () => {
		const tools = [makeTool("Read")];
		const result = convertTools(tools, false, { type: "ephemeral" });

		assert.equal(result.length, 1);
		assert.deepEqual((result[0] as any).cache_control, { type: "ephemeral" });
	});
});

describe("mapThinkingLevelToEffort", () => {
	it("maps xhigh to max for opus-4-6 (no native xhigh support)", () => {
		assert.equal(mapThinkingLevelToEffort("xhigh", "claude-opus-4-6"), "max");
	});

	it("maps xhigh to xhigh natively for opus-4-7", () => {
		assert.equal(mapThinkingLevelToEffort("xhigh", "claude-opus-4-7"), "xhigh");
	});

	it("maps high to high for opus-4-7", () => {
		assert.equal(mapThinkingLevelToEffort("high", "claude-opus-4-7"), "high");
	});
});

describe("mapStopReason", () => {
	it("maps end_turn to stop", () => {
		assert.equal(mapStopReason("end_turn"), "stop");
	});

	it("maps max_tokens to length", () => {
		assert.equal(mapStopReason("max_tokens"), "length");
	});

	it("maps tool_use to toolUse", () => {
		assert.equal(mapStopReason("tool_use"), "toolUse");
	});

	it("maps pause_turn to pauseTurn (not stop)", () => {
		// pause_turn means the server paused a long-running turn (e.g. native
		// web search hit its iteration limit). Mapping it to "stop" causes the
		// agent loop to exit, leaving an incomplete server_tool_use block in
		// history which triggers a 400 on the next request.
		assert.equal(mapStopReason("pause_turn"), "pauseTurn");
	});

	it("throws on unknown stop reason", () => {
		assert.throws(() => mapStopReason("bogus"), /Unhandled stop reason/);
	});
});
