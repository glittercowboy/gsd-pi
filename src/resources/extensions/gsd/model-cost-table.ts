// GSD Extension — Model Cost Table
// Static cost reference for known models, used by the dynamic router
// for cross-provider cost comparison.
//
// Costs are approximate per-1K-token rates in USD (input tokens).
// Updated with GSD releases. Users can override via preferences.

export interface ModelCostEntry {
  /** Model ID (bare, without provider prefix) */
  id: string;
  /** Approximate cost per 1K input tokens in USD */
  inputPer1k: number;
  /** Approximate cost per 1K output tokens in USD */
  outputPer1k: number;
  /** Last updated date */
  updatedAt: string;
}

/**
 * Bundled cost table for known models.
 * Updated periodically with GSD releases.
 */
export const BUNDLED_COST_TABLE: ModelCostEntry[] = [
  // Anthropic
  { id: "claude-opus-4-6", inputPer1k: 0.005, outputPer1k: 0.025, updatedAt: "2026-04-16" },
  { id: "claude-opus-4-7", inputPer1k: 0.005, outputPer1k: 0.025, updatedAt: "2026-04-16" },
  { id: "claude-sonnet-4-6", inputPer1k: 0.003, outputPer1k: 0.015, updatedAt: "2025-03-15" },
  { id: "claude-haiku-4-5", inputPer1k: 0.0008, outputPer1k: 0.004, updatedAt: "2025-03-15" },
  { id: "claude-sonnet-4-5-20250514", inputPer1k: 0.003, outputPer1k: 0.015, updatedAt: "2025-03-15" },
  { id: "claude-3-5-sonnet-latest", inputPer1k: 0.003, outputPer1k: 0.015, updatedAt: "2025-03-15" },
  { id: "claude-3-5-haiku-latest", inputPer1k: 0.0008, outputPer1k: 0.004, updatedAt: "2025-03-15" },
  { id: "claude-3-opus-latest", inputPer1k: 0.015, outputPer1k: 0.075, updatedAt: "2025-03-15" },

  // OpenAI
  { id: "gpt-4o", inputPer1k: 0.0025, outputPer1k: 0.01, updatedAt: "2025-03-15" },
  { id: "gpt-4o-mini", inputPer1k: 0.00015, outputPer1k: 0.0006, updatedAt: "2025-03-15" },
  { id: "gpt-4.1", inputPer1k: 0.002, outputPer1k: 0.008, updatedAt: "2026-03-29" },
  { id: "gpt-4.1-mini", inputPer1k: 0.0004, outputPer1k: 0.0016, updatedAt: "2026-03-29" },
  { id: "gpt-4.1-nano", inputPer1k: 0.0001, outputPer1k: 0.0004, updatedAt: "2026-03-29" },
  { id: "gpt-5", inputPer1k: 0.01, outputPer1k: 0.04, updatedAt: "2026-03-29" },
  { id: "gpt-5-mini", inputPer1k: 0.0003, outputPer1k: 0.0012, updatedAt: "2026-03-29" },
  { id: "gpt-5-nano", inputPer1k: 0.0001, outputPer1k: 0.0004, updatedAt: "2026-03-29" },
  { id: "gpt-5-pro", inputPer1k: 0.015, outputPer1k: 0.06, updatedAt: "2026-03-29" },
  { id: "o1", inputPer1k: 0.015, outputPer1k: 0.06, updatedAt: "2025-03-15" },
  { id: "o3", inputPer1k: 0.015, outputPer1k: 0.06, updatedAt: "2025-03-15" },
  { id: "o4-mini", inputPer1k: 0.005, outputPer1k: 0.02, updatedAt: "2026-03-29" },
  { id: "o4-mini-deep-research", inputPer1k: 0.005, outputPer1k: 0.02, updatedAt: "2026-03-29" },
  { id: "gpt-4-turbo", inputPer1k: 0.01, outputPer1k: 0.03, updatedAt: "2025-03-15" },

  // OpenAI Codex
  { id: "gpt-5.1", inputPer1k: 0.005, outputPer1k: 0.02, updatedAt: "2026-03-29" },
  { id: "gpt-5.1-codex-max", inputPer1k: 0.003, outputPer1k: 0.012, updatedAt: "2026-03-29" },
  { id: "gpt-5.1-codex-mini", inputPer1k: 0.0003, outputPer1k: 0.0012, updatedAt: "2026-03-29" },
  { id: "gpt-5.2", inputPer1k: 0.005, outputPer1k: 0.02, updatedAt: "2026-03-29" },
  { id: "gpt-5.2-codex", inputPer1k: 0.005, outputPer1k: 0.02, updatedAt: "2026-03-29" },
  { id: "gpt-5.3-codex", inputPer1k: 0.005, outputPer1k: 0.02, updatedAt: "2026-03-29" },
  { id: "gpt-5.3-codex-spark", inputPer1k: 0.0003, outputPer1k: 0.0012, updatedAt: "2026-03-29" },
  { id: "gpt-5.4", inputPer1k: 0.005, outputPer1k: 0.02, updatedAt: "2026-03-29" },
  { id: "gpt-5.4-mini", inputPer1k: 0.00075, outputPer1k: 0.0045, updatedAt: "2026-04-18" },
  // GPT-5.5 API list price, also used for live Codex OAuth routing.
  // Source: https://openai.com/api/pricing/
  { id: "gpt-5.5", inputPer1k: 0.005, outputPer1k: 0.03, updatedAt: "2026-04-23" },

  // Google
  { id: "gemini-2.0-flash", inputPer1k: 0.0001, outputPer1k: 0.0004, updatedAt: "2025-03-15" },
  { id: "gemini-flash-2.0", inputPer1k: 0.0001, outputPer1k: 0.0004, updatedAt: "2025-03-15" },
  { id: "gemini-2.5-pro", inputPer1k: 0.00125, outputPer1k: 0.005, updatedAt: "2025-03-15" },

  // DeepSeek
  { id: "deepseek-chat", inputPer1k: 0.00014, outputPer1k: 0.00028, updatedAt: "2025-03-15" },
];

/**
 * Lookup cost for a model ID. Returns undefined if not found.
 */
export function lookupModelCost(modelId: string): ModelCostEntry | undefined {
  const bareId = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
  return BUNDLED_COST_TABLE.find(e => e.id === bareId)
    ?? BUNDLED_COST_TABLE.find(e => bareId.includes(e.id) || e.id.includes(bareId));
}

/**
 * Compare two models by input cost. Returns negative if a is cheaper.
 */
export function compareModelCost(modelIdA: string, modelIdB: string): number {
  const costA = lookupModelCost(modelIdA)?.inputPer1k ?? 999;
  const costB = lookupModelCost(modelIdB)?.inputPer1k ?? 999;
  return costA - costB;
}
