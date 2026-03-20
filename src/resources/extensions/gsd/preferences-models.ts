/**
 * Model-related preferences: resolution, fallbacks, profile defaults, and routing.
 *
 * Contains all logic for resolving model configurations from preferences,
 * including per-phase model selection, fallback chains, token profiles,
 * and dynamic routing configuration.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { DynamicRoutingConfig } from "./model-router.js";
import { defaultRoutingConfig } from "./model-router.js";
import type { TokenProfile, InlineLevel } from "./types.js";

import type {
  GSDPreferences,
  GSDModelConfigV2,
  GSDPhaseModelConfig,
  ResolvedModelConfig,
  AutoSupervisorConfig,
} from "./preferences-types.js";
import { loadEffectiveGSDPreferences, getGlobalGSDPreferencesPath } from "./preferences.js";

// Re-export types so existing consumers of ./preferences-models.js keep working
export type { GSDPhaseModelConfig, GSDModelConfig, GSDModelConfigV2, ResolvedModelConfig } from "./preferences-types.js";

/**
 * Resolve which model ID to use for a given auto-mode unit type.
 * Returns undefined if no model preference is set for this unit type.
 */
export function resolveModelForUnit(unitType: string): string | undefined {
  const resolved = resolveModelWithFallbacksForUnit(unitType);
  return resolved?.primary;
}

/**
 * Resolve model and fallbacks for a given auto-mode unit type.
 * Returns the primary model and ordered fallbacks, or undefined if not configured.
 *
 * Supports both legacy string format and extended object format:
 * - Legacy: `planning: claude-opus-4-6`
 * - Extended: `planning: { model: claude-opus-4-6, fallbacks: [glm-5, minimax-m2.5] }`
 */
export function resolveModelWithFallbacksForUnit(unitType: string): ResolvedModelConfig | undefined {
  const prefs = loadEffectiveGSDPreferences();
  if (!prefs?.preferences.models) return undefined;
  const m = prefs.preferences.models as GSDModelConfigV2;

  let phaseConfig: string | GSDPhaseModelConfig | undefined;
  switch (unitType) {
    case "research-milestone":
    case "research-slice":
      phaseConfig = m.research;
      break;
    case "plan-milestone":
    case "plan-slice":
    case "replan-slice":
      phaseConfig = m.planning;
      break;
    case "execute-task":
      phaseConfig = m.execution;
      break;
    case "execute-task-simple":
      phaseConfig = m.execution_simple ?? m.execution;
      break;
    case "complete-slice":
    case "run-uat":
      phaseConfig = m.completion;
      break;
    default:
      // Subagent unit types (e.g., "subagent", "subagent/scout")
      if (unitType === "subagent" || unitType.startsWith("subagent/")) {
        phaseConfig = m.subagent;
        break;
      }
      return undefined;
  }

  if (!phaseConfig) return undefined;

  // Normalize: string -> { model, fallbacks: [] }
  if (typeof phaseConfig === "string") {
    return { primary: phaseConfig, fallbacks: [] };
  }

  // When provider is explicitly set, prepend it to the model ID so the
  // resolution code in auto.ts can do an explicit provider match.
  const primary = phaseConfig.provider && !phaseConfig.model.includes("/")
    ? `${phaseConfig.provider}/${phaseConfig.model}`
    : phaseConfig.model;

  return {
    primary,
    fallbacks: phaseConfig.fallbacks ?? [],
  };
}

/**
 * Determines the next fallback model to try when the current model fails.
 * If the current model is not in the configured list, returns the primary model.
 * If the current model is the last in the list, returns undefined (exhausted).
 */
export function getNextFallbackModel(
  currentModelId: string | undefined,
  modelConfig: ResolvedModelConfig,
): string | undefined {
  const modelsToTry = [modelConfig.primary, ...modelConfig.fallbacks];

  if (!currentModelId) {
    return modelsToTry[0];
  }

  let foundCurrent = false;
  for (let i = 0; i < modelsToTry.length; i++) {
    const mId = modelsToTry[i];
    // Check for exact match or provider/model suffix match
    if (mId === currentModelId || (mId.includes("/") && mId.endsWith(`/${currentModelId}`))) {
      foundCurrent = true;
      return modelsToTry[i + 1]; // Return the next one, or undefined if at the end
    }
  }

  // If the current model wasn't in our preference list, default to starting the sequence
  if (!foundCurrent) {
    return modelsToTry[0];
  }
}

/**
 * Detect whether an error message indicates a transient network error
 * (worth retrying the same model) vs a permanent provider error
 * (auth failure, quota exceeded, etc. -- should fall back immediately).
 */
export function isTransientNetworkError(errorMsg: string): boolean {
  if (!errorMsg) return false;
  const hasNetworkSignal = /network|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|fetch failed|connection.*reset|dns/i.test(errorMsg);
  const hasPermanentSignal = /auth|unauthorized|forbidden|invalid.*key|quota|billing/i.test(errorMsg);
  return hasNetworkSignal && !hasPermanentSignal;
}

/**
 * Validate a model ID string.
 * Returns true if the ID looks like a valid model identifier.
 */
export function validateModelId(modelId: string): boolean {
  if (!modelId || typeof modelId !== "string") return false;
  const trimmed = modelId.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return false;
  // Allow alphanumeric, hyphens, underscores, dots, slashes, colons
  return /^[a-zA-Z0-9\-_./:]+$/.test(trimmed);
}

/**
 * Update the models section of the global GSD preferences file.
 * Performs a safe read-modify-write: reads current content, updates the models
 * YAML block, and writes back. Creates the file if it doesn't exist.
 */
export function updatePreferencesModels(models: GSDModelConfigV2): void {
  const prefsPath = getGlobalGSDPreferencesPath();

  let content = "";
  if (existsSync(prefsPath)) {
    content = readFileSync(prefsPath, "utf-8");
  }

  // Build the new models block
  const lines: string[] = ["models:"];
  for (const [phase, value] of Object.entries(models)) {
    if (typeof value === "string") {
      lines.push(`  ${phase}: ${value}`);
    } else if (value && typeof value === "object") {
      const config = value as GSDPhaseModelConfig;
      lines.push(`  ${phase}:`);
      lines.push(`    model: ${config.model}`);
      if (config.provider) {
        lines.push(`    provider: ${config.provider}`);
      }
      if (config.fallbacks && config.fallbacks.length > 0) {
        lines.push(`    fallbacks:`);
        for (const fb of config.fallbacks) {
          lines.push(`      - ${fb}`);
        }
      }
    }
  }
  const modelsBlock = lines.join("\n");

  // Replace existing models block or append
  const modelsRegex = /^models:[\s\S]*?(?=\n[a-z_]|\n*$)/m;
  if (modelsRegex.test(content)) {
    content = content.replace(modelsRegex, modelsBlock);
  } else {
    content = content.trimEnd() + "\n\n" + modelsBlock + "\n";
  }

  writeFileSync(prefsPath, content, "utf-8");
}

/**
 * Resolve the dynamic routing configuration from effective preferences.
 * Returns the merged config with defaults applied.
 */
export function resolveDynamicRoutingConfig(): DynamicRoutingConfig {
  const prefs = loadEffectiveGSDPreferences();
  const configured = prefs?.preferences.dynamic_routing;
  if (!configured) return defaultRoutingConfig();
  return {
    ...defaultRoutingConfig(),
    ...configured,
  };
}

export function resolveAutoSupervisorConfig(): AutoSupervisorConfig {
  const prefs = loadEffectiveGSDPreferences();
  const configured = prefs?.preferences.auto_supervisor ?? {};

  return {
    soft_timeout_minutes: configured.soft_timeout_minutes ?? 20,
    idle_timeout_minutes: configured.idle_timeout_minutes ?? 10,
    hard_timeout_minutes: configured.hard_timeout_minutes ?? 30,
    ...(configured.model ? { model: configured.model } : {}),
  };
}

// ─── Token Profile Resolution ─────────────────────────────────────────────

const VALID_TOKEN_PROFILES = new Set<TokenProfile>(["budget", "balanced", "quality"]);

/**
 * Resolve profile defaults for a given token profile tier.
 * Returns a partial GSDPreferences that is used as the base layer --
 * explicit user preferences always override these defaults.
 */
export function resolveProfileDefaults(profile: TokenProfile): Partial<GSDPreferences> {
  switch (profile) {
    case "budget":
      return {
        models: {
          planning: "claude-sonnet-4-5-20250514",
          execution: "claude-sonnet-4-5-20250514",
          execution_simple: "claude-haiku-4-5-20250414",
          completion: "claude-haiku-4-5-20250414",
          subagent: "claude-haiku-4-5-20250414",
        },
        phases: {
          skip_research: true,
          skip_reassess: true,
          skip_slice_research: true,
          skip_milestone_validation: true,
        },
      };
    case "balanced":
      return {
        models: {
          subagent: "claude-sonnet-4-5-20250514",
        },
        phases: {
          skip_research: true,
          skip_reassess: true,
          skip_slice_research: true,
        },
      };
    case "quality":
      return {
        models: {},
        phases: {
          skip_research: true,
          skip_slice_research: true,
          skip_reassess: true,
        },
      };
  }
}

/**
 * Resolve the effective token profile from preferences.
 * Returns "balanced" when no profile is set (D046).
 */
export function resolveEffectiveProfile(): TokenProfile {
  const prefs = loadEffectiveGSDPreferences();
  const profile = prefs?.preferences.token_profile;
  if (profile && VALID_TOKEN_PROFILES.has(profile)) return profile;
  return "balanced";
}

/**
 * Resolve the inline level from the active token profile.
 * budget -> minimal, balanced -> standard, quality -> full.
 */
export function resolveInlineLevel(): InlineLevel {
  const profile = resolveEffectiveProfile();
  switch (profile) {
    case "budget": return "minimal";
    case "balanced": return "standard";
    case "quality": return "full";
  }
}

/**
 * Resolve the context selection mode from the active token profile.
 * budget -> "smart", balanced/quality -> "full".
 * Explicit preference always wins.
 */
export function resolveContextSelection(): import("./types.js").ContextSelectionMode {
  const prefs = loadEffectiveGSDPreferences();
  if (prefs?.preferences.context_selection) return prefs.preferences.context_selection;
  const profile = resolveEffectiveProfile();
  return profile === "budget" ? "smart" : "full";
}

/**
 * Resolve the search provider preference from preferences.md.
 * Returns undefined if not configured (caller falls back to existing behavior).
 */
export function resolveSearchProviderFromPreferences(): GSDPreferences["search_provider"] | undefined {
  const prefs = loadEffectiveGSDPreferences();
  return prefs?.preferences.search_provider;
}
