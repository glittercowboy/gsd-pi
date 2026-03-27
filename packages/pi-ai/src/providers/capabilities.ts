// GSD-2 — Provider capability registry for tool-aware model routing (ADR-005)
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import type { Api } from "../types.js";

/**
 * Declarative description of what a provider API supports.
 * Used by the tool-compatibility filter (Step 2) and adjustToolSet().
 */
export interface ProviderCapabilities {
	/** Whether models from this provider support tool calling */
	toolCalling: boolean;
	/** Maximum number of tools the provider handles well (0 = unlimited) */
	maxTools: number;
	/** Whether tool results can contain images */
	imageToolResults: boolean;
	/** Whether the provider supports structured JSON output */
	structuredOutput: boolean;
	/** Tool call ID format constraints */
	toolCallIdFormat: {
		maxLength: number;
		allowedChars: RegExp;
	};
	/** Whether thinking/reasoning blocks are preserved cross-turn */
	thinkingPersistence: "full" | "text-only" | "none";
	/** Schema features NOT supported (tools using these get filtered) */
	unsupportedSchemaFeatures: string[];
}

/**
 * Maximally permissive profile for unknown providers.
 * All features enabled, no restrictions — preserves current behavior exactly.
 */
export const PERMISSIVE_CAPABILITIES: ProviderCapabilities = {
	toolCalling: true,
	maxTools: 0,
	imageToolResults: true,
	structuredOutput: true,
	toolCallIdFormat: { maxLength: 512, allowedChars: /^.+$/ },
	thinkingPersistence: "full",
	unsupportedSchemaFeatures: [],
};

/**
 * Provider capabilities keyed by canonical API name.
 *
 * IMPORTANT: Keys are API protocol strings (e.g., "anthropic-messages"),
 * NOT provider short names (e.g., "anthropic"). See ADR-005 Pitfall 1.
 */
const PROVIDER_CAPABILITIES: Record<string, ProviderCapabilities> = {
	"anthropic-messages": {
		toolCalling: true,
		maxTools: 0,
		imageToolResults: true,
		structuredOutput: true,
		toolCallIdFormat: { maxLength: 64, allowedChars: /^[a-zA-Z0-9_-]+$/ },
		thinkingPersistence: "full",
		unsupportedSchemaFeatures: [],
	},
	"openai-responses": {
		toolCalling: true,
		maxTools: 0,
		imageToolResults: false,
		structuredOutput: true,
		toolCallIdFormat: { maxLength: 512, allowedChars: /^.+$/ },
		thinkingPersistence: "text-only",
		unsupportedSchemaFeatures: [],
	},
	"google-generative-ai": {
		toolCalling: true,
		maxTools: 0,
		imageToolResults: true,
		structuredOutput: true,
		toolCallIdFormat: { maxLength: 64, allowedChars: /^[a-zA-Z0-9_-]+$/ },
		thinkingPersistence: "text-only",
		unsupportedSchemaFeatures: ["patternProperties"],
	},
	"mistral-conversations": {
		toolCalling: true,
		maxTools: 0,
		imageToolResults: false,
		structuredOutput: true,
		toolCallIdFormat: { maxLength: 9, allowedChars: /^[a-zA-Z0-9]+$/ },
		thinkingPersistence: "none",
		unsupportedSchemaFeatures: [],
	},
	"bedrock-converse-stream": {
		toolCalling: true,
		maxTools: 0,
		imageToolResults: false,
		structuredOutput: true,
		toolCallIdFormat: { maxLength: 64, allowedChars: /^[a-zA-Z0-9_-]+$/ },
		thinkingPersistence: "text-only",
		unsupportedSchemaFeatures: [],
	},
};

/**
 * Maps API variant names to their canonical parent API.
 * Variants inherit the parent's capabilities because they use the same
 * underlying protocol (e.g., anthropic-vertex uses anthropic-messages protocol).
 */
const API_VARIANT_ALIASES: Record<string, string> = {
	"anthropic-vertex": "anthropic-messages",
	"google-vertex": "google-generative-ai",
	"google-gemini-cli": "google-generative-ai",
	"azure-openai-responses": "openai-responses",
	"openai-codex-responses": "openai-responses",
	"openai-completions": "openai-responses",
};

/**
 * Returns provider capabilities for the given API string.
 *
 * Looks up the canonical API name first, then checks variant aliases.
 * Returns PERMISSIVE_CAPABILITIES for unknown APIs (fail-open).
 *
 * @param api - The API protocol string (e.g., "anthropic-messages", NOT "anthropic")
 */
export function getProviderCapabilities(api: Api): ProviderCapabilities {
	// Direct match on canonical API
	const direct = PROVIDER_CAPABILITIES[api];
	if (direct) return direct;

	// Check variant aliases
	const canonical = API_VARIANT_ALIASES[api];
	if (canonical) {
		const aliased = PROVIDER_CAPABILITIES[canonical];
		if (aliased) return aliased;
	}

	// Unknown API — return permissive default (fail-open)
	return PERMISSIVE_CAPABILITIES;
}

/**
 * Returns all canonical API names that have explicit capability entries.
 * Used by the registry completeness test.
 */
export function getRegisteredApis(): string[] {
	return Object.keys(PROVIDER_CAPABILITIES);
}

/**
 * Returns all known API variant aliases.
 * Used by the registry completeness test.
 */
export function getApiVariantAliases(): Record<string, string> {
	return { ...API_VARIANT_ALIASES };
}
