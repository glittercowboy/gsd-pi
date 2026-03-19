// Loads compressed model data from models.data.json and expands it into the
// full MODELS object that the rest of the codebase consumes.
//
// The JSON format uses provider-level defaults to avoid repeating fields like
// provider, api, baseUrl, reasoning, input, headers, and compat across every
// model in a provider group. Each model entry stores only fields that differ
// from the provider defaults, plus per-model fields (name, cost, contextWindow,
// maxTokens/maxOutput).

import { createRequire } from "node:module";
import type { Api, Model, Provider } from "./types.js";

/** Shape of a per-model entry in the compressed JSON. */
interface CompressedModel {
	name: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	input?: string[];
	/** [input, output, cacheRead, cacheWrite] */
	cost: [number, number, number, number];
	contextWindow: number;
	maxTokens?: number;
	maxOutput?: number;
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
}

/** Shape of provider defaults in the compressed JSON. */
interface ProviderDefaults {
	provider: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	input?: string[];
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
}

interface CompressedData {
	providers: Record<string, ProviderDefaults>;
	models: Record<string, Record<string, CompressedModel>>;
}

type ExpandedModel = Model<Api> & { maxOutput?: number };

function expandModels(
	data: CompressedData,
): Record<string, Record<string, ExpandedModel>> {
	const result: Record<string, Record<string, ExpandedModel>> = {};

	for (const [providerKey, models] of Object.entries(data.models)) {
		const defaults = data.providers[providerKey];
		const expanded: Record<string, ExpandedModel> = {};

		for (const [modelId, entry] of Object.entries(models)) {
			const model = {
				id: modelId,
				name: entry.name,
				api: (entry.api ?? defaults.api) as Api,
				provider: defaults.provider as Provider,
				baseUrl: (entry.baseUrl ?? defaults.baseUrl) as string,
				reasoning:
					entry.reasoning !== undefined
						? entry.reasoning
						: (defaults.reasoning as boolean),
				input: (entry.input ?? defaults.input) as ("text" | "image")[],
				cost: {
					input: entry.cost[0],
					output: entry.cost[1],
					cacheRead: entry.cost[2],
					cacheWrite: entry.cost[3],
				},
				contextWindow: entry.contextWindow,
			} as ExpandedModel;

			// Each model has exactly one of maxTokens or maxOutput
			if (entry.maxTokens !== undefined) {
				model.maxTokens = entry.maxTokens;
			}
			if (entry.maxOutput !== undefined) {
				model.maxOutput = entry.maxOutput;
			}

			// headers: per-model override or provider default
			const headers = entry.headers ?? defaults.headers;
			if (headers) {
				model.headers = headers;
			}

			// compat: per-model override or provider default
			const compat = entry.compat ?? defaults.compat;
			if (compat) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(model as any).compat = compat;
			}

			expanded[modelId] = model;
		}

		result[providerKey] = expanded;
	}

	return result;
}

// Load JSON via createRequire since ESM with module:"Node16" doesn't support
// import attributes for JSON files.
const _require = createRequire(import.meta.url);
const compressedData: CompressedData = _require("./models.data.json");

export const MODELS = expandModels(compressedData);
