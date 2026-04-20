import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@gsd/pi-ai";
import type { ModelRegistry } from "./model-registry.js";
import { findInitialModel } from "./model-resolver.js";

function makeModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
    provider,
    api: "openai-responses",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  } as Model<Api>;
}

function makeRegistry(opts: {
  readyProviders?: Set<string>;
  byProviderAndId?: Map<string, Model<Api>>;
  available?: Model<Api>[];
}): ModelRegistry {
  const readyProviders = opts.readyProviders ?? new Set<string>();
  const byProviderAndId = opts.byProviderAndId ?? new Map<string, Model<Api>>();
  const available = opts.available ?? [];

  return {
    find: (provider: string, modelId: string) => byProviderAndId.get(`${provider}/${modelId}`),
    getAvailable: async () => available,
    isProviderRequestReady: (provider: string) => readyProviders.has(provider),
  } as unknown as ModelRegistry;
}

describe("findInitialModel auth gating for saved defaults", () => {
  it("uses saved default when provider is request-ready", async () => {
    const saved = makeModel("anthropic", "claude-opus-4-6");
    const registry = makeRegistry({
      readyProviders: new Set(["anthropic"]),
      byProviderAndId: new Map([[`anthropic/claude-opus-4-6`, saved]]),
      available: [saved],
    });

    const result = await findInitialModel({
      scopedModels: [],
      isContinuing: false,
      defaultProvider: "anthropic",
      defaultModelId: "claude-opus-4-6",
      modelRegistry: registry,
    });

    assert.equal(result.model?.provider, "anthropic");
    assert.equal(result.model?.id, "claude-opus-4-6");
  });

  it("skips saved default when provider is not request-ready and falls back to available", async () => {
    const staleDefault = makeModel("anthropic", "claude-opus-4-6");
    const fallback = makeModel("openai", "gpt-5.4");
    const registry = makeRegistry({
      readyProviders: new Set(["openai"]),
      byProviderAndId: new Map([[`anthropic/claude-opus-4-6`, staleDefault]]),
      available: [fallback],
    });

    const result = await findInitialModel({
      scopedModels: [],
      isContinuing: false,
      defaultProvider: "anthropic",
      defaultModelId: "claude-opus-4-6",
      modelRegistry: registry,
    });

    assert.equal(result.model?.provider, "openai");
    assert.equal(result.model?.id, "gpt-5.4");
  });
});
