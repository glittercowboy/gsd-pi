// GSD-2 — Tests for provider capability registry (ADR-005)
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	getProviderCapabilities,
	getRegisteredApis,
	getApiVariantAliases,
	PERMISSIVE_CAPABILITIES,
} from "./capabilities.js";

describe("Provider Capability Registry", () => {
	describe("getProviderCapabilities", () => {
		test("returns Anthropic profile for anthropic-messages", () => {
			const caps = getProviderCapabilities("anthropic-messages");
			assert.equal(caps.toolCalling, true);
			assert.equal(caps.imageToolResults, true);
			assert.equal(caps.thinkingPersistence, "full");
			assert.deepEqual(caps.unsupportedSchemaFeatures, []);
			assert.equal(caps.toolCallIdFormat.maxLength, 64);
		});

		test("returns OpenAI profile for openai-responses", () => {
			const caps = getProviderCapabilities("openai-responses");
			assert.equal(caps.imageToolResults, false);
			assert.equal(caps.thinkingPersistence, "text-only");
			assert.equal(caps.toolCallIdFormat.maxLength, 512);
		});

		test("returns Google profile with patternProperties restriction", () => {
			const caps = getProviderCapabilities("google-generative-ai");
			assert.equal(caps.imageToolResults, true);
			assert.equal(caps.thinkingPersistence, "text-only");
			assert.deepEqual(caps.unsupportedSchemaFeatures, ["patternProperties"]);
		});

		test("returns Mistral profile with short tool call IDs", () => {
			const caps = getProviderCapabilities("mistral-conversations");
			assert.equal(caps.imageToolResults, false);
			assert.equal(caps.thinkingPersistence, "none");
			assert.equal(caps.toolCallIdFormat.maxLength, 9);
		});

		test("returns Bedrock profile", () => {
			const caps = getProviderCapabilities("bedrock-converse-stream");
			assert.equal(caps.toolCalling, true);
			assert.equal(caps.imageToolResults, false);
			assert.equal(caps.thinkingPersistence, "text-only");
		});
	});

	describe("API variant aliases", () => {
		test("anthropic-vertex inherits anthropic-messages capabilities", () => {
			const variant = getProviderCapabilities("anthropic-vertex");
			const canonical = getProviderCapabilities("anthropic-messages");
			assert.deepEqual(variant.unsupportedSchemaFeatures, canonical.unsupportedSchemaFeatures);
			assert.equal(variant.imageToolResults, canonical.imageToolResults);
			assert.equal(variant.thinkingPersistence, canonical.thinkingPersistence);
		});

		test("google-vertex inherits google-generative-ai capabilities", () => {
			const variant = getProviderCapabilities("google-vertex");
			const canonical = getProviderCapabilities("google-generative-ai");
			assert.deepEqual(variant.unsupportedSchemaFeatures, canonical.unsupportedSchemaFeatures);
			assert.equal(variant.imageToolResults, canonical.imageToolResults);
		});

		test("google-gemini-cli inherits google-generative-ai capabilities", () => {
			const variant = getProviderCapabilities("google-gemini-cli");
			const canonical = getProviderCapabilities("google-generative-ai");
			assert.deepEqual(variant.unsupportedSchemaFeatures, canonical.unsupportedSchemaFeatures);
		});

		test("azure-openai-responses inherits openai-responses capabilities", () => {
			const variant = getProviderCapabilities("azure-openai-responses");
			const canonical = getProviderCapabilities("openai-responses");
			assert.equal(variant.imageToolResults, canonical.imageToolResults);
			assert.equal(variant.thinkingPersistence, canonical.thinkingPersistence);
		});

		test("openai-codex-responses inherits openai-responses capabilities", () => {
			const variant = getProviderCapabilities("openai-codex-responses");
			const canonical = getProviderCapabilities("openai-responses");
			assert.equal(variant.imageToolResults, canonical.imageToolResults);
		});

		test("openai-completions inherits openai-responses capabilities", () => {
			const variant = getProviderCapabilities("openai-completions");
			const canonical = getProviderCapabilities("openai-responses");
			assert.equal(variant.imageToolResults, canonical.imageToolResults);
		});
	});

	describe("fail-open for unknown APIs", () => {
		test("unknown API returns permissive default", () => {
			const caps = getProviderCapabilities("some-unknown-api");
			assert.equal(caps, PERMISSIVE_CAPABILITIES);
			assert.equal(caps.toolCalling, true);
			assert.equal(caps.maxTools, 0);
			assert.equal(caps.imageToolResults, true);
			assert.equal(caps.structuredOutput, true);
			assert.equal(caps.thinkingPersistence, "full");
			assert.deepEqual(caps.unsupportedSchemaFeatures, []);
		});

		test("bare provider name returns permissive default, NOT the provider profile (Pitfall 1)", () => {
			// "anthropic" is a provider short name, not an API name.
			// It must NOT match the "anthropic-messages" entry.
			const caps = getProviderCapabilities("anthropic");
			assert.equal(caps, PERMISSIVE_CAPABILITIES);
		});

		test("bare google provider name returns permissive default", () => {
			const caps = getProviderCapabilities("google");
			assert.equal(caps, PERMISSIVE_CAPABILITIES);
		});

		test("bare openai provider name returns permissive default", () => {
			const caps = getProviderCapabilities("openai");
			assert.equal(caps, PERMISSIVE_CAPABILITIES);
		});

		test("empty string returns permissive default", () => {
			const caps = getProviderCapabilities("");
			assert.equal(caps, PERMISSIVE_CAPABILITIES);
		});
	});

	describe("registry completeness", () => {
		test("all 5 canonical APIs have entries", () => {
			const apis = getRegisteredApis();
			assert.ok(apis.includes("anthropic-messages"));
			assert.ok(apis.includes("openai-responses"));
			assert.ok(apis.includes("google-generative-ai"));
			assert.ok(apis.includes("mistral-conversations"));
			assert.ok(apis.includes("bedrock-converse-stream"));
			assert.equal(apis.length, 5);
		});

		test("all variant aliases point to registered canonical APIs", () => {
			const aliases = getApiVariantAliases();
			const canonicals = getRegisteredApis();
			for (const [variant, canonical] of Object.entries(aliases)) {
				assert.ok(
					canonicals.includes(canonical),
					`Variant "${variant}" points to unregistered canonical "${canonical}"`,
				);
			}
		});

		test("variant aliases cover all non-canonical APIs from register-builtins", () => {
			// These are the APIs registered in register-builtins.ts that are NOT canonical
			const expectedVariants = [
				"anthropic-vertex",
				"google-vertex",
				"google-gemini-cli",
				"azure-openai-responses",
				"openai-codex-responses",
				"openai-completions",
			];
			const aliases = getApiVariantAliases();
			for (const variant of expectedVariants) {
				assert.ok(
					variant in aliases,
					`Expected variant alias for "${variant}" (registered in register-builtins.ts)`,
				);
			}
		});
	});
});
