/**
 * Startup model validation — extracted from cli.ts so it can be called
 * AFTER extensions register their models in the ModelRegistry.
 *
 * Before this extraction (bug #2626), the validation ran before
 * createAgentSession(), meaning extension-provided models (e.g.
 * claude-code/claude-sonnet-4-6) were not yet in the registry.
 * configuredExists was always false for extension models, causing the
 * user's valid choice to be silently overwritten with a built-in fallback.
 */

import { getPiDefaultModelAndProvider } from './pi-migration.js'

interface MinimalModel {
  provider: string
  id: string
}

interface MinimalModelRegistry {
  getAvailable(): MinimalModel[]
}

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

interface MinimalSettingsManager {
  getDefaultProvider(): string | undefined
  getDefaultModel(): string | undefined
  getDefaultThinkingLevel(): ThinkingLevel | undefined
  setDefaultModelAndProvider(provider: string, modelId: string): void
  setDefaultThinkingLevel(level: ThinkingLevel): void
}

/**
 * Validate the configured default model against the registry.
 *
 * If the configured model exists in the registry, this is a no-op — the
 * user's choice is preserved.  If it does not exist (stale settings from a
 * prior install, or genuinely removed model), a fallback is selected and
 * written to settings.
 *
 * IMPORTANT: Call this AFTER createAgentSession() so that extension-
 * provided models have been registered in the ModelRegistry.
 */
export function validateConfiguredModel(
  modelRegistry: MinimalModelRegistry,
  settingsManager: MinimalSettingsManager,
): void {
  const configuredProvider = settingsManager.getDefaultProvider()
  const configuredModel = settingsManager.getDefaultModel()
  const availableModels = modelRegistry.getAvailable()
  // Check against availableModels (configured + auth'd) rather than getAll()
  // so a stale default pointing at an unconfigured provider triggers the
  // fallback. Previously a model present in the registry but missing API
  // key / OAuth would satisfy configuredExists and survive startup, ending
  // up as ctx.model even though it couldn't actually be used.
  const configuredExists = configuredProvider && configuredModel &&
    availableModels.some((m) => m.provider === configuredProvider && m.id === configuredModel)

  if (!configuredModel || !configuredExists) {
    // Model not configured at all, or removed from registry — pick a fallback.
    // Only fires when the model is genuinely unknown (not just temporarily unavailable).
    //
    // Model-agnostic selection order:
    //   1. Pi migration default (preserves migration from ~/.pi install)
    //   2. Any model from the user's previously-chosen provider (provider stickiness)
    //   3. First available model in registry order (user-controlled via models.json)
    const piDefault = getPiDefaultModelAndProvider()
    const preferred =
      (piDefault
        ? availableModels.find((m) => m.provider === piDefault.provider && m.id === piDefault.model)
        : undefined) ||
      (configuredProvider
        ? availableModels.find((m) => m.provider === configuredProvider)
        : undefined) ||
      availableModels[0]
    if (preferred) {
      settingsManager.setDefaultModelAndProvider(preferred.provider, preferred.id)
    }
  }

  if (settingsManager.getDefaultThinkingLevel() !== 'off' && !configuredExists) {
    settingsManager.setDefaultThinkingLevel('off')
  }
}
