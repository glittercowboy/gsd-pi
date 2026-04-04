// GSD Extension — Dynamic Model Router
// Maps complexity tiers to models, enforcing downgrade-only semantics.
// The user's configured model is always the ceiling.

import type { ComplexityTier, ClassificationResult } from "./complexity-classifier.js";
import { tierOrdinal } from "./complexity-classifier.js";
import type { ResolvedModelConfig } from "./preferences.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DynamicRoutingConfig {
  enabled?: boolean;
  capability_routing?: boolean;    // default: false — enable capability profile scoring
  tier_models?: {
    light?: string;
    standard?: string;
    heavy?: string;
  };
  escalate_on_failure?: boolean;   // default: true
  budget_pressure?: boolean;       // default: true
  cross_provider?: boolean;        // default: true
  hooks?: boolean;                 // default: true
}

export interface RoutingDecision {
  /** The model ID to use (may be downgraded from configured) */
  modelId: string;
  /** Fallback chain: [selected_model, ...configured_fallbacks, configured_primary] */
  fallbacks: string[];
  /** The complexity tier that drove this decision */
  tier: ComplexityTier;
  /** True if the model was downgraded from the configured primary */
  wasDowngraded: boolean;
  /** Human-readable reason for this decision */
  reason: string;
  /** How the model was selected. */
  selectionMethod?: "tier-only" | "capability-scored";
  /** Capability scores per model (when capability-scored). */
  capabilityScores?: Record<string, number>;
  /** Task requirement vector (when capability-scored). */
  taskRequirements?: Partial<Record<string, number>>;
}

// ─── Known Model Tiers ───────────────────────────────────────────────────────
// Maps known model IDs to their capability tier. Used when tier_models is not
// explicitly configured to pick the best available model for each tier.

const MODEL_CAPABILITY_TIER: Record<string, ComplexityTier> = {
  // Light-tier models (cheapest)
  "claude-haiku-4-5": "light",
  "claude-3-5-haiku-latest": "light",
  "claude-3-haiku-20240307": "light",
  "gpt-4o-mini": "light",
  "gpt-4.1-mini": "light",
  "gpt-4.1-nano": "light",
  "gpt-5-mini": "light",
  "gpt-5-nano": "light",
  "gpt-5.1-codex-mini": "light",
  "gpt-5.3-codex-spark": "light",
  "gemini-2.0-flash": "light",
  "gemini-flash-2.0": "light",

  // Standard-tier models
  "claude-sonnet-4-6": "standard",
  "claude-sonnet-4-5-20250514": "standard",
  "claude-3-5-sonnet-latest": "standard",
  "gpt-4o": "standard",
  "gpt-4.1": "standard",
  "gpt-5.1-codex-max": "standard",
  "gemini-2.5-pro": "standard",
  "deepseek-chat": "standard",

  // Heavy-tier models (most capable)
  "claude-opus-4-6": "heavy",
  "claude-3-opus-latest": "heavy",
  "gpt-4-turbo": "heavy",
  "gpt-5": "heavy",
  "gpt-5-pro": "heavy",
  "gpt-5.1": "heavy",
  "gpt-5.2": "heavy",
  "gpt-5.2-codex": "heavy",
  "gpt-5.3-codex": "heavy",
  "gpt-5.4": "heavy",
  "o1": "heavy",
  "o3": "heavy",
  "o4-mini": "heavy",
  "o4-mini-deep-research": "heavy",
};

// ─── Cost Table (per 1K input tokens, approximate USD) ───────────────────────
// Used for cross-provider cost comparison when multiple providers offer
// the same capability tier.

const MODEL_COST_PER_1K_INPUT: Record<string, number> = {
  "claude-haiku-4-5": 0.0008,
  "claude-3-5-haiku-latest": 0.0008,
  "claude-sonnet-4-6": 0.003,
  "claude-sonnet-4-5-20250514": 0.003,
  "claude-opus-4-6": 0.015,
  "gpt-4o-mini": 0.00015,
  "gpt-4o": 0.0025,
  "gpt-4.1": 0.002,
  "gpt-4.1-mini": 0.0004,
  "gpt-4.1-nano": 0.0001,
  "gpt-5": 0.01,
  "gpt-5-mini": 0.0003,
  "gpt-5-nano": 0.0001,
  "gpt-5-pro": 0.015,
  "gpt-5.1": 0.005,
  "gpt-5.1-codex-max": 0.003,
  "gpt-5.1-codex-mini": 0.0003,
  "gpt-5.2": 0.005,
  "gpt-5.2-codex": 0.005,
  "gpt-5.3-codex": 0.005,
  "gpt-5.3-codex-spark": 0.0003,
  "gpt-5.4": 0.005,
  "o4-mini": 0.005,
  "o4-mini-deep-research": 0.005,
  "gemini-2.0-flash": 0.0001,
  "gemini-2.5-pro": 0.00125,
  "deepseek-chat": 0.00014,
};

// ─── Capability Profiles (ADR-004 Phase 2) ──────────────────────────────────
// 7-dimension profiles, 0–100 normalized. Models without a profile
// score 50 uniformly — capability scoring is a no-op for them.

export interface ModelCapabilities {
  coding: number;
  debugging: number;
  research: number;
  reasoning: number;
  speed: number;
  longContext: number;
  instruction: number;
}

export const MODEL_CAPABILITY_PROFILES: Record<string, ModelCapabilities> = {
  "claude-opus-4-6":     { coding: 95, debugging: 90, research: 85, reasoning: 95, speed: 30, longContext: 80, instruction: 90 },
  "claude-sonnet-4-6":   { coding: 85, debugging: 80, research: 75, reasoning: 80, speed: 60, longContext: 75, instruction: 85 },
  "claude-haiku-4-5":    { coding: 60, debugging: 50, research: 45, reasoning: 50, speed: 95, longContext: 50, instruction: 75 },
  "gpt-4o":              { coding: 80, debugging: 75, research: 70, reasoning: 75, speed: 65, longContext: 70, instruction: 80 },
  "gpt-4o-mini":         { coding: 55, debugging: 45, research: 40, reasoning: 45, speed: 90, longContext: 45, instruction: 70 },
  "gemini-2.5-pro":      { coding: 75, debugging: 70, research: 85, reasoning: 75, speed: 55, longContext: 90, instruction: 75 },
  "gemini-2.0-flash":    { coding: 50, debugging: 40, research: 50, reasoning: 40, speed: 95, longContext: 60, instruction: 65 },
  "deepseek-chat":       { coding: 75, debugging: 65, research: 55, reasoning: 70, speed: 70, longContext: 55, instruction: 65 },
  "o3":                  { coding: 80, debugging: 85, research: 80, reasoning: 92, speed: 25, longContext: 70, instruction: 85 },
};

const BASE_REQUIREMENTS: Record<string, Partial<Record<keyof ModelCapabilities, number>>> = {
  "execute-task":       { coding: 0.9, instruction: 0.7, speed: 0.3 },
  "research-milestone": { research: 0.9, longContext: 0.7, reasoning: 0.5 },
  "research-slice":     { research: 0.9, longContext: 0.7, reasoning: 0.5 },
  "plan-milestone":     { reasoning: 0.9, coding: 0.5 },
  "plan-slice":         { reasoning: 0.9, coding: 0.5 },
  "replan-slice":       { reasoning: 0.9, debugging: 0.6, coding: 0.5 },
  "reassess-roadmap":   { reasoning: 0.9, research: 0.5 },
  "complete-slice":     { instruction: 0.8, speed: 0.7 },
  "run-uat":            { instruction: 0.7, speed: 0.8 },
  "discuss-milestone":  { reasoning: 0.6, instruction: 0.7 },
  "complete-milestone": { instruction: 0.8, reasoning: 0.5 },
};

/**
 * Compute a task requirement vector from unit type and optional metadata.
 */
export function computeTaskRequirements(
  unitType: string,
  metadata?: { tags?: string[]; complexityKeywords?: string[]; fileCount?: number; estimatedLines?: number },
): Partial<Record<keyof ModelCapabilities, number>> {
  const base = { ...(BASE_REQUIREMENTS[unitType] ?? { reasoning: 0.5 }) };

  if (unitType === "execute-task" && metadata) {
    if (metadata.tags?.some(t => /^(docs?|readme|comment|config|typo|rename)$/i.test(t))) {
      return { ...base, instruction: 0.9, coding: 0.3, speed: 0.7 };
    }
    if (metadata.complexityKeywords?.some(k => k === "concurrency" || k === "compatibility")) {
      return { ...base, debugging: 0.9, reasoning: 0.8 };
    }
    if (metadata.complexityKeywords?.some(k => k === "migration" || k === "architecture")) {
      return { ...base, reasoning: 0.9, coding: 0.8 };
    }
    if ((metadata.fileCount ?? 0) >= 6 || (metadata.estimatedLines ?? 0) >= 500) {
      return { ...base, coding: 0.9, reasoning: 0.7 };
    }
  }

  return base;
}

/**
 * Score a model against a task requirement vector.
 * Returns weighted average in range 0–100. Returns 50 for empty requirements.
 */
export function scoreModel(
  capabilities: ModelCapabilities,
  requirements: Partial<Record<keyof ModelCapabilities, number>>,
): number {
  let weightedSum = 0;
  let weightSum = 0;
  for (const [dim, weight] of Object.entries(requirements)) {
    const capability = capabilities[dim as keyof ModelCapabilities] ?? 50;
    weightedSum += weight * capability;
    weightSum += weight;
  }
  return weightSum > 0 ? weightedSum / weightSum : 50;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve the model to use for a given complexity tier.
 *
 * Downgrade-only: the returned model is always equal to or cheaper than
 * the user's configured primary model. Never upgrades beyond configuration.
 *
 * @param classification  The complexity classification result
 * @param phaseConfig     The user's configured model for this phase (ceiling)
 * @param routingConfig   Dynamic routing configuration
 * @param availableModelIds  List of available model IDs (from registry)
 */
export function resolveModelForComplexity(
  classification: ClassificationResult,
  phaseConfig: ResolvedModelConfig | undefined,
  routingConfig: DynamicRoutingConfig,
  availableModelIds: string[],
  unitType?: string,
  metadata?: { tags?: string[]; complexityKeywords?: string[]; fileCount?: number; estimatedLines?: number },
): RoutingDecision {
  // If no phase config or routing disabled, pass through
  if (!phaseConfig || !routingConfig.enabled) {
    return {
      modelId: phaseConfig?.primary ?? "",
      fallbacks: phaseConfig?.fallbacks ?? [],
      tier: classification.tier,
      wasDowngraded: false,
      reason: "dynamic routing disabled or no phase config",
    };
  }

  const configuredPrimary = phaseConfig.primary;
  const configuredTier = getModelTier(configuredPrimary);
  const requestedTier = classification.tier;

  // If the configured model is unknown (not in MODEL_CAPABILITY_TIER),
  // honor the user's explicit choice — don't downgrade based on a guess.
  // Unknown models default to "heavy" in getModelTier, which makes every
  // standard/light unit get downgraded to tier_models, silently ignoring
  // the user's configuration. (#2192)
  if (!isKnownModel(configuredPrimary)) {
    return {
      modelId: configuredPrimary,
      fallbacks: phaseConfig.fallbacks,
      tier: requestedTier,
      wasDowngraded: false,
      reason: `configured model "${configuredPrimary}" is not in the known tier map — honoring explicit config`,
    };
  }

  // Downgrade-only: if requested tier >= configured tier, no change
  if (tierOrdinal(requestedTier) >= tierOrdinal(configuredTier)) {
    return {
      modelId: configuredPrimary,
      fallbacks: phaseConfig.fallbacks,
      tier: requestedTier,
      wasDowngraded: false,
      reason: `tier ${requestedTier} >= configured ${configuredTier}`,
    };
  }

  // Find the best model for the requested tier
  const useCapabilityScoring = routingConfig.capability_routing && unitType;

  let targetModelId: string | null;
  let capabilityScores: Record<string, number> | undefined;
  let taskRequirements: Partial<Record<string, number>> | undefined;
  let selectionMethod: "tier-only" | "capability-scored" = "tier-only";

  if (useCapabilityScoring) {
    const result = findModelForTierWithCapability(
      requestedTier, routingConfig, availableModelIds,
      routingConfig.cross_provider !== false, unitType, metadata,
    );
    targetModelId = result.modelId;
    capabilityScores = Object.keys(result.scores).length > 0 ? result.scores : undefined;
    taskRequirements = Object.keys(result.requirements).length > 0 ? result.requirements : undefined;
    selectionMethod = capabilityScores ? "capability-scored" : "tier-only";
  } else {
    targetModelId = findModelForTier(
      requestedTier, routingConfig, availableModelIds,
      routingConfig.cross_provider !== false,
    );
  }

  if (!targetModelId) {
    return {
      modelId: configuredPrimary,
      fallbacks: phaseConfig.fallbacks,
      tier: requestedTier,
      wasDowngraded: false,
      reason: `no ${requestedTier}-tier model available`,
      selectionMethod,
    };
  }

  const fallbacks = [
    ...phaseConfig.fallbacks.filter(f => f !== targetModelId),
    configuredPrimary,
  ].filter(f => f !== targetModelId);

  return {
    modelId: targetModelId,
    fallbacks,
    tier: requestedTier,
    wasDowngraded: true,
    reason: classification.reason,
    selectionMethod,
    capabilityScores,
    taskRequirements,
  };
}

/**
 * Escalate to the next tier after a failure.
 * Returns the new tier, or null if already at heavy (max).
 */
export function escalateTier(currentTier: ComplexityTier): ComplexityTier | null {
  switch (currentTier) {
    case "light": return "standard";
    case "standard": return "heavy";
    case "heavy": return null;
  }
}

/**
 * Get the default routing config (all features enabled).
 */
export function defaultRoutingConfig(): DynamicRoutingConfig {
  return {
    enabled: true,
    capability_routing: false,
    escalate_on_failure: true,
    budget_pressure: true,
    cross_provider: true,
    hooks: true,
  };
}

// ─── Internal ────────────────────────────────────────────────────────────────

function getModelTier(modelId: string): ComplexityTier {
  // Strip provider prefix if present
  const bareId = modelId.includes("/") ? modelId.split("/").pop()! : modelId;

  // Check exact match first
  if (MODEL_CAPABILITY_TIER[bareId]) return MODEL_CAPABILITY_TIER[bareId];

  // Check if any known model ID is a prefix/suffix match
  for (const [knownId, tier] of Object.entries(MODEL_CAPABILITY_TIER)) {
    if (bareId.includes(knownId) || knownId.includes(bareId)) return tier;
  }

  // Unknown models are assumed heavy (safest assumption)
  return "heavy";
}

/** Check if a model ID has a known capability tier mapping. (#2192) */
function isKnownModel(modelId: string): boolean {
  const bareId = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
  if (MODEL_CAPABILITY_TIER[bareId]) return true;
  for (const knownId of Object.keys(MODEL_CAPABILITY_TIER)) {
    if (bareId.includes(knownId) || knownId.includes(bareId)) return true;
  }
  return false;
}

function findModelForTier(
  tier: ComplexityTier,
  config: DynamicRoutingConfig,
  availableModelIds: string[],
  crossProvider: boolean,
): string | null {
  // 1. Check explicit tier_models config
  const explicitModel = config.tier_models?.[tier];
  if (explicitModel && availableModelIds.includes(explicitModel)) {
    return explicitModel;
  }
  // Also check with provider prefix stripped
  if (explicitModel) {
    const match = availableModelIds.find(id => {
      const bareAvail = id.includes("/") ? id.split("/").pop()! : id;
      const bareExplicit = explicitModel.includes("/") ? explicitModel.split("/").pop()! : explicitModel;
      return bareAvail === bareExplicit;
    });
    if (match) return match;
  }

  // 2. Auto-detect: find the cheapest available model in the requested tier
  const candidates = availableModelIds
    .filter(id => {
      const modelTier = getModelTier(id);
      return modelTier === tier;
    })
    .sort((a, b) => {
      if (!crossProvider) return 0;
      const costA = getModelCost(a);
      const costB = getModelCost(b);
      return costA - costB;
    });

  return candidates[0] ?? null;
}

function findModelForTierWithCapability(
  tier: ComplexityTier,
  config: DynamicRoutingConfig,
  availableModelIds: string[],
  crossProvider: boolean,
  unitType: string,
  metadata?: { tags?: string[]; complexityKeywords?: string[]; fileCount?: number; estimatedLines?: number },
): { modelId: string | null; scores: Record<string, number>; requirements: Partial<Record<string, number>> } {
  const explicitModel = config.tier_models?.[tier];
  if (explicitModel) {
    const match = availableModelIds.find(id => {
      const bareAvail = id.includes("/") ? id.split("/").pop()! : id;
      const bareExplicit = explicitModel.includes("/") ? explicitModel.split("/").pop()! : explicitModel;
      return bareAvail === bareExplicit || id === explicitModel;
    });
    if (match) return { modelId: match, scores: {}, requirements: {} };
  }

  const requirements = computeTaskRequirements(unitType, metadata);
  const candidates = availableModelIds.filter(id => getModelTier(id) === tier);
  if (candidates.length === 0) return { modelId: null, scores: {}, requirements };

  const scores: Record<string, number> = {};
  for (const id of candidates) {
    const bareId = id.includes("/") ? id.split("/").pop()! : id;
    const profile = getModelProfile(bareId);
    scores[id] = scoreModel(profile, requirements);
  }

  candidates.sort((a, b) => {
    const scoreDiff = scores[b] - scores[a];
    if (Math.abs(scoreDiff) > 2) return scoreDiff;
    if (crossProvider) {
      const costDiff = getModelCost(a) - getModelCost(b);
      if (costDiff !== 0) return costDiff;
    }
    return a.localeCompare(b);
  });

  return { modelId: candidates[0], scores, requirements };
}

function getModelProfile(bareId: string): ModelCapabilities {
  if (MODEL_CAPABILITY_PROFILES[bareId]) return MODEL_CAPABILITY_PROFILES[bareId];
  for (const [knownId, profile] of Object.entries(MODEL_CAPABILITY_PROFILES)) {
    if (bareId.includes(knownId) || knownId.includes(bareId)) return profile;
  }
  return { coding: 50, debugging: 50, research: 50, reasoning: 50, speed: 50, longContext: 50, instruction: 50 };
}

function getModelCost(modelId: string): number {
  const bareId = modelId.includes("/") ? modelId.split("/").pop()! : modelId;

  if (MODEL_COST_PER_1K_INPUT[bareId] !== undefined) {
    return MODEL_COST_PER_1K_INPUT[bareId];
  }

  // Check partial matches
  for (const [knownId, cost] of Object.entries(MODEL_COST_PER_1K_INPUT)) {
    if (bareId.includes(knownId) || knownId.includes(bareId)) return cost;
  }

  // Unknown cost — assume expensive to avoid routing to unknown cheap models
  return 999;
}
