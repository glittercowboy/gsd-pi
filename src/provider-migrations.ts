import type { AuthStorage } from "@gsd/pi-coding-agent"

type AnthropicMigrationDeps = {
  authStorage: Pick<AuthStorage, "get">
  isClaudeCodeReady: boolean
  defaultProvider: string | undefined
  env?: NodeJS.ProcessEnv
}

export function hasDirectAnthropicApiKey(
  authStorage: Pick<AuthStorage, "get">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if ((env.ANTHROPIC_API_KEY ?? "").trim()) {
    return true
  }

  const credential = authStorage.get("anthropic") as { type?: string; key?: string } | undefined
  return credential?.type === "api_key" && typeof credential?.key === "string" && credential.key.trim().length > 0
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
