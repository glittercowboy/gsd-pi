// GSD-2 — Provider capability registry for tool-aware model routing (ADR-005)
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
//
// Pipeline contract (ADR-005):
//   The tool-compatibility filter (Step 2) runs BEFORE capability scoring (Step 3).
//   If a `before_model_select` hook is added in the future, it receives the
//   POST-tool-filter candidate set — not the full tier-eligible set. This means
//   the hook cannot override to a model that was filtered for tool incompatibility
//   unless it explicitly opts out via a `force: true` return value.

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

// ─── Runtime Overrides (ADR-005 Phase 6) ───────────────────────────────────
// Loaded from preferences `provider_capabilities` key and deep-merged with
// built-in defaults. Call setProviderCapabilityOverrides() at preferences load.

// Module-level singleton — safe because auto-loop dispatches are sequential.
// If parallel dispatch is added, this must become per-dispatch or use a lock.
let capabilityOverrides: Record<string, Partial<ProviderCapabilities>> = {};
let lastOverrideInput: Record<string, Record<string, unknown>> | undefined | null = null;

/**
 * Apply provider capability overrides from user preferences.
 * Call this when preferences are loaded/reloaded.
 * Overrides are deep-merged: only specified fields are changed, others keep built-in defaults.
 *
 * Skips re-parsing when the same reference is passed (common in sequential dispatches).
 *
 * Keys should be API protocol strings (e.g., "openai-responses").
 * Unknown keys that don't match any canonical or alias API will still be stored —
 * they create new entries that override the permissive default for custom APIs.
 */
export function setProviderCapabilityOverrides(
	overrides: Record<string, Record<string, unknown>> | undefined,
): string[] {
	// Skip reparse if same reference as last call
	if (overrides === lastOverrideInput) return [];
	lastOverrideInput = overrides;

	if (!overrides) {
		capabilityOverrides = {};
		return [];
	}
	const parsed: Record<string, Partial<ProviderCapabilities>> = {};
	const warnings: string[] = [];
	for (const [api, values] of Object.entries(overrides)) {
		if (typeof values === "object" && values !== null) {
			parsed[api] = values as Partial<ProviderCapabilities>;
			// Warn if key doesn't match any known canonical or alias API
			if (!PROVIDER_CAPABILITIES[api] && !API_VARIANT_ALIASES[api]) {
				const knownApis = [
					...Object.keys(PROVIDER_CAPABILITIES),
					...Object.keys(API_VARIANT_ALIASES),
				].join(", ");
				warnings.push(
					`provider_capabilities key "${api}" does not match any known provider API. ` +
					`Known APIs: ${knownApis}. The override will apply only if a model uses this exact API string.`,
				);
			}
		}
	}
	capabilityOverrides = parsed;
	return warnings;
}

/**
 * Clear all provider capability overrides. Used for testing.
 */
export function clearProviderCapabilityOverrides(): void {
	capabilityOverrides = {};
	lastOverrideInput = null;
}

/**
 * Returns provider capabilities for the given API string.
 *
 * Looks up the canonical API name first, then checks variant aliases.
 * Returns PERMISSIVE_CAPABILITIES for unknown APIs (fail-open).
 * User overrides from preferences are deep-merged on top of built-in values.
 *
 * @param api - The API protocol string (e.g., "anthropic-messages", NOT "anthropic")
 */
export function getProviderCapabilities(api: Api): ProviderCapabilities {
	// Resolve base capabilities: canonical → alias → permissive default
	let base: ProviderCapabilities;
	const direct = PROVIDER_CAPABILITIES[api];
	if (direct) {
		base = direct;
	} else {
		const canonical = API_VARIANT_ALIASES[api];
		if (canonical) {
			base = PROVIDER_CAPABILITIES[canonical] ?? PERMISSIVE_CAPABILITIES;
		} else {
			base = PERMISSIVE_CAPABILITIES;
		}
	}

	// Apply user overrides if present for this API
	const override = capabilityOverrides[api];
	if (!override) return base;

	// Deep-merge: nested objects (toolCallIdFormat) are merged, not replaced.
	// RegExp fields from YAML arrive as strings — convert them.
	const merged = { ...base, ...override };
	if (override.toolCallIdFormat) {
		merged.toolCallIdFormat = {
			...base.toolCallIdFormat,
			...(override.toolCallIdFormat as Record<string, unknown>),
		};
		// Convert string allowedChars to RegExp (YAML/JSON can't represent RegExp)
		const chars = merged.toolCallIdFormat.allowedChars;
		if (typeof chars === "string") {
			merged.toolCallIdFormat.allowedChars = new RegExp(chars);
		}
	}
	return merged as ProviderCapabilities;
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
