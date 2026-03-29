import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PartialMessageBuilder } from "../partial-builder.ts";
import type { BetaRawMessageStreamEvent } from "../sdk-types.ts";

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
});
