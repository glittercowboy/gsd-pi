// GSD-2 — Provider Capabilities Registry (ADR-005 Phase 1)
// Declarative registry of what each API provider supports, consolidating
// scattered knowledge from *-shared.ts files into a queryable data structure.

import type { Api } from "../types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Declarative capability profile for an API provider.
 * Used by the model router to filter incompatible models and by the tool
 * system to adjust tool sets per provider.
 */
export interface ProviderCapabilities {
  /** Whether models from this provider support tool/function calling */
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

// ─── Registry ───────────────────────────────────────────────────────────────

/**
 * Built-in provider capability profiles.
 *
 * Sources (consolidated from scattered *-shared.ts files):
 * - anthropic-shared.ts: normalizeToolCallId (64-char, [a-zA-Z0-9_-])
 * - openai-responses-shared.ts: ID normalization (64-char, fc_ prefix), image-in-tool-result workaround
 * - google-shared.ts: sanitizeSchemaForGoogle (patternProperties, const), requiresToolCallId
 * - mistral.ts: MISTRAL_TOOL_CALL_ID_LENGTH = 9
 * - amazon-bedrock.ts: normalizeToolCallId (64-char, [a-zA-Z0-9_-])
 */
export const PROVIDER_CAPABILITIES: Record<string, ProviderCapabilities> = {
  "anthropic-messages": {
    toolCalling: true,
    maxTools: 0,
    imageToolResults: true,
    structuredOutput: true,
    toolCallIdFormat: { maxLength: 64, allowedChars: /^[a-zA-Z0-9_-]+$/ },
    thinkingPersistence: "full",
    unsupportedSchemaFeatures: [],
  },
  "anthropic-vertex": {
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
    imageToolResults: false,  // images sent as separate user message, not in tool result
    structuredOutput: true,
    toolCallIdFormat: { maxLength: 512, allowedChars: /^.+$/ },
    thinkingPersistence: "text-only",
    unsupportedSchemaFeatures: [],
  },
  "azure-openai-responses": {
    toolCalling: true,
    maxTools: 0,
    imageToolResults: false,
    structuredOutput: true,
    toolCallIdFormat: { maxLength: 512, allowedChars: /^.+$/ },
    thinkingPersistence: "text-only",
    unsupportedSchemaFeatures: [],
  },
  "openai-codex-responses": {
    toolCalling: true,
    maxTools: 0,
    imageToolResults: false,
    structuredOutput: true,
    toolCallIdFormat: { maxLength: 64, allowedChars: /^[a-zA-Z0-9_-]+$/ },
    thinkingPersistence: "text-only",
    unsupportedSchemaFeatures: [],
  },
  "openai-completions": {
    toolCalling: true,
    maxTools: 0,
    imageToolResults: false,
    structuredOutput: true,
    toolCallIdFormat: { maxLength: 64, allowedChars: /^[a-zA-Z0-9_-]+$/ },
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
    unsupportedSchemaFeatures: ["patternProperties", "const"],
  },
  "google-gemini-cli": {
    toolCalling: true,
    maxTools: 0,
    imageToolResults: true,
    structuredOutput: true,
    toolCallIdFormat: { maxLength: 64, allowedChars: /^[a-zA-Z0-9_-]+$/ },
    thinkingPersistence: "text-only",
    unsupportedSchemaFeatures: ["patternProperties", "const"],
  },
  "google-vertex": {
    toolCalling: true,
    maxTools: 0,
    imageToolResults: true,
    structuredOutput: true,
    toolCallIdFormat: { maxLength: 64, allowedChars: /^[a-zA-Z0-9_-]+$/ },
    thinkingPersistence: "text-only",
    unsupportedSchemaFeatures: ["patternProperties", "const"],
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
    imageToolResults: true,  // Bedrock supports image content blocks in tool results
    structuredOutput: true,
    toolCallIdFormat: { maxLength: 64, allowedChars: /^[a-zA-Z0-9_-]+$/ },
    thinkingPersistence: "text-only",
    unsupportedSchemaFeatures: [],
  },
  "ollama-chat": {
    toolCalling: true,
    maxTools: 0,
    imageToolResults: false,
    structuredOutput: false,
    toolCallIdFormat: { maxLength: 64, allowedChars: /^[a-zA-Z0-9_-]+$/ },
    thinkingPersistence: "none",
    unsupportedSchemaFeatures: [],
  },
};

// ─── Default (permissive) profile for unknown providers ─────────────────────

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  toolCalling: true,
  maxTools: 0,
  imageToolResults: true,
  structuredOutput: true,
  toolCallIdFormat: { maxLength: 512, allowedChars: /^.+$/ },
  thinkingPersistence: "text-only",
  unsupportedSchemaFeatures: [],
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Get capabilities for a provider API. Returns a permissive default for
 * unknown providers (preserving existing behavior per ADR-005 principle 5).
 */
export function getProviderCapabilities(api: string): ProviderCapabilities {
  return PROVIDER_CAPABILITIES[api] ?? DEFAULT_CAPABILITIES;
}

/**
 * Check if a provider supports all required schema features.
 * Returns the list of unsupported features (empty if all supported).
 */
export function getUnsupportedFeatures(api: string, requiredFeatures: string[]): string[] {
  const caps = getProviderCapabilities(api);
  return requiredFeatures.filter(f => caps.unsupportedSchemaFeatures.includes(f));
}

/**
 * Deep-merge user-provided capability overrides with built-in defaults.
 * Partial overrides merge with the built-in profile for the given API.
 */
export function mergeCapabilityOverrides(
  api: string,
  overrides: Partial<Omit<ProviderCapabilities, "toolCallIdFormat">> & {
    toolCallIdFormat?: Partial<ProviderCapabilities["toolCallIdFormat"]>;
  },
): ProviderCapabilities {
  const base = getProviderCapabilities(api);
  return {
    ...base,
    ...overrides,
    toolCallIdFormat: overrides.toolCallIdFormat
      ? { ...base.toolCallIdFormat, ...overrides.toolCallIdFormat }
      : base.toolCallIdFormat,
  };
}

/**
 * Get all registered API names in the capability registry.
 * Used by lint rules to verify all providers in register-builtins.ts
 * have corresponding capability entries.
 */
export function getRegisteredApis(): string[] {
  return Object.keys(PROVIDER_CAPABILITIES);
}
