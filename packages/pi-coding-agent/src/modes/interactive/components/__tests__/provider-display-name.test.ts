// GSD-2 — Provider display name + auth badge tests
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { providerAuthBadge, providerDisplayName } from "../model-selector.js";

describe("providerDisplayName", () => {
	test("passes providers through unchanged", () => {
		assert.equal(providerDisplayName("anthropic"), "anthropic");
		assert.equal(providerDisplayName("claude-code"), "claude-code");
		assert.equal(providerDisplayName("openai"), "openai");
		assert.equal(providerDisplayName("bedrock"), "bedrock");
		assert.equal(providerDisplayName("github-copilot"), "github-copilot");
		assert.equal(providerDisplayName("openrouter"), "openrouter");
	});
});

describe("providerAuthBadge", () => {
	test("returns human-readable labels for each auth mode", () => {
		assert.equal(providerAuthBadge("apiKey"), "API key");
		assert.equal(providerAuthBadge("oauth"), "OAuth");
		assert.equal(providerAuthBadge("externalCli"), "CLI");
	});

	test("returns empty string for 'none' and undefined", () => {
		assert.equal(providerAuthBadge("none"), "");
		assert.equal(providerAuthBadge(undefined), "");
	});
});
