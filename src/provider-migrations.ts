import type { AuthStorage } from "@gsd/pi-coding-agent"

type AnthropicMigrationDeps = {
  authStorage: Pick<AuthStorage, "getCredentialsForProvider">
  isClaudeCodeReady: boolean
  defaultProvider: string | undefined
  env?: NodeJS.ProcessEnv
}

type MigrationModel = {
  provider: string
  id: string
}

type AnthropicDefaultMigrationDeps = {
  authStorage: Pick<AuthStorage, "getCredentialsForProvider">
  isClaudeCodeReady: boolean
  settingsManager: {
    getDefaultProvider(): string | undefined
    getDefaultModel(): string | undefined
    setDefaultModelAndProvider(provider: string, modelId: string): void
  }
  modelRegistry: {
    getAvailable(): MigrationModel[]
  }
  env?: NodeJS.ProcessEnv
}

export function hasDirectAnthropicApiKey(
  authStorage: Pick<AuthStorage, "getCredentialsForProvider">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if ((env.ANTHROPIC_API_KEY ?? "").trim()) {
    return true
  }

  return authStorage.getCredentialsForProvider("anthropic").some((credential: { type?: string; key?: string }) =>
    credential?.type === "api_key" && typeof credential?.key === "string" && credential.key.trim().length > 0,
  )
}

export function shouldMigrateAnthropicToClaudeCode({
  authStorage,
  isClaudeCodeReady,
  defaultProvider,
  env = process.env,
}: AnthropicMigrationDeps): boolean {
  if (!isClaudeCodeReady || defaultProvider !== "anthropic") {
    return false
  }

  return !hasDirectAnthropicApiKey(authStorage, env)
}

export function migrateAnthropicDefaultToClaudeCode({
  authStorage,
  isClaudeCodeReady,
  settingsManager,
  modelRegistry,
  env = process.env,
}: AnthropicDefaultMigrationDeps): boolean {
  const defaultProvider = settingsManager.getDefaultProvider()
  if (!shouldMigrateAnthropicToClaudeCode({ authStorage, isClaudeCodeReady, defaultProvider, env })) {
    return false
  }

  const defaultModel = settingsManager.getDefaultModel()
  const target =
    modelRegistry.getAvailable().find((model) => model.provider === "claude-code" && model.id === defaultModel) ||
    modelRegistry.getAvailable().find((model) => model.provider === "claude-code")

  if (!target) {
    return false
  }

  settingsManager.setDefaultModelAndProvider(target.provider, target.id)
  return true
}
