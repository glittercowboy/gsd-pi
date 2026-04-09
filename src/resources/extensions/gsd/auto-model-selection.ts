/**
 * Model selection and dynamic routing for auto-mode unit dispatch.
 * Handles complexity-based routing, model resolution across providers,
 * and fallback chains.
 */

import type { Api, Model } from "@gsd/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import type { GSDPreferences } from "./preferences.js";
import { resolveModelWithFallbacksForUnit, resolveDynamicRoutingConfig } from "./preferences.js";
import type { ComplexityTier } from "./complexity-classifier.js";
import { classifyUnitComplexity, tierLabel } from "./complexity-classifier.js";
import { resolveModelForComplexity, escalateTier, getEligibleModels, loadCapabilityOverrides } from "./model-router.js";
import { getLedger, getProjectTotals } from "./metrics.js";
import { unitPhaseLabel } from "./auto-dashboard.js";

export interface ModelSelectionResult {
  /** Routing metadata for metrics recording */
  routing: { tier: string; modelDowngraded: boolean } | null;
  /** Concrete model applied before dispatch so it can be restored after a fresh session. */
  appliedModel: Model<Api> | null;
}

export function resolvePreferredModelConfig(
  unitType: string,
  autoModeStartModel: { provider: string; id: string } | null,
) {
  const explicitConfig = resolveModelWithFallbacksForUnit(unitType);
  if (explicitConfig) return explicitConfig;

  const routingConfig = resolveDynamicRoutingConfig();
  if (!routingConfig.enabled || !routingConfig.tier_models) return undefined;

  // Don't synthesize a routing config for flat-rate providers (#3453).
  if (autoModeStartModel && isFlatRateProvider(autoModeStartModel.provider)) return undefined;

  const ceilingModel = routingConfig.tier_models.heavy
    ?? (autoModeStartModel ? `${autoModeStartModel.provider}/${autoModeStartModel.id}` : undefined);
  if (!ceilingModel) return undefined;

  return {
    primary: ceilingModel,
    fallbacks: [],
  };
}

/**
 * Select and apply the appropriate model for a unit dispatch.
 * Handles: per-unit-type model preferences, dynamic complexity routing,
 * provider/model resolution, fallback chains, and start-model re-application.
 *
 * Returns routing metadata for metrics tracking.
 */
export async function selectAndApplyModel(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  unitType: string,
  unitId: string,
  basePath: string,
  prefs: GSDPreferences | undefined,
  verbose: boolean,
  autoModeStartModel: { provider: string; id: string } | null,
  retryContext?: { isRetry: boolean; previousTier?: string },
): Promise<ModelSelectionResult> {
  const modelConfig = resolvePreferredModelConfig(unitType, autoModeStartModel);
  let routing: { tier: string; modelDowngraded: boolean } | null = null;
  let appliedModel: Model<Api> | null = null;

  if (modelConfig) {
    const availableModels = ctx.modelRegistry.getAvailable();

    // ─── Dynamic Model Routing ─────────────────────────────────────────
    const routingConfig = resolveDynamicRoutingConfig();
    let effectiveModelConfig = modelConfig;
    let routingTierLabel = "";

    // Disable routing for flat-rate providers like GitHub Copilot (#3453).
    // All models cost the same per request, so downgrading to a cheaper
    // model provides no cost benefit — it only degrades quality.
    // Fail-closed: if primary model can't be resolved, fall back to
    // provider-level signals rather than allowing unwanted downgrades.
    if (routingConfig.enabled) {
      const primaryModel = resolveModelId(modelConfig.primary, availableModels, ctx.model?.provider);
      if (primaryModel) {
        if (isFlatRateProvider(primaryModel.provider)) {
          routingConfig.enabled = false;
        }
      } else if (
        (autoModeStartModel && isFlatRateProvider(autoModeStartModel.provider))
        || (ctx.model?.provider && isFlatRateProvider(ctx.model.provider))
      ) {
        // Primary model unresolvable but provider signals indicate flat-rate —
        // disable routing to prevent quality degradation.
        routingConfig.enabled = false;
      }
    }

    if (routingConfig.enabled) {
      let budgetPct: number | undefined;
      if (routingConfig.budget_pressure !== false) {
        const budgetCeiling = prefs?.budget_ceiling;
        if (budgetCeiling !== undefined && budgetCeiling > 0) {
          const currentLedger = getLedger();
          const totalCost = currentLedger ? getProjectTotals(currentLedger.units).cost : 0;
          budgetPct = totalCost / budgetCeiling;
        }
      }

      const isHook = unitType.startsWith("hook/");
      const shouldClassify = !isHook || routingConfig.hooks !== false;

      if (shouldClassify) {
        let classification = classifyUnitComplexity(unitType, unitId, basePath, budgetPct);
        const availableModelIds = availableModels.map(m => m.id);

        // Escalate tier on retry when escalate_on_failure is enabled (default: true)
        if (
          retryContext?.isRetry &&
          retryContext.previousTier &&
          routingConfig.escalate_on_failure !== false
        ) {
          const escalated = escalateTier(retryContext.previousTier as ComplexityTier);
          if (escalated) {
            classification = { ...classification, tier: escalated, reason: "escalated after failure" };
            if (verbose) {
              ctx.ui.notify(
                `Tier escalation: ${retryContext.previousTier} → ${escalated} (retry after failure)`,
                "info",
              );
            }
          }
        }

        // Load user capability overrides from preferences (D-17: deep-merged with built-in profiles)
        const capabilityOverrides = loadCapabilityOverrides(
          (prefs as { modelOverrides?: Record<string, { capabilities?: Record<string, number> }> } | undefined) ?? {},
        );

        // Fire before_model_select hook (ADR-004, D-03)
        // Hook can override model selection entirely by returning { modelId }
        let hookOverride: string | undefined;
        if (routingConfig.hooks !== false) {
          const eligible = getEligibleModels(
            classification.tier,
            availableModelIds,
            routingConfig,
          );
          const hookResult = await pi.emitBeforeModelSelect({
            unitType,
            unitId,
            classification: {
              tier: classification.tier,
              reason: classification.reason,
              downgraded: classification.downgraded,
            },
            taskMetadata: classification.taskMetadata as Record<string, unknown> | undefined,
            eligibleModels: eligible,
            phaseConfig: modelConfig ? {
              primary: modelConfig.primary,
              fallbacks: modelConfig.fallbacks ?? [],
            } : undefined,
          });
          if (hookResult?.modelId) {
            hookOverride = hookResult.modelId;
          }
        }

        let routingResult: ReturnType<typeof resolveModelForComplexity>;
        if (hookOverride) {
          // Hook override bypasses capability scoring entirely
          routingResult = {
            modelId: hookOverride,
            fallbacks: [
              ...(modelConfig?.fallbacks ?? []).filter(f => f !== hookOverride),
              ...(modelConfig?.primary && modelConfig.primary !== hookOverride ? [modelConfig.primary] : []),
            ],
            tier: classification.tier,
            wasDowngraded: hookOverride !== modelConfig?.primary,
            reason: `hook override: ${hookOverride}`,
            selectionMethod: "tier-only",
          };
        } else {
          routingResult = resolveModelForComplexity(
            classification,
            modelConfig,
            routingConfig,
            availableModelIds,
            unitType,
            classification.taskMetadata,
            capabilityOverrides,
          );
        }

        if (routingResult.wasDowngraded) {
          effectiveModelConfig = {
            primary: routingResult.modelId,
            fallbacks: routingResult.fallbacks,
          };
          if (verbose) {
            if (routingResult.selectionMethod === "capability-scored" && routingResult.capabilityScores) {
              // Verbose scoring breakdown for capability-scored decisions (D-20)
              const tierLbl = tierLabel(classification.tier);
              const scores = Object.entries(routingResult.capabilityScores)
                .sort(([, a], [, b]) => b - a)
                .map(([id, score]) => `${id}: ${score.toFixed(1)}`)
                .join(", ");
              ctx.ui.notify(
                `Dynamic routing [${tierLbl}]: ${routingResult.modelId} (capability-scored) — ${scores}`,
                "info",
              );
            } else {
              ctx.ui.notify(
                `Dynamic routing [${tierLabel(classification.tier)}]: ${routingResult.modelId} (${classification.reason})`,
                "info",
              );
            }
          }
        }
        routingTierLabel = ` [${tierLabel(classification.tier)}]`;
        routing = { tier: classification.tier, modelDowngraded: routingResult.wasDowngraded };
      }
    }

    const modelsToTry = [effectiveModelConfig.primary, ...effectiveModelConfig.fallbacks];

    for (const modelId of modelsToTry) {
      const model = resolveModelId(modelId, availableModels, ctx.model?.provider);

      if (!model) {
        if (verbose) ctx.ui.notify(`Model ${modelId} not found, trying fallback.`, "info");
        continue;
      }

      // Warn if the ID is ambiguous across providers
      if (!modelId.includes("/")) {
        const providers = availableModels.filter(m => m.id === modelId).map(m => m.provider);
        if (providers.length > 1 && model.provider !== ctx.model?.provider) {
          ctx.ui.notify(
            `Model ID "${modelId}" exists in multiple providers (${providers.join(", ")}). ` +
            `Resolved to ${model.provider}. Use "provider/model" format for explicit targeting.`,
            "warning",
          );
        }
      }

      const ok = await pi.setModel(model, { persist: false });
      if (ok) {
        appliedModel = model;
        if (verbose) {
          const fallbackNote = modelId === effectiveModelConfig.primary
            ? ""
            : ` (fallback from ${effectiveModelConfig.primary})`;
          const phase = unitPhaseLabel(unitType);
          ctx.ui.notify(`Model [${phase}]${routingTierLabel}: ${model.provider}/${model.id}${fallbackNote}`, "info");
        }
        break;
      } else {
        const nextModel = modelsToTry[modelsToTry.indexOf(modelId) + 1];
        if (nextModel) {
          if (verbose) ctx.ui.notify(`Failed to set model ${modelId}, trying ${nextModel}...`, "info");
        } else {
          ctx.ui.notify(`All preferred models unavailable for ${unitType}. Using default.`, "warning");
        }
      }
    }
  } else if (autoModeStartModel) {
    // No model preference for this unit type — re-apply the model captured
    // at auto-mode start to prevent bleed from shared global settings.json (#650).
    const availableModels = ctx.modelRegistry.getAvailable();
    const startModel = availableModels.find(
      m => m.provider === autoModeStartModel.provider && m.id === autoModeStartModel.id,
    );
    if (startModel) {
      const ok = await pi.setModel(startModel, { persist: false });
      if (!ok) {
        const byId = availableModels.find(m => m.id === autoModeStartModel.id);
        if (byId) {
          const fallbackOk = await pi.setModel(byId, { persist: false });
          if (fallbackOk) appliedModel = byId;
        }
      } else {
        appliedModel = startModel;
      }
    }
  }

  return { routing, appliedModel };
}

/**
 * Resolve a model ID string to a model object from the available models list.
 * Handles formats: "provider/model", "bare-id", "org/model-name" (OpenRouter).
 */
export function resolveModelId<T extends { id: string; provider: string }>(
  modelId: string,
  availableModels: T[],
  currentProvider: string | undefined,
): T | undefined {
  const slashIdx = modelId.indexOf("/");

  if (slashIdx !== -1) {
    const maybeProvider = modelId.substring(0, slashIdx);
    const id = modelId.substring(slashIdx + 1);

    const knownProviders = new Set(availableModels.map(m => m.provider.toLowerCase()));
    if (knownProviders.has(maybeProvider.toLowerCase())) {
      const match = availableModels.find(
        m => m.provider.toLowerCase() === maybeProvider.toLowerCase()
          && m.id.toLowerCase() === id.toLowerCase(),
      );
      if (match) return match;
    }

    // Try matching the full string as a model ID (OpenRouter-style)
    const lower = modelId.toLowerCase();
    return availableModels.find(
      m => m.id.toLowerCase() === lower
        || `${m.provider}/${m.id}`.toLowerCase() === lower,
    );
  }

  // Bare ID — resolve with provider precedence to avoid silent misrouting.
  // Extension providers (e.g. claude-code) expose the same model IDs as their
  // upstream API providers but route through a subprocess with different
  // context, tool visibility, and cost characteristics (#2905).  Bare IDs in
  // PREFERENCES.md must resolve to the canonical API provider, not to an
  // extension wrapper that happens to be the current session provider.
  const candidates = availableModels.filter(m => m.id === modelId);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  // When the user's current provider is claude-code (set by startup migration
  // or explicit selection), honour it for bare IDs.  Routing back to anthropic
  // would undo the migration and hit the third-party subscription block (#3772).
  if (currentProvider === "claude-code") {
    const ccMatch = candidates.find(m => m.provider === "claude-code");
    if (ccMatch) return ccMatch;
  }

  // Extension / CLI-wrapper providers that should not win bare-ID resolution
  // when a first-class API provider also offers the same model AND the user
  // has not explicitly chosen the extension provider.
  const EXTENSION_PROVIDERS = new Set(["claude-code"]);

  // Prefer currentProvider only when it is a first-class API provider
  if (currentProvider && !EXTENSION_PROVIDERS.has(currentProvider)) {
    const providerMatch = candidates.find(m => m.provider === currentProvider);
    if (providerMatch) return providerMatch;
  }

  // Prefer "anthropic" as the canonical provider for Anthropic models
  const anthropicMatch = candidates.find(m => m.provider === "anthropic");
  if (anthropicMatch) return anthropicMatch;

  // Fall back to first non-extension candidate, or any candidate
  return candidates.find(m => !EXTENSION_PROVIDERS.has(m.provider)) ?? candidates[0];
}

/**
 * Flat-rate providers charge the same per request regardless of model.
 * Dynamic routing provides no cost benefit — it only degrades quality (#3453).
 * Uses case-insensitive matching with alias support to prevent fail-open on
 * provider naming variations (e.g. "copilot" vs "github-copilot").
 */
const FLAT_RATE_PROVIDERS = new Set(["github-copilot", "copilot", "claude-code"]);

export function isFlatRateProvider(provider: string): boolean {
  return FLAT_RATE_PROVIDERS.has(provider.toLowerCase());
}
