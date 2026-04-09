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
  getAll(): MinimalModel[]
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
  const allModels = modelRegistry.getAll()
  const availableModels = modelRegistry.getAvailable()
  const configuredExists = configuredProvider && configuredModel &&
    allModels.some((m) => m.provider === configuredProvider && m.id === configuredModel)

  if (!configuredModel || !configuredExists) {
    // Model not configured at all, or removed from registry — pick a fallback.
    // Only fires when the model is genuinely unknown (not just temporarily unavailable).
    const piDefault = getPiDefaultModelAndProvider()
    const preferred =
      (piDefault
        ? availableModels.find((m) => m.provider === piDefault.provider && m.id === piDefault.model)
        : undefined) ||
      availableModels.find((m) => m.provider === 'openai' && m.id === 'gpt-5.4') ||
      availableModels.find((m) => m.provider === 'openai') ||
      availableModels.find((m) => m.provider === 'anthropic' && m.id === 'claude-opus-4-6') ||
      availableModels.find((m) => m.provider === 'anthropic' && m.id.includes('opus')) ||
      availableModels.find((m) => m.provider === 'anthropic') ||
      availableModels[0]
    if (preferred) {
      settingsManager.setDefaultModelAndProvider(preferred.provider, preferred.id)
    }
  }

  if (settingsManager.getDefaultThinkingLevel() !== 'off' && !configuredExists) {
    settingsManager.setDefaultThinkingLevel('off')
  }
}
