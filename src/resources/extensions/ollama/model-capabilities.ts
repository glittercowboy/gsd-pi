// GSD2 — Known model capability table for Ollama models

/**
 * Maps well-known Ollama model families to their capabilities.
 * Used to enrich auto-discovered models with accurate context windows,
 * vision support, and reasoning detection.
 *
 * Fallback: estimate from parameter count if model isn't in the table.
 */

import type { OllamaChatOptions } from "./types.js";

export interface ModelCapability {
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
	reasoning?: boolean;
	/** Ollama-specific default inference options for this model family. */
	ollamaOptions?: OllamaChatOptions;
}

/**
 * Known model family capabilities.
 * Keys are matched as prefixes against the model name (before the colon/tag).
 * More specific entries should appear first.
 */
// Note: ollamaOptions.num_ctx is set for known model families where the context
// window is authoritative. For unknown/estimated models, num_ctx is NOT sent
// to avoid OOM risk — Ollama uses its own safe default instead.
const KNOWN_MODELS: Array<[pattern: string, caps: ModelCapability]> = [
	// ─── Reasoning models ───────────────────────────────────────────────
	["deepseek-r1", { contextWindow: 131072, reasoning: true, ollamaOptions: { num_ctx: 131072 } }],
	["qwq", { contextWindow: 131072, reasoning: true, ollamaOptions: { num_ctx: 131072 } }],

	// ─── Vision models ──────────────────────────────────────────────────
	["llava", { contextWindow: 4096, input: ["text", "image"], ollamaOptions: { num_ctx: 4096 } }],
	["bakllava", { contextWindow: 4096, input: ["text", "image"], ollamaOptions: { num_ctx: 4096 } }],
	["moondream", { contextWindow: 8192, input: ["text", "image"], ollamaOptions: { num_ctx: 8192 } }],
	["llama3.2-vision", { contextWindow: 131072, input: ["text", "image"], ollamaOptions: { num_ctx: 131072 } }],
	["minicpm-v", { contextWindow: 4096, input: ["text", "image"], ollamaOptions: { num_ctx: 4096 } }],

	// ─── Code models ────────────────────────────────────────────────────
	["codestral", { contextWindow: 262144, maxTokens: 32768, ollamaOptions: { num_ctx: 262144 } }],
	["qwen2.5-coder", { contextWindow: 131072, maxTokens: 32768, ollamaOptions: { num_ctx: 131072 } }],
	["deepseek-coder-v2", { contextWindow: 131072, maxTokens: 16384, ollamaOptions: { num_ctx: 131072 } }],
	["starcoder2", { contextWindow: 16384, maxTokens: 8192, ollamaOptions: { num_ctx: 16384 } }],
	["codegemma", { contextWindow: 8192, maxTokens: 8192, ollamaOptions: { num_ctx: 8192 } }],
	["codellama", { contextWindow: 16384, maxTokens: 8192, ollamaOptions: { num_ctx: 16384 } }],
	["devstral", { contextWindow: 131072, maxTokens: 32768, ollamaOptions: { num_ctx: 131072 } }],

	// ─── Llama family ───────────────────────────────────────────────────
	["llama3.3", { contextWindow: 131072, maxTokens: 16384, ollamaOptions: { num_ctx: 131072 } }],
	["llama3.2", { contextWindow: 131072, maxTokens: 16384, ollamaOptions: { num_ctx: 131072 } }],
	["llama3.1", { contextWindow: 131072, maxTokens: 16384, ollamaOptions: { num_ctx: 131072 } }],
	["llama3", { contextWindow: 8192, maxTokens: 8192, ollamaOptions: { num_ctx: 8192 } }],
	["llama2", { contextWindow: 4096, maxTokens: 4096, ollamaOptions: { num_ctx: 4096 } }],

	// ─── Qwen family ────────────────────────────────────────────────────
	["qwen3", { contextWindow: 131072, maxTokens: 32768, ollamaOptions: { num_ctx: 131072 } }],
	["qwen2.5", { contextWindow: 131072, maxTokens: 32768, ollamaOptions: { num_ctx: 131072 } }],
	["qwen2", { contextWindow: 131072, maxTokens: 32768, ollamaOptions: { num_ctx: 131072 } }],

	// ─── Gemma family ───────────────────────────────────────────────────
	["gemma3", { contextWindow: 131072, maxTokens: 16384, ollamaOptions: { num_ctx: 131072 } }],
	["gemma2", { contextWindow: 8192, maxTokens: 8192, ollamaOptions: { num_ctx: 8192 } }],

	// ─── Mistral family ─────────────────────────────────────────────────
	["mistral-large", { contextWindow: 131072, maxTokens: 16384, ollamaOptions: { num_ctx: 131072 } }],
	["mistral-small", { contextWindow: 131072, maxTokens: 16384, ollamaOptions: { num_ctx: 131072 } }],
	["mistral-nemo", { contextWindow: 131072, maxTokens: 16384, ollamaOptions: { num_ctx: 131072 } }],
	["mistral", { contextWindow: 32768, maxTokens: 8192, ollamaOptions: { num_ctx: 32768 } }],
	["mixtral", { contextWindow: 32768, maxTokens: 8192, ollamaOptions: { num_ctx: 32768 } }],

	// ─── Phi family ─────────────────────────────────────────────────────
	["phi4", { contextWindow: 16384, maxTokens: 16384, ollamaOptions: { num_ctx: 16384 } }],
	["phi3.5", { contextWindow: 131072, maxTokens: 16384, ollamaOptions: { num_ctx: 131072 } }],
	["phi3", { contextWindow: 131072, maxTokens: 4096, ollamaOptions: { num_ctx: 131072 } }],

	// ─── Command R ──────────────────────────────────────────────────────
	["command-r-plus", { contextWindow: 131072, maxTokens: 16384, ollamaOptions: { num_ctx: 131072 } }],
	["command-r", { contextWindow: 131072, maxTokens: 16384, ollamaOptions: { num_ctx: 131072 } }],
];

/**
 * Look up capabilities for a model by name.
 * Matches the longest prefix from the known models table.
 */
export function getModelCapabilities(modelName: string): ModelCapability {
	// Strip tag (everything after the colon) for matching
	const baseName = modelName.split(":")[0].toLowerCase();

	for (const [pattern, caps] of KNOWN_MODELS) {
		if (baseName === pattern || baseName.startsWith(pattern)) {
			return caps;
		}
	}

	return {};
}

/**
 * Estimate context window from parameter size string (e.g. "7B", "70B", "1.5B").
 * Used as fallback when model isn't in the known table.
 */
export function estimateContextFromParams(parameterSize: string): number {
	const match = parameterSize.match(/([\d.]+)\s*([BbMm])/);
	if (!match) return 8192;

	const size = parseFloat(match[1]);
	const unit = match[2].toUpperCase();

	// Convert to billions
	const billions = unit === "M" ? size / 1000 : size;

	// Rough heuristics: larger models tend to support larger contexts
	if (billions >= 70) return 131072;
	if (billions >= 30) return 65536;
	if (billions >= 13) return 32768;
	if (billions >= 7) return 16384;
	return 8192;
}

/**
 * Humanize a model name for display (e.g. "llama3.1:8b" → "Llama 3.1 8B").
 */
export function humanizeModelName(modelName: string): string {
	const [base, tag] = modelName.split(":");

	// Capitalize first letter, add spaces around version numbers
	let name = base
		.replace(/([a-z])(\d)/g, "$1 $2")
		.replace(/(\d)([a-z])/g, "$1 $2")
		.replace(/^./, (c) => c.toUpperCase());

	// Clean up common patterns
	name = name.replace(/\s*-\s*/g, " ");

	if (tag && tag !== "latest") {
		name += ` ${tag.toUpperCase()}`;
	}

	return name;
}

/**
 * Format byte size for display (e.g. 4700000000 → "4.7 GB").
 */
export function formatModelSize(bytes: number): string {
	if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
	if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
	return `${(bytes / 1e3).toFixed(0)} KB`;
}
