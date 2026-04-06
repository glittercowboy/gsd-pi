// GSD2 — Ollama model discovery and capability detection

/**
 * Discovers locally available Ollama models and enriches them with
 * capability metadata (context window, vision, reasoning) from the
 * known model table and /api/show responses.
 *
 * Returns models in the format expected by pi.registerProvider().
 */

import { listModels } from "./ollama-client.js";
import {
	estimateContextFromParams,
	formatModelSize,
	getModelCapabilities,
	humanizeModelName,
} from "./model-capabilities.js";
import type { OllamaChatOptions, OllamaModelInfo } from "./types.js";

export interface DiscoveredOllamaModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	/** Raw size in bytes for display purposes */
	sizeBytes: number;
	/** Parameter size string from Ollama (e.g. "7B") */
	parameterSize: string;
	/** Ollama-specific inference options for this model */
	ollamaOptions?: OllamaChatOptions;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function enrichModel(info: OllamaModelInfo): DiscoveredOllamaModel {
	const caps = getModelCapabilities(info.name);
	const parameterSize = info.details?.parameter_size ?? "";

	// Determine context window: known table > estimate from param size > default
	const contextWindow =
		caps.contextWindow ??
		(parameterSize ? estimateContextFromParams(parameterSize) : 8192);

	// Determine max tokens: known table > fraction of context > default
	const maxTokens =
		caps.maxTokens ?? Math.min(Math.floor(contextWindow / 4), 16384);

	// Detect vision from families or known table
	const hasVision =
		caps.input?.includes("image") ??
		(info.details?.families?.some((f) => f === "clip" || f === "mllama") ?? false);

	// Detect reasoning from known table
	const reasoning = caps.reasoning ?? false;

	return {
		id: info.name,
		name: humanizeModelName(info.name),
		reasoning,
		input: hasVision ? ["text", "image"] : ["text"],
		cost: ZERO_COST,
		contextWindow,
		maxTokens,
		sizeBytes: info.size,
		parameterSize,
		ollamaOptions: caps.ollamaOptions,
	};
}

/**
 * Discover all locally available Ollama models with enriched capabilities.
 */
export async function discoverModels(): Promise<DiscoveredOllamaModel[]> {
	const tags = await listModels();
	if (!tags.models || tags.models.length === 0) return [];

	return tags.models.map(enrichModel);
}

/**
 * Format a discovered model for display in model list.
 */
export function formatModelForDisplay(model: DiscoveredOllamaModel): string {
	const parts = [model.id];

	if (model.sizeBytes > 0) {
		parts.push(`(${formatModelSize(model.sizeBytes)})`);
	}

	const flags: string[] = [];
	if (model.reasoning) flags.push("reasoning");
	if (model.input.includes("image")) flags.push("vision");

	if (flags.length > 0) {
		parts.push(`[${flags.join(", ")}]`);
	}

	return parts.join(" ");
}

