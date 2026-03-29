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
import { resolveModelForComplexity, escalateTier } from "./model-router.js";
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

        const routingResult = resolveModelForComplexity(classification, modelConfig, routingConfig, availableModelIds);

        if (routingResult.wasDowngraded) {
          effectiveModelConfig = {
            primary: routingResult.modelId,
            fallbacks: routingResult.fallbacks,
          };
          if (verbose) {
            ctx.ui.notify(
              `Dynamic routing [${tierLabel(classification.tier)}]: ${routingResult.modelId} (${classification.reason})`,
              "info",
            );
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
        const fallbackNote = modelId === effectiveModelConfig.primary
          ? ""
          : ` (fallback from ${effectiveModelConfig.primary})`;
        const phase = unitPhaseLabel(unitType);
        ctx.ui.notify(`Model [${phase}]${routingTierLabel}: ${model.provider}/${model.id}${fallbackNote}`, "info");
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

  // Extension / CLI-wrapper providers that should never win bare-ID resolution
  // when a first-class API provider also offers the same model.
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
