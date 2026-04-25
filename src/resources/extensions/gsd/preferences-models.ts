/**
 * Model-related preferences: resolution, fallbacks, profile defaults, and routing.
 *
 * Contains all logic for resolving model configurations from preferences,
 * including per-phase model selection, fallback chains, token profiles,
 * and dynamic routing configuration.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
    case "refine-slice":
    case "replan-slice":
      phaseConfig = m.planning;
      break;
    case "discuss-milestone":
    case "discuss-slice":
      phaseConfig = m.discuss ?? m.planning;
      break;
    case "execute-task":
    case "reactive-execute":
      phaseConfig = m.execution;
      break;
    case "execute-task-simple":
      phaseConfig = m.execution_simple ?? m.execution;
      break;
    case "complete-slice":
    case "complete-milestone":
    case "worktree-merge":
    case "run-uat":
      phaseConfig = m.completion;
      break;
    case "reassess-roadmap":
    case "rewrite-docs":
    case "gate-evaluate":
    case "validate-milestone":
      phaseConfig = m.validation ?? m.planning;
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
 * Resolve the default session model from GSD preferences.
 *
 * Used at auto-mode bootstrap to override the session model that was
 * determined by settings.json (defaultProvider/defaultModel).  When
 * PREFERENCES.md (or project preferences) configures an `execution` model
 * we treat that as the session default.  Falls back through execution →
 * planning → first configured model.
 *
 * Accepts an optional `sessionProvider` for bare model IDs that don't
 * include an explicit provider prefix (e.g. `gpt-5.4` instead of
 * `openai-codex/gpt-5.4`).  When a bare ID is found and sessionProvider
 * is available, the session provider is used.  Without sessionProvider,
 * bare IDs are still returned with provider set to the bare ID itself
 * so downstream resolution (resolveModelId) can match it.
 *
 * Returns `{ provider, id }` or `undefined` if no model preference is
 * configured.
 */
export function resolveDefaultSessionModel(
  sessionProvider?: string,
): { provider: string; id: string } | undefined {
  const prefs = loadEffectiveGSDPreferences();
  if (!prefs?.preferences.models) return undefined;

  const m = prefs.preferences.models as GSDModelConfigV2;

  // Priority: execution → planning → first configured value
  const candidates: Array<string | GSDPhaseModelConfig | undefined> = [
    m.execution,
    m.planning,
    m.research,
    m.discuss,
    m.completion,
    m.validation,
    m.subagent,
  ];

  for (const cfg of candidates) {
    if (!cfg) continue;

    // Normalize to provider + id from the various config shapes
    let provider: string | undefined;
    let id: string;

    if (typeof cfg === "string") {
      const slashIdx = cfg.indexOf("/");
      if (slashIdx !== -1) {
        provider = cfg.slice(0, slashIdx);
        id = cfg.slice(slashIdx + 1);
      } else {
        // Bare model ID (e.g. "gpt-5.4") — use session provider as context
        provider = sessionProvider;
        id = cfg;
      }
    } else {
      // Object config: { model, provider?, fallbacks? }
      if (cfg.provider) {
        provider = cfg.provider;
      } else if (cfg.model.includes("/")) {
        const slashIdx = cfg.model.indexOf("/");
        provider = cfg.model.slice(0, slashIdx);
        id = cfg.model.slice(slashIdx + 1);
        return { provider, id };
      } else {
        provider = sessionProvider;
      }
      id = cfg.model;
    }

    if (provider && id) {
      return { provider, id };
    }
  }

  return undefined;
}

/**
 * Returns true if `provider` is defined as a custom provider in the user's
 * `~/.gsd/agent/models.json` (Ollama, vLLM, LM Studio, OpenAI-compatible
 * proxies, etc.).
 *
 * Used by auto-mode bootstrap to decide whether the session model
 * (set via `/gsd model`) should override `PREFERENCES.md`.  Custom providers
 * are never reachable from `PREFERENCES.md` (which only knows built-in
 * providers), so when the user has explicitly selected one, it must take
 * priority — otherwise auto-mode tries to start the built-in provider from
 * PREFERENCES.md and fails with "Not logged in · Please run /login" (#4122).
 *
 * Reads models.json directly with a lightweight JSON parse to avoid
 * pulling in the full model-registry at this call site.  Falls back to
 * `~/.pi/agent/models.json` for parity with `resolveModelsJsonPath()`.
 * Any read or parse error yields `false` (treat as not-custom) so a
 * malformed models.json never breaks the session bootstrap.
 */
export function isCustomProvider(provider: string | undefined): boolean {
  if (!provider) return false;
  const candidates = [
    join(homedir(), ".gsd", "agent", "models.json"),
    join(homedir(), ".pi", "agent", "models.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as { providers?: Record<string, unknown> };
      if (parsed?.providers && Object.prototype.hasOwnProperty.call(parsed.providers, provider)) {
        return true;
      }
    } catch {
      // Ignore — malformed models.json must not break bootstrap.
    }
  }
  return false;
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

const VALID_TOKEN_PROFILES = new Set<TokenProfile>(["budget", "balanced", "quality", "burn-max"]);

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
    case "burn-max":
      return {
        // Quality-first profile: keep user-selected models, disable downgrade routing.
        // Policy constraints still apply at dispatch time.
        dynamic_routing: {
          enabled: false,
        },
        context_selection: "full",
        phases: {
          skip_research: false,
          skip_slice_research: false,
          skip_reassess: false,
          skip_milestone_validation: false,
          reassess_after_slice: true,
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
 * budget -> minimal, balanced -> standard, quality/burn-max -> full.
 */
export function resolveInlineLevel(): InlineLevel {
  const profile = resolveEffectiveProfile();
  switch (profile) {
    case "budget": return "minimal";
    case "balanced": return "standard";
    case "quality": return "full";
    case "burn-max": return "full";
  }
}

/**
 * Resolve the context selection mode from the active token profile.
 * budget -> "smart", balanced/quality/burn-max -> "full".
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
