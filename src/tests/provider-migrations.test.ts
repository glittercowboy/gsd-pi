import test from "node:test"
import assert from "node:assert/strict"
import { hasDirectAnthropicApiKey, shouldMigrateAnthropicToClaudeCode } from "../provider-migrations.ts"

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
