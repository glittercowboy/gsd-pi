import type { Model, Api, Provider } from "./types.js";
import { ModelsDevData, ModelsDevProvider, ModelsDevModel } from "./models-dev-types.js";

/**
 * Mapper that transforms models.dev API response into gsd-2's Model<Api>[] format.
 */

/**
 * Infer the API type from provider ID or model options.
 * Falls back to "openai-completions" as the default.
 */
function inferApiType(providerId: string, modelData: ModelsDevModel): Api {
  // Check if provider has explicit api field
  if (providerId.includes("anthropic")) {
    return "anthropic-messages";
  }
  if (providerId.includes("google") || providerId.includes("vertex")) {
    return "google-generative-ai";
  }
  if (providerId.includes("bedrock")) {
    return "bedrock-converse-stream";
  }
  if (providerId.includes("mistral")) {
    return "mistral-conversations";
  }
  if (providerId.includes("azure")) {
    return "azure-openai-responses";
  }
  if (providerId.includes("codex")) {
    return "openai-codex-responses";
  }

  // Default to OpenAI-compatible completions API
  return "openai-completions";
}

/**
 * Filter modalities to only "text" and "image" inputs.
 * Returns array of supported input types.
 */
function filterInputModalities(modalities?: ModelsDevModel["modalities"]): ("text" | "image")[] {
  if (!modalities?.input) {
    // Default to text-only if no modalities specified
    return ["text"];
  }

  const supported: ("text" | "image")[] = [];
  if (modalities.input.includes("text")) {
    supported.push("text");
  }
  if (modalities.input.includes("image")) {
    supported.push("image");
  }

  // Ensure at least text is supported
  return supported.length > 0 ? supported : ["text"];
}

/**
 * Map a single models.dev model to gsd-2 Model format.
 */
function mapModel(providerId: string, modelId: string, modelData: ModelsDevModel, providerData: ModelsDevProvider): Model<Api> {
  // Extract cost values with defaults
  const cost = modelData.cost ?? {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
  };

  // Extract limit values
  const limit = modelData.limit;

  return {
    id: modelId,
    name: modelData.name,
    api: inferApiType(providerId, modelData),
    provider: providerId,
    baseUrl: providerData.api ?? "",
    reasoning: modelData.reasoning,
    input: filterInputModalities(modelData.modalities),
    cost: {
      input: cost.input ?? 0,
      output: cost.output ?? 0,
      cacheRead: cost.cache_read ?? 0,
      cacheWrite: cost.cache_write ?? 0,
    },
    contextWindow: limit.context,
    maxTokens: limit.output,
    headers: {},
  };
}

/**
 * Transform models.dev API response into gsd-2 Model<Api>[] registry format.
 * 
 * @param data - Parsed models.dev API response (Record<string, Provider>)
 * @returns Array of Model<Api> objects in gsd-2 format
 */
export function mapToModelRegistry(data: ModelsDevData): Model<Api>[] {
  const models: Model<Api>[] = [];

  for (const [providerId, providerData] of Object.entries(data)) {
    // Validate provider data structure
    const parsedProvider = ModelsDevProvider.safeParse(providerData);
    if (!parsedProvider.success) {
      // Skip invalid providers but log warning in real implementation
      continue;
    }

    const provider = parsedProvider.data;

    // Map each model within the provider
    for (const [modelId, modelData] of Object.entries(provider.models)) {
      // Validate model data structure
      const parsedModel = ModelsDevModel.safeParse(modelData);
      if (!parsedModel.success) {
        // Skip invalid models but continue processing
        continue;
      }

      const model = mapModel(providerId, modelId, parsedModel.data, provider);
      models.push(model);
    }
  }

  return models;
}

/**
 * Validate and parse models.dev API response.
 * Returns parsed data or null if validation fails.
 */
export function parseModelsDevData(rawData: unknown): ModelsDevData | null {
  const result = ModelsDevData.safeParse(rawData);
  if (!result.success) {
    return null;
  }
  return result.data;
}
