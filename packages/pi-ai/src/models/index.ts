import { MODELS } from "./generated/index.js";
import { CUSTOM_MODELS } from "./custom.js";
import { CAPABILITY_PATCHES, applyCapabilityPatches } from "./capability-patches.js";
import type { Api, KnownProvider, Model, Usage } from "../types.js";

const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();

// Initialize registry from auto-generated MODELS (models.dev catalog)
for (const [provider, models] of Object.entries(MODELS)) {
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as Model<Api>);
	}
	modelRegistry.set(provider, providerModels);
}

// Merge manually-maintained custom providers that are NOT in models.dev.
// Custom models are additive — they never overwrite generated entries.
// See: https://github.com/gsd-build/gsd-2/issues/2339
for (const [provider, models] of Object.entries(CUSTOM_MODELS)) {
	if (!modelRegistry.has(provider)) {
		modelRegistry.set(provider, new Map<string, Model<Api>>());
	}
	const providerModels = modelRegistry.get(provider)!;
	for (const [id, model] of Object.entries(models)) {
		if (!providerModels.has(id)) {
			providerModels.set(id, model as Model<Api>);
		}
	}
}

// Apply patches to the static registry at module load
for (const [, providerModels] of modelRegistry) {
	for (const [id, model] of providerModels) {
		for (const patch of CAPABILITY_PATCHES) {
			if (patch.match(model)) {
				providerModels.set(id, {
					...model,
					capabilities: { ...patch.caps, ...model.capabilities },
				});
				break;
			}
		}
	}
}

/** Providers that have entries in the generated MODELS constant */
type GeneratedProvider = keyof typeof MODELS & KnownProvider;

type ModelApi<
	TProvider extends GeneratedProvider,
	TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

export function getModel<TProvider extends GeneratedProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>> {
	const providerModels = modelRegistry.get(provider);
	return providerModels?.get(modelId as string) as Model<ModelApi<TProvider, TModelId>>;
}

export function getProviders(): KnownProvider[] {
	return Array.from(modelRegistry.keys()) as KnownProvider[];
}

export function getModels<TProvider extends KnownProvider>(
	provider: TProvider,
): Model<Api>[] {
	const models = modelRegistry.get(provider);
	return models ? (Array.from(models.values()) as Model<Api>[]) : [];
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	usage.cost.input = (model.cost.input / 1000000) * usage.input;
	usage.cost.output = (model.cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

/**
 * Check if a model supports xhigh thinking level.
 *
 * Reads from `model.capabilities.supportsXhigh` — set via CAPABILITY_PATCHES
 * for generated models or declared directly in custom model definitions.
 * Do not add model-ID or provider-name checks here; update CAPABILITY_PATCHES instead.
 */
export function supportsXhigh<TApi extends Api>(model: Model<TApi>): boolean {
	return model.capabilities?.supportsXhigh ?? false;
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}

export { MODELS, applyCapabilityPatches };
