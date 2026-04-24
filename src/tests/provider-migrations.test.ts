import test from "node:test"
import assert from "node:assert/strict"
import { hasDirectAnthropicApiKey, migrateAnthropicDefaultToClaudeCode, shouldMigrateAnthropicToClaudeCode } from "../provider-migrations.ts"

function makeAuthStorage(credentials: unknown[]) {
  return {
    getCredentialsForProvider(provider: string) {
      return provider === "anthropic" ? credentials : []
    },
  }
}

test("hasDirectAnthropicApiKey detects non-empty auth storage keys", () => {
  assert.equal(
    hasDirectAnthropicApiKey(
      makeAuthStorage([{ type: "api_key", key: "sk-ant-test" }]) as any,
      {} as NodeJS.ProcessEnv,
    ),
    true,
  )
})

test("hasDirectAnthropicApiKey ignores empty placeholder keys", () => {
  assert.equal(
    hasDirectAnthropicApiKey(
      makeAuthStorage([{ type: "api_key", key: "" }]) as any,
      {} as NodeJS.ProcessEnv,
    ),
    false,
  )
})

test("hasDirectAnthropicApiKey detects ANTHROPIC_API_KEY env fallback", () => {
  assert.equal(
    hasDirectAnthropicApiKey(
      makeAuthStorage([]) as any,
      { ANTHROPIC_API_KEY: "sk-ant-env" } as NodeJS.ProcessEnv,
    ),
    true,
  )
})

test("shouldMigrateAnthropicToClaudeCode blocks migration for direct-key users", () => {
  assert.equal(
    shouldMigrateAnthropicToClaudeCode({
      authStorage: makeAuthStorage([{ type: "api_key", key: "sk-ant-test" }]) as any,
      isClaudeCodeReady: true,
      defaultProvider: "anthropic",
      env: {} as NodeJS.ProcessEnv,
    }),
    false,
  )
})

test("shouldMigrateAnthropicToClaudeCode allows OAuth-only anthropic users", () => {
  assert.equal(
    shouldMigrateAnthropicToClaudeCode({
      authStorage: makeAuthStorage([{ type: "oauth" }]) as any,
      isClaudeCodeReady: true,
      defaultProvider: "anthropic",
      env: {} as NodeJS.ProcessEnv,
    }),
    true,
  )
})

test("shouldMigrateAnthropicToClaudeCode stays off for other providers", () => {
  assert.equal(
    shouldMigrateAnthropicToClaudeCode({
      authStorage: makeAuthStorage([{ type: "oauth" }]) as any,
      isClaudeCodeReady: true,
      defaultProvider: "openai",
      env: {} as NodeJS.ProcessEnv,
    }),
    false,
  )
})

test("migrateAnthropicDefaultToClaudeCode switches to matching claude-code model", () => {
  let saved: { provider: string; modelId: string } | undefined
  const migrated = migrateAnthropicDefaultToClaudeCode({
    authStorage: makeAuthStorage([{ type: "oauth" }]) as any,
    isClaudeCodeReady: true,
    settingsManager: {
      getDefaultProvider: () => "anthropic",
      getDefaultModel: () => "claude-sonnet-4-6",
      setDefaultModelAndProvider: (provider, modelId) => {
        saved = { provider, modelId }
      },
    },
    modelRegistry: {
      getAvailable: () => [
        { provider: "claude-code", id: "claude-sonnet-4-6" },
        { provider: "openai", id: "gpt-5.4" },
      ],
    },
    env: {} as NodeJS.ProcessEnv,
  })

  assert.equal(migrated, true)
  assert.deepEqual(saved, { provider: "claude-code", modelId: "claude-sonnet-4-6" })
})

test("migrateAnthropicDefaultToClaudeCode does not switch without a claude-code model", () => {
  let called = false
  const migrated = migrateAnthropicDefaultToClaudeCode({
    authStorage: makeAuthStorage([{ type: "oauth" }]) as any,
    isClaudeCodeReady: true,
    settingsManager: {
      getDefaultProvider: () => "anthropic",
      getDefaultModel: () => "claude-sonnet-4-6",
      setDefaultModelAndProvider: () => {
        called = true
      },
    },
    modelRegistry: {
      getAvailable: () => [{ provider: "openai", id: "gpt-5.4" }],
    },
    env: {} as NodeJS.ProcessEnv,
  })

  assert.equal(migrated, false)
  assert.equal(called, false)
})
