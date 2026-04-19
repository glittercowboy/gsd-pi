import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mapContentBlock, parseMcpToolName, PartialMessageBuilder } from "../partial-builder.ts";
import type { BetaContentBlock, BetaRawMessageStreamEvent } from "../sdk-types.ts";

describe("PartialMessageBuilder — malformed tool arguments (#2574)", () => {
	/**
	 * Helper: feed a tool_use block through the builder lifecycle and return
	 * the toolcall_end event. Simulates: content_block_start → N deltas → content_block_stop.
	 */
	function feedToolCall(
		builder: PartialMessageBuilder,
		jsonFragments: string[],
	) {
		// Start the tool_use block at stream index 0
		builder.handleEvent({
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "tool_1", name: "gsd_plan_slice", input: {} },
		} as BetaRawMessageStreamEvent);

		// Feed JSON fragments as input_json_delta
		for (const fragment of jsonFragments) {
			builder.handleEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: fragment },
			} as BetaRawMessageStreamEvent);
		}

		// Stop the block — this is where JSON parse happens
		return builder.handleEvent({
			type: "content_block_stop",
			index: 0,
		} as BetaRawMessageStreamEvent);
	}

	test("valid JSON → toolcall_end without malformedArguments", () => {
		const builder = new PartialMessageBuilder("claude-sonnet-4-20250514");
		const event = feedToolCall(builder, ['{"milestone', 'Id": "M001"}']);

		assert.ok(event, "event should not be null");
		assert.equal(event!.type, "toolcall_end");
		// Valid JSON should NOT have the malformedArguments flag
		assert.equal(
			(event as any).malformedArguments,
			undefined,
			"valid JSON should not set malformedArguments",
		);
		// Arguments should be parsed correctly
		if (event!.type === "toolcall_end") {
			assert.deepEqual(event!.toolCall.arguments, { milestoneId: "M001" });
		}
	});

	test("truncated JSON → toolcall_end WITH malformedArguments: true", () => {
		const builder = new PartialMessageBuilder("claude-sonnet-4-20250514");
		// Simulate a stream truncation: JSON is cut off mid-value
		const event = feedToolCall(builder, ['{"milestone', 'Id": "M00']);

		assert.ok(event, "event should not be null");
		assert.equal(event!.type, "toolcall_end");
		assert.equal(
			(event as any).malformedArguments,
			true,
			"truncated JSON should set malformedArguments: true",
		);
		// The _raw field should contain the original broken JSON
		if (event!.type === "toolcall_end") {
			assert.equal(
				event!.toolCall.arguments._raw,
				'{"milestoneId": "M00',
				"_raw should contain the truncated JSON string",
			);
		}
	});

	test("no JSON deltas → malformedArguments: true (empty accumulator is not valid JSON)", () => {
		const builder = new PartialMessageBuilder("claude-sonnet-4-20250514");
		// No deltas — the accumulator is initialized to "" by content_block_start,
		// and "" is not valid JSON, so this correctly signals malformed.
		const event = feedToolCall(builder, []);

		assert.ok(event, "event should not be null");
		assert.equal(event!.type, "toolcall_end");
		assert.equal(
			(event as any).malformedArguments,
			true,
			"empty accumulator (no JSON deltas) is not valid JSON → malformed",
		);
	});

	test("garbage input (non-JSON) → malformedArguments: true", () => {
		const builder = new PartialMessageBuilder("claude-sonnet-4-20250514");
		const event = feedToolCall(builder, ["not json at all <html>"]);

		assert.ok(event, "event should not be null");
		assert.equal(event!.type, "toolcall_end");
		assert.equal(
			(event as any).malformedArguments,
			true,
			"non-JSON content should set malformedArguments: true",
		);
	});

	test("YAML bullet lists repaired to JSON arrays (#2660)", () => {
		const builder = new PartialMessageBuilder("claude-sonnet-4-20250514");
		const malformedJson =
			'{"milestoneId": "M005", "keyDecisions": - Used Web Notification API, "keyFiles": - src/lib.rs, "title": "done"}';
		const event = feedToolCall(builder, [malformedJson]);

		assert.ok(event, "event should not be null");
		assert.equal(event!.type, "toolcall_end");
		// Repaired YAML bullets should NOT set malformedArguments
		assert.equal(
			(event as any).malformedArguments,
			undefined,
			"repaired YAML bullets should not set malformedArguments",
		);
		if (event!.type === "toolcall_end") {
			assert.equal(event!.toolCall.arguments.milestoneId, "M005");
			assert.ok(
				Array.isArray(event!.toolCall.arguments.keyDecisions),
				"keyDecisions should be repaired to an array",
			);
			assert.ok(
				Array.isArray(event!.toolCall.arguments.keyFiles),
				"keyFiles should be repaired to an array",
			);
			assert.equal(event!.toolCall.arguments.title, "done");
		}
	});

	test("XML parameter tags trapped inside valid JSON strings are promoted (#3751)", () => {
		const builder = new PartialMessageBuilder("claude-sonnet-4-20250514");
		const malformedJson =
			'{"narrative":"text.</narrative>\\n<parameter name=\\"verification\\">all tests pass</parameter>\\n<parameter name=\\"verificationEvidence\\">[\\"npm test\\"]</parameter>","oneLiner":"done"}';
		const event = feedToolCall(builder, [malformedJson]);

		assert.ok(event, "event should not be null");
		assert.equal(event!.type, "toolcall_end");
		assert.equal((event as any).malformedArguments, undefined);
		if (event!.type === "toolcall_end") {
			assert.equal(event.toolCall.arguments.narrative, "text.");
			assert.equal(event.toolCall.arguments.verification, "all tests pass");
			assert.deepEqual(event.toolCall.arguments.verificationEvidence, ["npm test"]);
			assert.equal(event.toolCall.arguments.oneLiner, "done");
		}
	});
});

describe("parseMcpToolName", () => {
	test("splits mcp__<server>__<tool> into parts", () => {
		assert.deepEqual(
			parseMcpToolName("mcp__gsd-workflow__gsd_plan_milestone"),
			{ server: "gsd-workflow", tool: "gsd_plan_milestone" },
		);
	});

	test("preserves server names containing hyphens", () => {
		assert.deepEqual(
			parseMcpToolName("mcp__my-cool-server__do_thing"),
			{ server: "my-cool-server", tool: "do_thing" },
		);
	});

	test("preserves tool names containing underscores", () => {
		assert.deepEqual(
			parseMcpToolName("mcp__srv__a_b_c_d"),
			{ server: "srv", tool: "a_b_c_d" },
		);
	});

	test("returns null for non-prefixed names", () => {
		assert.equal(parseMcpToolName("Bash"), null);
		assert.equal(parseMcpToolName("gsd_plan_milestone"), null);
	});

	test("returns null for malformed prefixes", () => {
		assert.equal(parseMcpToolName("mcp__"), null);
		assert.equal(parseMcpToolName("mcp__server"), null);
		assert.equal(parseMcpToolName("mcp__server__"), null);
		assert.equal(parseMcpToolName("mcp____tool"), null);
	});
});

describe("PartialMessageBuilder — MCP tool name normalization", () => {
	test("strips mcp__<server>__ prefix on content_block_start", () => {
		const builder = new PartialMessageBuilder("claude-sonnet-4-20250514");
		const event = builder.handleEvent({
			type: "content_block_start",
			index: 0,
			content_block: {
				type: "tool_use",
				id: "tool_1",
				name: "mcp__gsd-workflow__gsd_plan_milestone",
				input: {},
			},
		} as BetaRawMessageStreamEvent);

		assert.ok(event, "event should not be null");
		assert.equal(event!.type, "toolcall_start");
		if (event!.type === "toolcall_start") {
			const toolCall = (event.partial.content[event.contentIndex] as any);
			assert.equal(toolCall.name, "gsd_plan_milestone");
			assert.equal(toolCall.mcpServer, "gsd-workflow");
		}
	});

	test("leaves non-MCP tool names untouched", () => {
		const builder = new PartialMessageBuilder("claude-sonnet-4-20250514");
		const event = builder.handleEvent({
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "tool_1", name: "Bash", input: {} },
		} as BetaRawMessageStreamEvent);

		assert.ok(event);
		if (event!.type === "toolcall_start") {
			const toolCall = (event.partial.content[event.contentIndex] as any);
			assert.equal(toolCall.name, "Bash");
			assert.equal(toolCall.mcpServer, undefined);
		}
	});

	test("mapContentBlock strips MCP prefix on full tool_use blocks", () => {
		const block: BetaContentBlock = {
			type: "tool_use",
			id: "tool_2",
			name: "mcp__gsd-workflow__gsd_task_complete",
			input: { taskId: "T001" },
		};
		const mapped = mapContentBlock(block) as any;
		assert.equal(mapped.type, "toolCall");
		assert.equal(mapped.name, "gsd_task_complete");
		assert.equal(mapped.mcpServer, "gsd-workflow");
		assert.deepEqual(mapped.arguments, { taskId: "T001" });
	});
});
