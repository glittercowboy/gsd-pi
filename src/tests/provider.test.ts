/**
 * Tests for search provider selection, preference persistence, and key helpers.
 *
 * Covers:
 * - All 8 resolveSearchProvider() scenarios (keys × preferences)
 * - Preference get/set round-trip via AuthStorage
 * - Key helper functions
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void,
): void {
  const originals: Record<string, string | undefined> = {}
  for (const key of Object.keys(vars)) {
    originals[key] = process.env[key]
    if (vars[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = vars[key]
    }
  }
  try {
    fn()
  } finally {
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originals[key]
      }
    }
  }
}

function makeTmpAuth(data: Record<string, unknown> = {}): { authPath: string; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-provider-test-'))
  const authPath = join(tmp, 'auth.json')
  writeFileSync(authPath, JSON.stringify(data))
  return { authPath, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. resolveSearchProvider — 8 scenarios
// ═══════════════════════════════════════════════════════════════════════════

test('resolveSearchProvider returns tavily when only TAVILY_API_KEY is set', async () => {
  const { resolveSearchProvider } = await import(
    '../resources/extensions/search-the-web/provider.ts'
  )
  const { authPath, cleanup } = makeTmpAuth()
  try {
    withEnv({ TAVILY_API_KEY: 'tvly-test', BRAVE_API_KEY: undefined }, () => {
      // Override preference read to use our temp auth (auto)
      const result = resolveSearchProvider('auto')
      assert.equal(result, 'tavily')
    })
  } finally {
    cleanup()
  }
})

test('resolveSearchProvider returns brave when only BRAVE_API_KEY is set', async () => {
  const { resolveSearchProvider } = await import(
    '../resources/extensions/search-the-web/provider.ts'
  )
  withEnv({ TAVILY_API_KEY: undefined, BRAVE_API_KEY: 'BSA-test' }, () => {
    const result = resolveSearchProvider('auto')
    assert.equal(result, 'brave')
  })
})

test('resolveSearchProvider returns tavily when both keys set and preference is auto', async () => {
  const { resolveSearchProvider } = await import(
    '../resources/extensions/search-the-web/provider.ts'
  )
  withEnv({ TAVILY_API_KEY: 'tvly-test', BRAVE_API_KEY: 'BSA-test' }, () => {
    const result = resolveSearchProvider('auto')
    assert.equal(result, 'tavily')
  })
})

test('resolveSearchProvider returns tavily when both keys set and preference is tavily', async () => {
  const { resolveSearchProvider } = await import(
    '../resources/extensions/search-the-web/provider.ts'
  )
  withEnv({ TAVILY_API_KEY: 'tvly-test', BRAVE_API_KEY: 'BSA-test' }, () => {
    const result = resolveSearchProvider('tavily')
    assert.equal(result, 'tavily')
  })
})

test('resolveSearchProvider returns brave when both keys set and preference is brave', async () => {
  const { resolveSearchProvider } = await import(
    '../resources/extensions/search-the-web/provider.ts'
  )
  withEnv({ TAVILY_API_KEY: 'tvly-test', BRAVE_API_KEY: 'BSA-test' }, () => {
    const result = resolveSearchProvider('brave')
    assert.equal(result, 'brave')
  })
})

test('resolveSearchProvider returns null when neither key is set', async () => {
  const { resolveSearchProvider } = await import(
    '../resources/extensions/search-the-web/provider.ts'
  )
  withEnv({ TAVILY_API_KEY: undefined, BRAVE_API_KEY: undefined, OLLAMA_API_KEY: undefined }, () => {
    const result = resolveSearchProvider('auto')
    assert.equal(result, null)
  })
})

test('resolveSearchProvider treats invalid preference as auto', async () => {
  const { resolveSearchProvider } = await import(
    '../resources/extensions/search-the-web/provider.ts'
  )
  withEnv({ TAVILY_API_KEY: 'tvly-test', BRAVE_API_KEY: 'BSA-test' }, () => {
    const result = resolveSearchProvider('google')
    assert.equal(result, 'tavily', 'invalid preference falls back to auto → tavily first')
  })
})

test('resolveSearchProvider falls back to other provider when preferred key missing', async () => {
  const { resolveSearchProvider } = await import(
    '../resources/extensions/search-the-web/provider.ts'
  )
  // Prefer tavily but only brave key exists → falls back to brave
  withEnv({ TAVILY_API_KEY: undefined, BRAVE_API_KEY: 'BSA-test' }, () => {
    const result = resolveSearchProvider('tavily')
    assert.equal(result, 'brave', 'falls back to brave when tavily preferred but key missing')
  })
  // Prefer brave but only tavily key exists → falls back to tavily
  withEnv({ TAVILY_API_KEY: 'tvly-test', BRAVE_API_KEY: undefined }, () => {
    const result = resolveSearchProvider('brave')
    assert.equal(result, 'tavily', 'falls back to tavily when brave preferred but key missing')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Preference get/set round-trip
// ═══════════════════════════════════════════════════════════════════════════

test('getSearchProviderPreference returns auto when no preference stored', async () => {
  const { getSearchProviderPreference } = await import(
    '../resources/extensions/search-the-web/provider.ts'
  )
  const { authPath, cleanup } = makeTmpAuth()
  try {
    const pref = getSearchProviderPreference(authPath)
    assert.equal(pref, 'auto')
  } finally {
    cleanup()
  }
})

test('getSearchProviderPreference reads from auth.json via AuthStorage', async () => {
  const { getSearchProviderPreference } = await import(
    '../resources/extensions/search-the-web/provider.ts'
  )
  const { authPath, cleanup } = makeTmpAuth({
    search_provider: { type: 'api_key', key: 'tavily' },
  })
  try {
    const pref = getSearchProviderPreference(authPath)
    assert.equal(pref, 'tavily')
  } finally {
    cleanup()
  }
})

test('setSearchProviderPreference writes to auth.json via AuthStorage', async () => {
  const { getSearchProviderPreference, setSearchProviderPreference } = await import(
    '../resources/extensions/search-the-web/provider.ts'
  )
  const { authPath, cleanup } = makeTmpAuth()
  try {
    setSearchProviderPreference('brave', authPath)
    const pref = getSearchProviderPreference(authPath)
    assert.equal(pref, 'brave')

    // Round-trip: change to tavily
    setSearchProviderPreference('tavily', authPath)
    assert.equal(getSearchProviderPreference(authPath), 'tavily')

    // Round-trip: change to auto
    setSearchProviderPreference('auto', authPath)
    assert.equal(getSearchProviderPreference(authPath), 'auto')
  } finally {
    cleanup()
  }
})

test('getSearchProviderPreference returns auto for invalid stored value', async () => {
  const { getSearchProviderPreference } = await import(
    '../resources/extensions/search-the-web/provider.ts'
  )
  const { authPath, cleanup } = makeTmpAuth({
    search_provider: { type: 'api_key', key: 'google' },
  })
  try {
    const pref = getSearchProviderPreference(authPath)
    assert.equal(pref, 'auto', 'invalid stored value falls back to auto')
  } finally {
    cleanup()
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. Key helper functions
// ═══════════════════════════════════════════════════════════════════════════

test('getTavilyApiKey reads from process.env.TAVILY_API_KEY', async () => {
  const { getTavilyApiKey } = await import(
    '../resources/extensions/search-the-web/provider.ts'
  )
  withEnv({ TAVILY_API_KEY: 'tvly-test-key' }, () => {
    assert.equal(getTavilyApiKey(), 'tvly-test-key')
  })
  withEnv({ TAVILY_API_KEY: undefined }, () => {
    assert.equal(getTavilyApiKey(), '')
  })
})

test('getBraveApiKey reads from process.env.BRAVE_API_KEY', async () => {
  const { getBraveApiKey } = await import(
    '../resources/extensions/search-the-web/provider.ts'
  )
  withEnv({ BRAVE_API_KEY: 'BSA-test-key' }, () => {
    assert.equal(getBraveApiKey(), 'BSA-test-key')
  })
  withEnv({ BRAVE_API_KEY: undefined }, () => {
    assert.equal(getBraveApiKey(), '')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Boundary contract — S01→S02 public API surface
// ═══════════════════════════════════════════════════════════════════════════

test('provider.ts exports exactly the 6 expected functions', async () => {
  const provider = await import(
    '../resources/extensions/search-the-web/provider.ts'
  )

  const expectedExports = [
    'resolveSearchProvider',
    'getTavilyApiKey',
    'getBraveApiKey',
    'getOllamaApiKey',
    'getSearchProviderPreference',
    'setSearchProviderPreference',
  ] as const

  // Each expected export exists and is a function
  for (const name of expectedExports) {
    assert.equal(typeof provider[name], 'function', `${name} should be an exported function`)
  }

  // No unexpected function exports (types are erased at runtime, so only check functions)
  const actualFunctions = Object.keys(provider).filter(
    (k) => typeof (provider as Record<string, unknown>)[k] === 'function',
  )
  assert.deepEqual(
    actualFunctions.sort(),
    [...expectedExports].sort(),
    'provider.ts should export exactly the 6 expected functions (no extra function exports)',
  )
})
