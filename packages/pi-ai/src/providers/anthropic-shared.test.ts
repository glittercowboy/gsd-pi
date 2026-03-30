import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapStopReason } from "./anthropic-shared.js";

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
