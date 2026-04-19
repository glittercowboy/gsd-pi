// GSD Extension — Dynamic Model Router
// Maps complexity tiers to models, enforcing downgrade-only semantics.
// The user's configured model is always the ceiling.

import type { ComplexityTier, ClassificationResult, TaskMetadata } from "./complexity-classifier.js";
import { tierOrdinal } from "./complexity-classifier.js";
import type { ResolvedModelConfig } from "./preferences.js";
import { getProviderCapabilities, type ProviderCapabilities } from "@gsd/pi-ai";
import { getToolCompatibility, getAllToolCompatibility } from "@gsd/pi-coding-agent";
import type { ToolCompatibility } from "@gsd/pi-coding-agent";

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
  /**
   * Opt into dynamic routing for flat-rate providers (e.g. claude-code,
   * GitHub Copilot). Default false preserves the #3453 bypass that skips
   * routing when the subscription makes per-request cost identical.
   * Enable only when you want per-task model selection across a flat-rate
   * subscription (e.g. haiku for research, opus for architecture). (#4386)
   */
  allow_flat_rate_providers?: boolean;
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
  /** How the model was selected */
  selectionMethod: "tier-only" | "capability-scored";
  /** Capability scores per eligible model (capability-scored path only) */
  capabilityScores?: Record<string, number>;
  /** Tools filtered out due to provider incompatibility (ADR-005) */
  filteredTools?: string[];
  /** Task requirement vector used for scoring */
  taskRequirements?: Partial<Record<string, number>>;
}

// ─── Capability Profiles ─────────────────────────────────────────────────────

/** Seven-dimension capability profile for a model. All values in 0–100 range. */
export interface ModelCapabilities {
  coding: number;
  debugging: number;
  research: number;
  reasoning: number;
  speed: number;
  longContext: number;
  instruction: number;
}

// ─── Known Model Tiers ───────────────────────────────────────────────────────
// Maps known model IDs to their capability tier. Used when tier_models is not
// explicitly configured to pick the best available model for each tier.

export const MODEL_CAPABILITY_TIER: Record<string, ComplexityTier> = {
  // Light-tier models (cheapest)
  "claude-haiku-4-5": "light",
  "claude-3-5-haiku-latest": "light",
  "claude-3-haiku-20240307": "light",
  "gpt-4o-mini": "light",
  "gpt-4.1-mini": "light",
  "gpt-4.1-nano": "light",
  "gpt-5-mini": "light",
  "gpt-5-nano": "light",
  "gpt-5.4-mini": "light",
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
  "claude-opus-4-7": "heavy",
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
  "claude-opus-4-6": 0.005,
  "claude-opus-4-7": 0.005,
  "gpt-4o-mini": 0.00015,
  "gpt-4o": 0.0025,
  "gpt-4.1": 0.002,
  "gpt-4.1-mini": 0.0004,
  "gpt-4.1-nano": 0.0001,
  "gpt-5": 0.01,
  "gpt-5-mini": 0.0003,
  "gpt-5-nano": 0.0001,
  "gpt-5.4-mini": 0.00075,
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

// ─── Capability Profiles Data Table ──────────────────────────────────────────
// Per-model capability profiles (0–100 scale). Used for capability-aware
// model selection within an eligible tier set.

export const MODEL_CAPABILITY_PROFILES: Record<string, ModelCapabilities> = {
  // ── Anthropic ──────────────────────────────────────────────────────────────
  "claude-opus-4-6":              { coding: 95, debugging: 90, research: 85, reasoning: 95, speed: 30, longContext: 80, instruction: 90 },
  "claude-opus-4-7":              { coding: 95, debugging: 90, research: 85, reasoning: 95, speed: 30, longContext: 80, instruction: 90 },
  "claude-sonnet-4-6":            { coding: 85, debugging: 80, research: 75, reasoning: 80, speed: 60, longContext: 75, instruction: 85 },
  "claude-sonnet-4-5-20250514":   { coding: 85, debugging: 80, research: 75, reasoning: 80, speed: 60, longContext: 75, instruction: 85 },
  "claude-3-5-sonnet-latest":     { coding: 82, debugging: 78, research: 72, reasoning: 78, speed: 62, longContext: 70, instruction: 82 },
  "claude-haiku-4-5":             { coding: 60, debugging: 50, research: 45, reasoning: 50, speed: 95, longContext: 50, instruction: 75 },
  "claude-3-5-haiku-latest":      { coding: 60, debugging: 50, research: 45, reasoning: 50, speed: 95, longContext: 50, instruction: 75 },
  "claude-3-haiku-20240307":      { coding: 50, debugging: 40, research: 35, reasoning: 40, speed: 95, longContext: 40, instruction: 65 },
  "claude-3-opus-latest":         { coding: 90, debugging: 85, research: 82, reasoning: 90, speed: 35, longContext: 75, instruction: 88 },

  // ── OpenAI GPT ─────────────────────────────────────────────────────────────
  "gpt-4o":                       { coding: 80, debugging: 75, research: 70, reasoning: 75, speed: 65, longContext: 70, instruction: 80 },
  "gpt-4o-mini":                  { coding: 55, debugging: 45, research: 40, reasoning: 45, speed: 90, longContext: 45, instruction: 70 },
  "gpt-4-turbo":                  { coding: 78, debugging: 72, research: 68, reasoning: 72, speed: 50, longContext: 65, instruction: 78 },
  "gpt-4.1":                      { coding: 82, debugging: 78, research: 72, reasoning: 78, speed: 62, longContext: 72, instruction: 82 },
  "gpt-4.1-mini":                 { coding: 58, debugging: 48, research: 42, reasoning: 48, speed: 88, longContext: 48, instruction: 72 },
  "gpt-4.1-nano":                 { coding: 40, debugging: 30, research: 25, reasoning: 30, speed: 95, longContext: 30, instruction: 60 },
  "gpt-5":                        { coding: 92, debugging: 88, research: 85, reasoning: 92, speed: 40, longContext: 85, instruction: 90 },
  "gpt-5-mini":                   { coding: 62, debugging: 52, research: 48, reasoning: 52, speed: 88, longContext: 52, instruction: 74 },
  "gpt-5-nano":                   { coding: 42, debugging: 32, research: 28, reasoning: 32, speed: 95, longContext: 32, instruction: 62 },
  "gpt-5.4-mini":                 { coding: 70, debugging: 60, research: 55, reasoning: 60, speed: 84, longContext: 60, instruction: 78 },
  "gpt-5-pro":                    { coding: 94, debugging: 90, research: 88, reasoning: 94, speed: 35, longContext: 88, instruction: 92 },
  "gpt-5.1":                      { coding: 93, debugging: 89, research: 86, reasoning: 93, speed: 42, longContext: 86, instruction: 91 },
  "gpt-5.1-codex-max":            { coding: 90, debugging: 85, research: 70, reasoning: 85, speed: 55, longContext: 75, instruction: 85 },
  "gpt-5.1-codex-mini":           { coding: 65, debugging: 55, research: 40, reasoning: 50, speed: 88, longContext: 48, instruction: 72 },
  "gpt-5.2":                      { coding: 93, debugging: 90, research: 87, reasoning: 93, speed: 42, longContext: 87, instruction: 91 },
  "gpt-5.2-codex":                { coding: 93, debugging: 90, research: 72, reasoning: 88, speed: 50, longContext: 78, instruction: 88 },
  "gpt-5.3-codex":                { coding: 94, debugging: 91, research: 74, reasoning: 89, speed: 50, longContext: 80, instruction: 89 },
  "gpt-5.3-codex-spark":          { coding: 68, debugging: 58, research: 42, reasoning: 52, speed: 90, longContext: 50, instruction: 74 },
  "gpt-5.4":                      { coding: 95, debugging: 92, research: 88, reasoning: 94, speed: 42, longContext: 88, instruction: 92 },

  // ── OpenAI o-series (reasoning-first) ──────────────────────────────────────
  "o1":                           { coding: 78, debugging: 82, research: 78, reasoning: 90, speed: 20, longContext: 65, instruction: 82 },
  "o3":                           { coding: 80, debugging: 85, research: 80, reasoning: 92, speed: 25, longContext: 70, instruction: 85 },
  "o4-mini":                      { coding: 75, debugging: 80, research: 72, reasoning: 88, speed: 60, longContext: 65, instruction: 80 },
  "o4-mini-deep-research":        { coding: 75, debugging: 80, research: 85, reasoning: 88, speed: 30, longContext: 80, instruction: 80 },

  // ── Google ─────────────────────────────────────────────────────────────────
  "gemini-2.5-pro":               { coding: 75, debugging: 70, research: 85, reasoning: 75, speed: 55, longContext: 90, instruction: 75 },
  "gemini-2.0-flash":             { coding: 50, debugging: 40, research: 50, reasoning: 40, speed: 95, longContext: 60, instruction: 65 },
  "gemini-flash-2.0":             { coding: 50, debugging: 40, research: 50, reasoning: 40, speed: 95, longContext: 60, instruction: 65 },

  // ── DeepSeek ───────────────────────────────────────────────────────────────
  "deepseek-chat":                { coding: 75, debugging: 65, research: 55, reasoning: 70, speed: 70, longContext: 55, instruction: 65 },
};

// ─── Base Task Requirements Data Table ───────────────────────────────────────
// Per-unit-type base requirement vectors. Weights indicate how important each
// capability dimension is for this unit type.

export const BASE_REQUIREMENTS: Record<string, Partial<Record<keyof ModelCapabilities, number>>> = {
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

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Score a model's suitability for a task given a requirement vector.
 * Returns a weighted average of capability dimensions (0–100).
 * Returns 50 if requirements are empty (neutral score).
 */
export function scoreModel(
  model: ModelCapabilities,
  requirements: Partial<Record<keyof ModelCapabilities, number>>,
): number {
  let weightedSum = 0;
  let weightSum = 0;
  for (const [dim, weight] of Object.entries(requirements)) {
    const capability = model[dim as keyof ModelCapabilities] ?? 50;
    weightedSum += weight * capability;
    weightSum += weight;
  }
  return weightSum > 0 ? weightedSum / weightSum : 50;
}

/**
 * Compute dynamic task requirements from unit type and optional task metadata.
 * Returns a requirement vector refined by task-specific signals.
 */
export function computeTaskRequirements(
  unitType: string,
  metadata?: TaskMetadata,
): Partial<Record<keyof ModelCapabilities, number>> {
  const base = BASE_REQUIREMENTS[unitType] ?? { reasoning: 0.5 };
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
 * Score all eligible models against a requirement vector and return them
 * sorted by score descending. Within 2 points: prefer cheaper; equal cost:
 * lexicographic tie-break by model ID.
 */
export function scoreEligibleModels(
  eligibleModelIds: string[],
  requirements: Partial<Record<keyof ModelCapabilities, number>>,
  capabilityOverrides?: Record<string, Partial<ModelCapabilities>>,
): Array<{ modelId: string; score: number }> {
  const scored = eligibleModelIds.map(modelId => {
    const bareId = bareModelId(modelId);
    const builtin = MODEL_CAPABILITY_PROFILES[bareId];
    const override = capabilityOverrides?.[modelId] ?? capabilityOverrides?.[bareId];
    const profile: ModelCapabilities = builtin
      ? override ? { ...builtin, ...override } : builtin
      : { coding: 50, debugging: 50, research: 50, reasoning: 50, speed: 50, longContext: 50, instruction: 50 };
    return { modelId, score: scoreModel(profile, requirements) };
  });
  scored.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > 2) return scoreDiff;
    const costA = MODEL_COST_PER_1K_INPUT[a.modelId] ?? Infinity;
    const costB = MODEL_COST_PER_1K_INPUT[b.modelId] ?? Infinity;
    if (costA !== costB) return costA - costB;
    return a.modelId.localeCompare(b.modelId);
  });
  return scored;
}

/**
 * Return all models eligible for a given tier, sorted cheapest first.
 * If routingConfig.tier_models[tier] is set and available, returns only that
 * model. Otherwise filters availableModelIds by tier from MODEL_CAPABILITY_TIER.
 */
export function getEligibleModels(
  tier: ComplexityTier,
  availableModelIds: string[],
  routingConfig: DynamicRoutingConfig,
): string[] {
  // 1. Check explicit tier_models config
  const explicitModel = routingConfig.tier_models?.[tier];
  if (explicitModel) {
    // Exact match
    if (availableModelIds.includes(explicitModel)) return [explicitModel];
    // Provider-prefix-stripped match
    const match = availableModelIds.find(id => {
      const bareAvail = id.includes("/") ? id.split("/").pop()! : id;
      const bareExplicit = explicitModel.includes("/") ? explicitModel.split("/").pop()! : explicitModel;
      return bareAvail === bareExplicit;
    });
    if (match) return [match];
  }

  // 2. Auto-detect: filter by tier, sort cheapest first
  return availableModelIds
    .filter(id => getModelTier(id) === tier)
    .sort((a, b) => {
      const costA = getModelCost(a);
      const costB = getModelCost(b);
      return costA - costB;
    });
}

/**
 * Build a fallback chain for a selected model: [selectedModel, ...configuredFallbacks, configuredPrimary]
 * Deduplicates entries while preserving order.
 */
function buildFallbackChain(selectedModelId: string, phaseConfig: ResolvedModelConfig): string[] {
  return [
    ...phaseConfig.fallbacks.filter(f => f !== selectedModelId),
    phaseConfig.primary,
  ].filter(f => f !== selectedModelId);
}

/**
 * Load capability overrides from user preferences' modelOverrides section.
 * Returns a map of model ID → partial capability overrides to deep-merge with built-in profiles.
 *
 * Per D-17: partial capability overrides via models.json modelOverrides, deep-merged with defaults.
 */
export function loadCapabilityOverrides(
  prefs: { modelOverrides?: Record<string, { capabilities?: Partial<ModelCapabilities> }> },
): Record<string, Partial<ModelCapabilities>> {
  const result: Record<string, Partial<ModelCapabilities>> = {};
  if (!prefs.modelOverrides) return result;
  for (const [modelId, overrideEntry] of Object.entries(prefs.modelOverrides)) {
    if (overrideEntry.capabilities) {
      result[modelId] = overrideEntry.capabilities;
    }
  }
  return result;
}

/**
 * Resolve the model to use for a given complexity tier.
 *
 * Downgrade-only: the returned model is always equal to or cheaper than
 * the user's configured primary model. Never upgrades beyond configuration.
 *
 * STEP 1: Filter to eligible models for the requested tier.
 * STEP 2: Capability scoring — ranks eligible models by task-capability match
 *         when capability_routing is enabled and multiple eligible models exist.
 * STEP 3: Fallback chain assembly.
 *
 * @param classification      The complexity classification result
 * @param phaseConfig         The user's configured model for this phase (ceiling)
 * @param routingConfig       Dynamic routing configuration
 * @param availableModelIds   List of available model IDs (from registry)
 * @param unitType            The unit type for capability requirement computation (optional)
 * @param taskMetadata        Task metadata for refined requirement vectors (optional)
 * @param capabilityOverrides User-provided capability overrides (deep-merged with built-in profiles, optional)
 */
export function resolveModelForComplexity(
  classification: ClassificationResult,
  phaseConfig: ResolvedModelConfig | undefined,
  routingConfig: DynamicRoutingConfig,
  availableModelIds: string[],
  unitType?: string,
  taskMetadata?: TaskMetadata,
  capabilityOverrides?: Record<string, Partial<ModelCapabilities>>,
): RoutingDecision {
  // If no phase config or routing disabled, pass through
  if (!phaseConfig || !routingConfig.enabled) {
    return {
      modelId: phaseConfig?.primary ?? "",
      fallbacks: phaseConfig?.fallbacks ?? [],
      tier: classification.tier,
      wasDowngraded: false,
      reason: "dynamic routing disabled or no phase config",
      selectionMethod: "tier-only",
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
      selectionMethod: "tier-only",
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
      selectionMethod: "tier-only",
    };
  }

  // STEP 1: Get all eligible models for the requested tier
  const eligible = getEligibleModels(requestedTier, availableModelIds, routingConfig);

  if (eligible.length === 0) {
    // No suitable model found — use configured primary
    return {
      modelId: configuredPrimary,
      fallbacks: phaseConfig.fallbacks,
      tier: requestedTier,
      wasDowngraded: false,
      reason: `no ${requestedTier}-tier model available`,
      selectionMethod: "tier-only",
    };
  }

  // STEP 2: Capability scoring (when enabled and multiple eligible models exist)
  if (routingConfig.capability_routing !== false && eligible.length > 1 && unitType) {
    const requirements = computeTaskRequirements(unitType, taskMetadata);
    const scored = scoreEligibleModels(eligible, requirements, capabilityOverrides);
    const winner = scored[0];
    if (winner) {
      const capScores: Record<string, number> = {};
      for (const s of scored) capScores[s.modelId] = s.score;
      const fallbacks = buildFallbackChain(winner.modelId, phaseConfig);
      return {
        modelId: winner.modelId,
        fallbacks,
        tier: requestedTier,
        wasDowngraded: true,
        reason: `capability-scored: ${winner.modelId} (${winner.score.toFixed(1)}) for ${unitType}`,
        capabilityScores: capScores,
        taskRequirements: requirements,
        selectionMethod: "capability-scored",
      };
    }
  }

  // STEP 3: Fallback — use first eligible model (cheapest in tier, or single eligible)
  const targetModelId = eligible[0];

  // Build fallback chain: [downgraded_model, ...configured_fallbacks, configured_primary]
  const fallbacks = buildFallbackChain(targetModelId, phaseConfig);

  return {
    modelId: targetModelId,
    fallbacks,
    tier: requestedTier,
    wasDowngraded: true,
    reason: classification.reason,
    selectionMethod: "tier-only",
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
    capability_routing: true,
    escalate_on_failure: true,
    budget_pressure: true,
    cross_provider: true,
    hooks: true,
  };
}

// ─── Internal ────────────────────────────────────────────────────────────────

function getModelTier(modelId: string): ComplexityTier {
  // Strip provider prefix if present
  const bareId = bareModelId(modelId);

  // Check exact match first
  if (MODEL_CAPABILITY_TIER[bareId]) return MODEL_CAPABILITY_TIER[bareId];

  // Check if any known model ID is a prefix/suffix match
  for (const [knownId, tier] of Object.entries(MODEL_CAPABILITY_TIER)) {
    if (bareId.includes(knownId) || knownId.includes(bareId)) return tier;
  }

  // Unknown models are assumed standard (per D-15: avoids silently ignoring user config)
  return "standard";
}

/** Check if a model ID has a known capability tier mapping. (#2192) */
function isKnownModel(modelId: string): boolean {
  const bareId = bareModelId(modelId);
  if (MODEL_CAPABILITY_TIER[bareId]) return true;
  for (const knownId of Object.keys(MODEL_CAPABILITY_TIER)) {
    if (bareId.includes(knownId) || knownId.includes(bareId)) return true;
  }
  return false;
}

function getModelCost(modelId: string): number {
  const bareId = bareModelId(modelId);

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

function bareModelId(modelId: string): string {
  return modelId.includes("/") ? modelId.split("/").pop()! : modelId;
}

// ─── Tool Compatibility Filter (ADR-005 Phase 3) ───────────────────────────

/**
 * Check if a tool is compatible with a provider's capabilities.
 * Returns true if the tool can be used with the provider.
 */
export function isToolCompatibleWithProvider(
  toolName: string,
  providerCaps: ProviderCapabilities,
): boolean {
  const compat = getToolCompatibility(toolName);
  if (!compat) return true;  // no metadata = always compatible

  // Hard filter: provider doesn't support image tool results
  if (compat.producesImages && !providerCaps.imageToolResults) return false;

  // Hard filter: tool uses schema features provider doesn't support
  if (compat.schemaFeatures?.some(f => providerCaps.unsupportedSchemaFeatures.includes(f))) {
    return false;
  }

  return true;
}

/**
 * Filter a list of tool names to only those compatible with a provider.
 * Used by the routing pipeline to adjust tool sets when switching providers.
 */
export function filterToolsForProvider(
  toolNames: string[],
  providerApi: string,
): { compatible: string[]; filtered: string[] } {
  const providerCaps = getProviderCapabilities(providerApi);

  // Provider doesn't support tool calling at all
  if (!providerCaps.toolCalling) {
    return { compatible: [], filtered: toolNames };
  }

  const compatible: string[] = [];
  const filtered: string[] = [];

  for (const name of toolNames) {
    if (isToolCompatibleWithProvider(name, providerCaps)) {
      compatible.push(name);
    } else {
      filtered.push(name);
    }
  }

  return { compatible, filtered };
}

/**
 * Adjust the active tool set for a selected model's provider capabilities.
 * Returns tool names that should be active — removes incompatible tools.
 *
 * This is a hard filter only — it removes tools that would fail at the
 * provider level. It does NOT remove tools based on soft heuristics.
 */
export function adjustToolSet(
  activeToolNames: string[],
  selectedModelApi: string,
): { toolNames: string[]; removedTools: string[] } {
  const { compatible, filtered } = filterToolsForProvider(activeToolNames, selectedModelApi);
  return { toolNames: compatible, removedTools: filtered };
}
