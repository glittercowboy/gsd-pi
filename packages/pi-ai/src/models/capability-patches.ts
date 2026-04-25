import type { Api, Model, ModelCapabilities } from "../types.js";

type CapabilityPatch = { match: (m: Model<Api>) => boolean; caps: ModelCapabilities };

export const CAPABILITY_PATCHES: CapabilityPatch[] = [
	// GPT-5.x supports xhigh thinking and OpenAI service tiers
	{
		match: (m) => m.id.includes("gpt-5.2") || m.id.includes("gpt-5.3") || m.id.includes("gpt-5.4"),
		caps: { supportsXhigh: true, supportsServiceTier: true },
	},
	// Anthropic Opus 4.6+ supports xhigh thinking
	{
		match: (m) => m.api === "anthropic-messages" && (
			m.id.includes("opus-4-6") || m.id.includes("opus-4.6") ||
			m.id.includes("opus-4-7") || m.id.includes("opus-4.7")
		),
		caps: { supportsXhigh: true },
	},
];

/**
 * Apply capability patches to a list of models.
 *
 * Models constructed outside the static pi-ai registry (custom models from
 * models.json, extension-registered models, discovered models) do not pass
 * through the module-init patch loop. Call this function after assembling
 * any model list to ensure capabilities are set correctly.
 *
 * Explicit `capabilities` already set on a model take precedence over patches.
 */
export function applyCapabilityPatches(models: Model<Api>[]): Model<Api>[] {
	return models.map((model) => {
		for (const patch of CAPABILITY_PATCHES) {
			if (patch.match(model)) {
				return {
					...model,
					capabilities: { ...patch.caps, ...model.capabilities },
				};
			}
		}
		return model;
	});
}
