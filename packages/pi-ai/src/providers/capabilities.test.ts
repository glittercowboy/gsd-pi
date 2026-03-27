// GSD-2 — Tests for provider capability registry (ADR-005)
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	getProviderCapabilities,
	getRegisteredApis,
	getApiVariantAliases,
	setProviderCapabilityOverrides,
	clearProviderCapabilityOverrides,
	clampThinkingLevel,
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

		test("every API in register-builtins.ts is covered by registry or aliases (dynamic CI check)", () => {
			// Dynamically read register-builtins.ts source to extract all registered API strings.
			// This test fails CI if a new provider is added without a registry/alias entry.
			const __filename = fileURLToPath(import.meta.url);
			const __dirname = dirname(__filename);
			const source = readFileSync(
				join(__dirname, "register-builtins.ts"),
				"utf-8",
			);
			// Extract all `api: "..."` values from registerApiProvider calls
			const apiRegex = /api:\s*"([^"]+)"/g;
			const registeredApis: string[] = [];
			let match;
			while ((match = apiRegex.exec(source)) !== null) {
				registeredApis.push(match[1]);
			}

			assert.ok(registeredApis.length > 0, "Failed to parse any APIs from register-builtins.ts");

			const canonicals = getRegisteredApis();
			const aliases = getApiVariantAliases();

			for (const api of registeredApis) {
				const inRegistry = canonicals.includes(api);
				const inAliases = api in aliases;
				assert.ok(
					inRegistry || inAliases,
					`API "${api}" is registered in register-builtins.ts but has no entry in ` +
					`PROVIDER_CAPABILITIES (canonical) or API_VARIANT_ALIASES. ` +
					`Add it to capabilities.ts to ensure tool compatibility filtering works for this provider.`,
				);
			}
		});
	});

	describe("provider capability overrides (Phase 6)", () => {
		afterEach(() => {
			clearProviderCapabilityOverrides();
		});

		test("override changes a specific field while preserving others", () => {
			setProviderCapabilityOverrides({
				"openai-responses": { imageToolResults: true },
			});
			const caps = getProviderCapabilities("openai-responses");
			// Override applied
			assert.equal(caps.imageToolResults, true);
			// Other fields preserved from built-in
			assert.equal(caps.toolCalling, true);
			assert.equal(caps.thinkingPersistence, "text-only");
		});

		test("override for unknown API creates new entry with merged permissive defaults", () => {
			setProviderCapabilityOverrides({
				"my-custom-api": { toolCalling: false },
			});
			const caps = getProviderCapabilities("my-custom-api");
			assert.equal(caps.toolCalling, false);
			// Other fields come from permissive default
			assert.equal(caps.imageToolResults, true);
		});

		test("clearing overrides restores built-in values", () => {
			setProviderCapabilityOverrides({
				"openai-responses": { imageToolResults: true },
			});
			assert.equal(getProviderCapabilities("openai-responses").imageToolResults, true);

			clearProviderCapabilityOverrides();
			assert.equal(getProviderCapabilities("openai-responses").imageToolResults, false);
		});

		test("setProviderCapabilityOverrides with undefined clears overrides", () => {
			setProviderCapabilityOverrides({
				"anthropic-messages": { maxTools: 10 },
			});
			assert.equal(getProviderCapabilities("anthropic-messages").maxTools, 10);

			setProviderCapabilityOverrides(undefined);
			assert.equal(getProviderCapabilities("anthropic-messages").maxTools, 0);
		});

		test("override does not affect other APIs", () => {
			setProviderCapabilityOverrides({
				"openai-responses": { imageToolResults: true },
			});
			// Anthropic should be unchanged
			const anthropic = getProviderCapabilities("anthropic-messages");
			assert.equal(anthropic.imageToolResults, true); // built-in value
		});

		test("override for variant API applies only to variant, not canonical", () => {
			setProviderCapabilityOverrides({
				"google-vertex": { imageToolResults: false },
			});
			// google-vertex override applied
			const vertex = getProviderCapabilities("google-vertex");
			assert.equal(vertex.imageToolResults, false);

			// canonical google-generative-ai unchanged
			const google = getProviderCapabilities("google-generative-ai");
			assert.equal(google.imageToolResults, true);
		});

		test("partial toolCallIdFormat override preserves other nested fields (deep merge)", () => {
			setProviderCapabilityOverrides({
				"anthropic-messages": {
					toolCallIdFormat: { maxLength: 128 },
				} as any,
			});
			const caps = getProviderCapabilities("anthropic-messages");
			assert.equal(caps.toolCallIdFormat.maxLength, 128);
			// allowedChars should be preserved from built-in, not lost
			assert.ok(caps.toolCallIdFormat.allowedChars instanceof RegExp);
			assert.ok(caps.toolCallIdFormat.allowedChars.test("abc123"));
		});

		test("string allowedChars in override is converted to RegExp", () => {
			setProviderCapabilityOverrides({
				"anthropic-messages": {
					toolCallIdFormat: { maxLength: 256, allowedChars: "^[a-z]+$" },
				} as any,
			});
			const caps = getProviderCapabilities("anthropic-messages");
			assert.equal(caps.toolCallIdFormat.maxLength, 256);
			assert.ok(caps.toolCallIdFormat.allowedChars instanceof RegExp);
			assert.ok(caps.toolCallIdFormat.allowedChars.test("abc"));
			assert.ok(!caps.toolCallIdFormat.allowedChars.test("ABC123"));
		});

		test("same reference skips reparse (caching)", () => {
			const overrides = { "openai-responses": { imageToolResults: true } };
			setProviderCapabilityOverrides(overrides);
			assert.equal(getProviderCapabilities("openai-responses").imageToolResults, true);
			// Call again with same reference — should be a no-op (cached)
			setProviderCapabilityOverrides(overrides);
			assert.equal(getProviderCapabilities("openai-responses").imageToolResults, true);
		});
	});

	describe("clampThinkingLevel", () => {
		afterEach(() => {
			clearProviderCapabilityOverrides();
		});

		test("minimal is clamped to low for OpenAI (gpt-5.3-codex fix)", () => {
			const result = clampThinkingLevel("openai-responses", "minimal");
			assert.equal(result, "low");
		});

		test("minimal is clamped to low for OpenAI codex variant", () => {
			const result = clampThinkingLevel("openai-codex-responses", "minimal");
			assert.equal(result, "low");
		});

		test("minimal is supported for Anthropic (no clamping)", () => {
			const result = clampThinkingLevel("anthropic-messages", "minimal");
			assert.equal(result, "minimal");
		});

		test("xhigh is clamped to high for Google (not supported)", () => {
			const result = clampThinkingLevel("google-generative-ai", "xhigh");
			assert.equal(result, "high");
		});

		test("supported level passes through unchanged", () => {
			assert.equal(clampThinkingLevel("openai-responses", "medium"), "medium");
			assert.equal(clampThinkingLevel("anthropic-messages", "high"), "high");
			assert.equal(clampThinkingLevel("google-generative-ai", "low"), "low");
		});

		test("unknown provider returns level unchanged (fail-open)", () => {
			assert.equal(clampThinkingLevel("some-unknown-api", "minimal"), "minimal");
		});

		test("unknown level passes through unchanged", () => {
			assert.equal(clampThinkingLevel("openai-responses", "turbo"), "turbo");
		});
	});
});
