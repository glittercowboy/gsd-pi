/**
 * Model selection and dynamic routing for auto-mode unit dispatch.
 * Handles complexity-based routing, model resolution across providers,
 * and fallback chains.
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import type { GSDPreferences } from "./preferences.js";
import { resolveModelWithFallbacksForUnit, resolveDynamicRoutingConfig } from "./preferences.js";
import type { ComplexityTier } from "./complexity-classifier.js";
import { classifyUnitComplexity, tierLabel } from "./complexity-classifier.js";
import {
  resolveModelForComplexity,
  escalateTier,
  getRequiredToolNames,
  filterModelsByToolCompatibility,
  type ToolCompatibilityInfo,
} from "./model-router.js";
import { getLedger, getProjectTotals } from "./metrics.js";
import { unitPhaseLabel } from "./auto-dashboard.js";
import { getProviderCapabilities, setProviderCapabilityOverrides, type ProviderCapabilities } from "@gsd/pi-ai";
import { isToolCompatibleWithProvider } from "./model-router.js";

export interface ModelSelectionResult {
  /** Routing metadata for metrics recording */
  routing: { tier: string; modelDowngraded: boolean } | null;
  /**
   * Prior active tools saved before adjustToolSet filtering.
   * Caller MUST restore these in a finally block after dispatch to prevent session drift.
   * Undefined when no tool adjustment was applied.
   */
  priorTools?: string[];
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
  // ADR-005 Phase 6: Apply provider capability overrides from preferences.
  // Only update when prefs are available — preserve prior overrides when prefs are transiently undefined.
  if (prefs) {
    const overrideWarnings = setProviderCapabilityOverrides(prefs.provider_capabilities);
    if (verbose && overrideWarnings.length > 0) {
      for (const warn of overrideWarnings) {
        ctx.ui.notify(warn, "warning");
      }
    }
  }

  const modelConfig = resolvePreferredModelConfig(unitType, autoModeStartModel);
  let routing: { tier: string; modelDowngraded: boolean } | null = null;

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

        // ADR-005 Step 2: Filter models by tool compatibility BEFORE scoring.
        // Build a lookup from model ID → API string for the compatibility filter.
        const modelApiLookup: Record<string, string> = {};
        for (const m of availableModels) {
          modelApiLookup[m.id] = m.api;
        }

        // Get required tools for this unit type, enriched with compatibility metadata
        const requiredToolNames = getRequiredToolNames(unitType);
        const allToolInfos = pi.getAllTools();
        const requiredTools: ToolCompatibilityInfo[] = requiredToolNames
          .map(name => {
            const toolInfo = allToolInfos.find(t => t.name === name);
            return toolInfo ? { name: toolInfo.name, compatibility: toolInfo.compatibility } : { name };
          });

        const compatibleModelIds = filterModelsByToolCompatibility(
          availableModelIds,
          requiredTools,
          modelApiLookup,
        );

        if (verbose && compatibleModelIds.length < availableModelIds.length) {
          const filtered = availableModelIds.length - compatibleModelIds.length;
          ctx.ui.notify(
            `Tool compatibility: filtered ${filtered} model(s) incompatible with ${unitType} tools`,
            "info",
          );
        }

        const routingResult = resolveModelForComplexity(classification, modelConfig, routingConfig, compatibleModelIds);

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
        const fallbackNote = modelId === effectiveModelConfig.primary
          ? ""
          : ` (fallback from ${effectiveModelConfig.primary})`;
        const phase = unitPhaseLabel(unitType);
        ctx.ui.notify(`Model [${phase}]${routingTierLabel}: ${model.provider}/${model.id}${fallbackNote}`, "info");

        // ADR-005: Adjust tool set for selected model's provider capabilities.
        // Save prior tools so caller can restore after dispatch (prevents session drift).
        // Note: model objects from getAvailable() are Model<Api> with .api field,
        // but resolveModelId's generic constraint only requires { id, provider }.
        const modelApi = "api" in model ? (model as { api: string }).api : undefined;
        if (modelApi) {
          const priorToolNames = pi.getActiveTools();
          const providerCaps = getProviderCapabilities(modelApi);
          const allTools = pi.getAllTools();
          const adjusted = adjustToolSet(allTools, providerCaps);
          if (adjusted.length < allTools.length) {
            pi.setActiveTools(adjusted.map(t => t.name));
            if (verbose) {
              const removed = allTools.length - adjusted.length;
              ctx.ui.notify(`Tool adjustment: ${removed} tool(s) filtered for ${modelApi}`, "info");
            }
            return { routing, priorTools: priorToolNames };
          }
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
        if (byId) await pi.setModel(byId, { persist: false });
      }
    }
  }

  return { routing };
}

/**
 * Filter the active tool set based on provider capabilities.
 * Pure function — does not call pi API, returns filtered tool list.
 *
 * - Tools without compatibility metadata always pass (fail-open)
 * - Tools with producesImages that the provider can't handle are removed
 * - Tools with unsupported schema features are removed
 * - If maxTools exceeded, lowest-priority tools are pruned
 */
export function adjustToolSet(
  registeredTools: Array<{ name: string; compatibility?: { producesImages?: boolean; schemaFeatures?: string[] }; priority?: number }>,
  providerCaps: ProviderCapabilities,
): Array<{ name: string; compatibility?: { producesImages?: boolean; schemaFeatures?: string[] }; priority?: number }> {
  let filtered = registeredTools.filter(tool => {
    return isToolCompatibleWithProvider(
      { name: tool.name, compatibility: tool.compatibility as any },
      providerCaps,
    );
  });

  // Prune if exceeding maxTools (0 = unlimited)
  if (providerCaps.maxTools > 0 && filtered.length > providerCaps.maxTools) {
    filtered.sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1));
    filtered = filtered.slice(0, providerCaps.maxTools);
  }

  return filtered;
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

  // Bare ID — prefer current provider, then first available
  const exactProviderMatch = availableModels.find(
    m => m.id === modelId && m.provider === currentProvider,
  );
  return exactProviderMatch ?? availableModels.find(m => m.id === modelId);
}
