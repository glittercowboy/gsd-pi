import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

test("onboarding persists defaultProvider for API-key and OAuth flows", () => {
  const source = readFileSync(
    join(import.meta.dirname, "..", "onboarding.ts"),
    "utf-8",
  )

  assert.match(
    source,
    /function persistDefaultProvider\(providerId: string\)/,
    "onboarding.ts must define persistDefaultProvider(providerId)",
  )

  assert.match(
    source,
    /await authStorage\.login\(providerId as LoginProviderId, loginCallbacks\)\s*\n\s*persistDefaultProvider\(providerId\)/,
    "OAuth onboarding must persist selected provider as defaultProvider",
  )

  assert.match(
    source,
    /authStorage\.set\(providerId, \{ type: 'api_key', key: trimmed \}\)\s*\n\s*persistDefaultProvider\(providerId\)/,
    "API-key onboarding must persist selected provider as defaultProvider",
  )
})

