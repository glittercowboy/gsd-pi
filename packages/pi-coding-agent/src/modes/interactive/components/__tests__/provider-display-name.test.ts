// GSD-2 — Provider display name mapping tests
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { providerDisplayName } from "../model-selector.js";

describe("providerDisplayName", () => {
	test("renames 'anthropic' to 'anthropic-api'", () => {
		assert.equal(providerDisplayName("anthropic"), "anthropic-api");
	});

	test("passes through unmapped providers unchanged", () => {
		assert.equal(providerDisplayName("claude-code"), "claude-code");
		assert.equal(providerDisplayName("openai"), "openai");
		assert.equal(providerDisplayName("bedrock"), "bedrock");
	});
});
