/**
 * Model selection and dynamic routing for auto-mode unit dispatch.
 * Handles complexity-based routing, model resolution across providers,
 * and fallback chains.
 */

import type { Api, Model } from "@gsd/pi-ai";
import { getProviderCapabilities } from "@gsd/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import type { GSDPreferences } from "./preferences.js";
import { resolveModelWithFallbacksForUnit, resolveDynamicRoutingConfig } from "./preferences.js";
import type { ComplexityTier } from "./complexity-classifier.js";
import { classifyUnitComplexity, extractTaskMetadata, tierLabel } from "./complexity-classifier.js";
import { resolveModelForComplexity, escalateTier, getEligibleModels, loadCapabilityOverrides, adjustToolSet, filterToolsForProvider } from "./model-router.js";
import { getLedger, getProjectTotals } from "./metrics.js";
import { unitPhaseLabel } from "./auto-dashboard.js";
import { getSessionModelOverride } from "./session-model-override.js";
import { logWarning } from "./workflow-logger.js";
import { resolveUokFlags } from "./uok/flags.js";
import { applyModelPolicyFilter } from "./uok/model-policy.js";

export interface ModelSelectionResult {
  /** Routing metadata for metrics recording */
  routing: { tier: string; modelDowngraded: boolean } | null;
  /** Concrete model applied before dispatch so it can be restored after a fresh session. */
  appliedModel: Model<Api> | null;
}

export function resolvePreferredModelConfig(
  unitType: string,
  autoModeStartModel: { provider: string; id: string; flatRateCtx?: FlatRateContext } | null,
  isAutoMode = true,
) {
  const explicitConfig = resolveModelWithFallbacksForUnit(unitType);
  if (explicitConfig) return explicitConfig;

  // In interactive mode, don't synthesize a routing-based model config.
  // The user's session model (/model) should be used as-is (#3962).
  if (!isAutoMode) return undefined;

  const routingConfig = resolveDynamicRoutingConfig();
  if (!routingConfig.enabled || !routingConfig.tier_models) return undefined;

  // Don't synthesize a routing config for flat-rate providers (#3453).
  // Users can opt into routing for flat-rate subscriptions (e.g. claude-code)
  // via dynamic_routing.allow_flat_rate_providers (#4386).
  if (
    !routingConfig.allow_flat_rate_providers &&
    autoModeStartModel &&
    isFlatRateProvider(autoModeStartModel.provider, autoModeStartModel.flatRateCtx)
  ) {
    return undefined;
  }

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
  autoModeStartModel: { provider: string; id: string; flatRateCtx?: FlatRateContext } | null,
  retryContext?: { isRetry: boolean; previousTier?: string },
  /** When false (interactive/guided-flow), skip dynamic routing and use the session model.
   *  Dynamic routing only applies in auto-mode where cost optimization is expected. (#3962) */
  isAutoMode = true,
  /** Explicit /gsd model pin captured at bootstrap for long-running auto loops. */
  sessionModelOverride?: { provider: string; id: string } | null,
): Promise<ModelSelectionResult> {
  const uokFlags = resolveUokFlags(prefs);
  const effectiveSessionModelOverride = sessionModelOverride === undefined
    ? getSessionModelOverride(ctx.sessionManager.getSessionId())
    : (sessionModelOverride ?? undefined);
  // Enrich the start model with a flat-rate context up front so routing
  // synthesis and the dispatch-time guard see the same signals (built-in
  // list + user `flat_rate_providers` preference + externalCli auto-
  // detection).  The dispatch-time primary-model check below builds its
  // own per-provider context when it has a resolved primary model.
  if (autoModeStartModel) {
    autoModeStartModel = {
      ...autoModeStartModel,
      flatRateCtx: buildFlatRateContext(autoModeStartModel.provider, ctx, prefs),
    };
  }
  const modelConfig = effectiveSessionModelOverride
    ? undefined
    : resolvePreferredModelConfig(unitType, autoModeStartModel, isAutoMode);
  let routing: { tier: string; modelDowngraded: boolean } | null = null;
  let appliedModel: Model<Api> | null = null;

  if (modelConfig) {
    const availableModels = ctx.modelRegistry.getAvailable();
    const modelPolicyTraceId = `model:${ctx.sessionManager.getSessionId()}:${Date.now()}`;
    const modelPolicyTurnId = `${unitType}:${unitId}`;
    let policyAllowedModelKeys: Set<string> | null = null;

    // ─── Dynamic Model Routing ─────────────────────────────────────────
    // Dynamic routing (complexity-based downgrading) only applies in auto-mode.
    // Interactive/guided-flow dispatches use the user's session model directly,
    // respecting their /model selection without silent downgrades (#3962).
    const routingConfig = resolveDynamicRoutingConfig();
    if (!isAutoMode) {
      routingConfig.enabled = false;
    }
    // burn-max defaults to quality-first dispatch (no downgrade routing).
    if (prefs?.token_profile === "burn-max") {
      routingConfig.enabled = false;
    }
    let effectiveModelConfig = modelConfig;
    let routingTierLabel = "";
    let routingEligibleModels = availableModels;

    const taskMetadataForPolicy = unitType === "execute-task"
      ? extractTaskMetadata(unitId, basePath)
      : undefined;

    if (uokFlags.modelPolicy) {
      const policy = applyModelPolicyFilter(
        availableModels,
        {
          basePath,
          traceId: modelPolicyTraceId,
          turnId: modelPolicyTurnId,
          unitType,
          taskMetadata: taskMetadataForPolicy,
          currentProvider: ctx.model?.provider,
          allowCrossProvider: routingConfig.cross_provider !== false,
          requiredTools: pi.getActiveTools(),
        },
      );
      routingEligibleModels = policy.eligible;
      policyAllowedModelKeys = new Set(
        policy.eligible.map((m) => `${m.provider.toLowerCase()}/${m.id.toLowerCase()}`),
      );
      if (routingEligibleModels.length === 0) {
        throw new Error(`Model policy denied all candidate models for ${unitType}/${unitId}`);
      }
    }

    // Disable routing for flat-rate providers like GitHub Copilot (#3453).
    // All models cost the same per request, so downgrading to a cheaper
    // model provides no cost benefit — it only degrades quality.
    // Fail-closed: if primary model can't be resolved, fall back to
    // provider-level signals rather than allowing unwanted downgrades.
    // Opt-in: dynamic_routing.allow_flat_rate_providers skips the bypass so
    // claude-code subscribers can still get intelligent per-task selection
    // across their subscription (#4386).
    if (routingConfig.enabled && !routingConfig.allow_flat_rate_providers) {
      const primaryModel = resolveModelId(modelConfig.primary, routingEligibleModels, ctx.model?.provider);
      if (primaryModel) {
        const primaryFlatRateCtx = buildFlatRateContext(primaryModel.provider, ctx, prefs);
        if (isFlatRateProvider(primaryModel.provider, primaryFlatRateCtx)) {
          routingConfig.enabled = false;
        }
      } else if (
        (autoModeStartModel && isFlatRateProvider(autoModeStartModel.provider, autoModeStartModel.flatRateCtx))
        || (ctx.model?.provider && isFlatRateProvider(
          ctx.model.provider,
          buildFlatRateContext(ctx.model.provider, ctx, prefs),
        ))
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
        let classification = classifyUnitComplexity(
          unitType,
          unitId,
          basePath,
          budgetPct,
          taskMetadataForPolicy,
        );
        const availableModelIds = routingEligibleModels.map(m => `${m.provider}/${m.id}`);

        // Escalate tier on retry when escalate_on_failure is enabled (default: true)
        if (
          retryContext?.isRetry &&
          retryContext.previousTier &&
          routingConfig.escalate_on_failure !== false
        ) {
          const escalated = escalateTier(retryContext.previousTier as ComplexityTier);
          if (escalated) {
            classification = { ...classification, tier: escalated, reason: "escalated after failure" };
            // Always notify on tier escalation — model changes should be visible (#3962)
            ctx.ui.notify(
              `Tier escalation: ${retryContext.previousTier} → ${escalated} (retry after failure)`,
              "info",
            );
          }
        }

        // Load user capability overrides from preferences (D-17: deep-merged with built-in profiles)
        const capabilityOverrides = loadCapabilityOverrides(prefs ?? {});

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
          // Always notify on model downgrade — users should see when their
          // model selection is overridden, not just in verbose mode (#3962).
          if (routingResult.selectionMethod === "capability-scored" && routingResult.capabilityScores) {
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
        routingTierLabel = ` [${tierLabel(classification.tier)}]`;
        routing = { tier: classification.tier, modelDowngraded: routingResult.wasDowngraded };
      }
    }

    const modelsToTry = [effectiveModelConfig.primary, ...effectiveModelConfig.fallbacks];
    let attemptedPolicyEligible = false;

    for (const modelId of modelsToTry) {
      const resolutionPool = uokFlags.modelPolicy ? routingEligibleModels : availableModels;
      const model = resolveModelId(modelId, resolutionPool, ctx.model?.provider);

      if (!model) {
        if (verbose) ctx.ui.notify(`Model ${modelId} not found, trying fallback.`, "info");
        continue;
      }

      if (policyAllowedModelKeys) {
        const key = `${model.provider.toLowerCase()}/${model.id.toLowerCase()}`;
        if (!policyAllowedModelKeys.has(key)) {
          if (verbose) {
            ctx.ui.notify(`Model policy denied ${model.provider}/${model.id}; trying fallback.`, "warning");
          }
          continue;
        }
        attemptedPolicyEligible = true;
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

        // ADR-005: Adjust active tool set for the selected model's provider capabilities.
        // Hard-filter incompatible tools, then let extensions override via adjust_tool_set hook.
        const activeToolNames = pi.getActiveTools();
        const { toolNames: compatibleTools, removedTools } = adjustToolSet(activeToolNames, model.api);
        let finalToolNames = compatibleTools;

        // Fire adjust_tool_set hook — extensions can override the filtered tool set
        if (routingConfig.hooks !== false) {
          const hookResult = await pi.emitAdjustToolSet({
            selectedModelApi: model.api,
            selectedModelProvider: model.provider,
            selectedModelId: model.id,
            activeToolNames,
            filteredTools: removedTools,
          });
          if (hookResult?.toolNames) {
            finalToolNames = hookResult.toolNames;
          }
        }

        // Apply the filtered tool set if any tools were removed
        if (removedTools.length > 0 || finalToolNames.length !== activeToolNames.length) {
          pi.setActiveTools(finalToolNames);
        }

        if (verbose) {
          const fallbackNote = modelId === effectiveModelConfig.primary
            ? ""
            : ` (fallback from ${effectiveModelConfig.primary})`;
          const phase = unitPhaseLabel(unitType);
          ctx.ui.notify(`Model [${phase}]${routingTierLabel}: ${model.provider}/${model.id}${fallbackNote}`, "info");
          // ADR-005: Report tools filtered due to provider incompatibility
          if (removedTools.length > 0) {
            ctx.ui.notify(
              `Tool compatibility: ${removedTools.length} tools filtered for ${model.api} — ${removedTools.join(", ")}`,
              "info",
            );
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

    if (uokFlags.modelPolicy && policyAllowedModelKeys && !attemptedPolicyEligible) {
      throw new Error(`Model policy denied dispatch for ${unitType}/${unitId} before prompt send`);
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

  // Prefer "anthropic" as the canonical provider for Anthropic models.
  // Transport-specific tiebreaker (ADR-012): intentionally keys on provider,
  // not api — we want the plain Anthropic transport when multiple are available.
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
const BUILTIN_FLAT_RATE = new Set(["github-copilot", "copilot", "claude-code"]);

/**
 * Optional context that lets callers extend flat-rate detection beyond the
 * hard-coded built-in list.  Either signal on its own is enough to classify
 * a provider as flat-rate.
 */
export interface FlatRateContext {
  /**
   * Auth mode for the specific provider being checked, as returned by
   * `ctx.modelRegistry.getProviderAuthMode(provider)`.  Any provider that
   * wraps a local CLI (externalCli) is, by definition, a flat-rate
   * subscription wrapper — every request costs the same regardless of
   * model, so dynamic routing only degrades quality.
   */
  authMode?: "apiKey" | "oauth" | "externalCli" | "none";
  /**
   * Case-insensitive list of extra provider IDs the user has declared as
   * flat-rate via `preferences.flat_rate_providers`.  Used for private
   * subscription-backed proxies and enterprise-gated deployments that the
   * built-in list doesn't know about.
   */
  userFlatRate?: readonly string[];
}

export function isFlatRateProvider(provider: string, opts?: FlatRateContext): boolean {
  const p = provider.toLowerCase();
  if (BUILTIN_FLAT_RATE.has(p)) return true;
  if (opts?.userFlatRate?.some(id => id.toLowerCase() === p)) return true;
  if (opts?.authMode === "externalCli") return true;
  return false;
}

/**
 * Build a FlatRateContext for a given provider from live runtime state.
 * Safe to call when ctx or prefs are undefined — missing pieces are
 * treated as "no signal".
 */
export function buildFlatRateContext(
  provider: string,
  ctx?: { modelRegistry?: { getProviderAuthMode?: (p: string) => string } },
  prefs?: { flat_rate_providers?: readonly string[] },
): FlatRateContext {
  let authMode: FlatRateContext["authMode"];
  const registry = ctx?.modelRegistry;
  if (registry && typeof registry.getProviderAuthMode === "function") {
    try {
      const mode = registry.getProviderAuthMode(provider);
      if (mode === "apiKey" || mode === "oauth" || mode === "externalCli" || mode === "none") {
        authMode = mode;
      }
    } catch (err) {
      // Registry lookup failure must never break flat-rate detection —
      // fall through with authMode undefined and surface the cause.
      logWarning(
        "dispatch",
        `flat-rate auth-mode lookup failed for ${provider}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return {
    authMode,
    userFlatRate: prefs?.flat_rate_providers,
  };
}
