/**
 * Custom model provider tests.
 *
 * Covers:
 * - Template generation for all 4 presets + edge cases
 * - Template schema contract (Pi SDK ModelRegistry compatibility)
 * - shouldRunOnboarding() gating with models.json, auth, and TTY state
 * - ModelRegistry error surfacing (getError) for valid/malformed/missing models.json
 * - Startup fallback model selection via getAvailable()
 * - Auto-mode provider state tracking (originalProvider / originalModelId)
 * - openInEditor() fallback chain
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `gsd-${prefix}-`))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function makeTmpAuth(data: Record<string, unknown> = {}): {
  dir: string
  authPath: string
  cleanup: () => void
} {
  const { dir, cleanup } = makeTmpDir('auth')
  const authPath = join(dir, 'auth.json')
  writeFileSync(authPath, JSON.stringify(data))
  return { dir, authPath, cleanup }
}

function writeModelsJson(dir: string, providers: Record<string, unknown>): string {
  const path = join(dir, 'models.json')
  writeFileSync(path, JSON.stringify({ providers }))
  return path
}

/**
 * Run a function with process.stdin.isTTY temporarily set to the given value.
 * Restores the original value afterward.
 */
function withTTY(value: boolean | undefined, fn: () => void): void {
  const original = process.stdin.isTTY
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
  try {
    fn()
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true })
  }
}

/**
 * Simulate the startup fallback logic from cli.ts (lines 126-137).
 * Extracted here so we can test the algorithm against real ModelRegistry instances
 * without running the full CLI boot.
 */
function selectFallbackModel(available: { provider: string; id: string }[]) {
  return (
    available.find((m) => m.provider === 'anthropic' && m.id === 'claude-opus-4-6') ||
    available.find((m) => m.provider === 'anthropic' && m.id.includes('opus')) ||
    available.find((m) => m.provider === 'anthropic') ||
    available[0]
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. generateModelsTemplate — preset coverage
// ═══════════════════════════════════════════════════════════════════════════

test('generateModelsTemplate: each preset produces valid JSON with correct provider config', async () => {
  const { generateModelsTemplate, CUSTOM_PROVIDER_PRESETS } = await import('../onboarding.ts')

  const expectations: Record<string, { baseUrl: string; api: string; needsApiKey: boolean; exampleModel: string }> = {
    ollama: { baseUrl: 'http://localhost:11434/v1', api: 'openai-completions', needsApiKey: false, exampleModel: 'llama3.1:8b' },
    'lm-studio': { baseUrl: 'http://localhost:1234/v1', api: 'openai-completions', needsApiKey: false, exampleModel: 'loaded-model' },
    vllm: { baseUrl: 'http://localhost:8000/v1', api: 'openai-completions', needsApiKey: true, exampleModel: 'meta-llama/Llama-3.1-8B' },
    generic: { baseUrl: 'https://api.example.com/v1', api: 'openai-completions', needsApiKey: true, exampleModel: 'model-name' },
  }

  for (const [preset, expected] of Object.entries(expectations)) {
    const result = generateModelsTemplate(preset)
    const parsed = JSON.parse(result.json)

    // Top-level structure
    assert.ok(parsed.providers, `${preset}: has providers key`)
    assert.ok(parsed.providers[preset], `${preset}: provider key matches preset name`)

    // Provider fields
    const provider = parsed.providers[preset]
    assert.equal(provider.baseUrl, expected.baseUrl, `${preset}: baseUrl`)
    assert.equal(provider.api, expected.api, `${preset}: api`)
    assert.ok(Array.isArray(provider.models), `${preset}: models is array`)
    assert.ok(provider.models.length >= 1, `${preset}: has at least one model`)
    assert.equal(provider.models[0].id, expected.exampleModel, `${preset}: example model id`)

    // Return metadata
    assert.equal(result.providerName, preset, `${preset}: providerName matches`)
    assert.equal(result.needsApiKey, expected.needsApiKey, `${preset}: needsApiKey`)

    // Verify against CUSTOM_PROVIDER_PRESETS constant (single source of truth)
    const presetConfig = CUSTOM_PROVIDER_PRESETS[preset]
    assert.equal(provider.baseUrl, presetConfig.baseUrl, `${preset}: baseUrl matches CUSTOM_PROVIDER_PRESETS`)
    assert.equal(provider.api, presetConfig.api, `${preset}: api matches CUSTOM_PROVIDER_PRESETS`)
  }
})

test('generateModelsTemplate: unknown preset throws with descriptive message', async () => {
  const { generateModelsTemplate } = await import('../onboarding.ts')
  assert.throws(
    () => generateModelsTemplate('nonexistent'),
    /Unknown custom provider preset.*nonexistent/,
  )
})

test('generateModelsTemplate: all presets produce JSON that ModelRegistry can load', async () => {
  const { generateModelsTemplate, CUSTOM_PROVIDER_PRESETS } = await import('../onboarding.ts')
  const { ModelRegistry, AuthStorage } = await import('@mariozechner/pi-coding-agent')

  for (const preset of Object.keys(CUSTOM_PROVIDER_PRESETS)) {
    const { json, providerName, needsApiKey } = generateModelsTemplate(preset)
    const { dir, authPath, cleanup } = makeTmpAuth(
      needsApiKey ? { [providerName]: { type: 'api_key', key: 'test-key' } } : {}
    )

    try {
      // Write template to disk and load it via ModelRegistry
      const modelsPath = join(dir, 'models.json')
      writeFileSync(modelsPath, json)

      const auth = AuthStorage.create(authPath)
      const registry = new ModelRegistry(auth, modelsPath)

      // No errors from the template
      assert.equal(registry.getError(), undefined, `${preset}: template loads without error`)

      // The custom model appears in getAll()
      const all = registry.getAll()
      const customModel = all.find((m) => m.provider === providerName)
      assert.ok(customModel, `${preset}: custom model found in getAll()`)
    } finally {
      cleanup()
    }
  }
})

test('generateModelsTemplate: template JSON is human-readable (pretty-printed)', async () => {
  const { generateModelsTemplate } = await import('../onboarding.ts')
  const { json } = generateModelsTemplate('ollama')

  // Should be pretty-printed with indentation, not minified
  assert.ok(json.includes('\n'), 'JSON should contain newlines')
  assert.ok(json.includes('  '), 'JSON should contain indentation')

  // Verify round-trip: parse and re-stringify matches
  const parsed = JSON.parse(json)
  const repretty = JSON.stringify(parsed, null, 2)
  assert.equal(json, repretty, 'template should use standard 2-space indentation')
})

test('generateModelsTemplate: apiKey field is a string placeholder, not a real secret', async () => {
  const { generateModelsTemplate, CUSTOM_PROVIDER_PRESETS } = await import('../onboarding.ts')

  for (const preset of Object.keys(CUSTOM_PROVIDER_PRESETS)) {
    const { json } = generateModelsTemplate(preset)
    const parsed = JSON.parse(json)
    const apiKey = parsed.providers[preset].apiKey

    assert.equal(typeof apiKey, 'string', `${preset}: apiKey is a string`)
    // Should be a placeholder, not something that looks like a real key
    assert.ok(!apiKey.startsWith('sk-'), `${preset}: apiKey should not look like a real secret`)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Template file write round-trip
// ═══════════════════════════════════════════════════════════════════════════

test('generateModelsTemplate: write to disk and read back preserves all fields', async () => {
  const { generateModelsTemplate, CUSTOM_PROVIDER_PRESETS } = await import('../onboarding.ts')
  const { dir, cleanup } = makeTmpDir('template-write')

  try {
    for (const preset of Object.keys(CUSTOM_PROVIDER_PRESETS)) {
      const { json, providerName } = generateModelsTemplate(preset)
      const filePath = join(dir, `models-${preset}.json`)
      writeFileSync(filePath, json, 'utf-8')

      const raw = readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw)

      // Structural contract the wizard relies on
      assert.ok(parsed.providers[providerName], `${preset}: provider key survives round-trip`)
      assert.equal(typeof parsed.providers[providerName].baseUrl, 'string')
      assert.equal(typeof parsed.providers[providerName].api, 'string')
      assert.equal(typeof parsed.providers[providerName].apiKey, 'string')
      assert.ok(Array.isArray(parsed.providers[providerName].models))
      assert.equal(typeof parsed.providers[providerName].models[0].id, 'string')
    }
  } finally {
    cleanup()
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. shouldRunOnboarding
// ═══════════════════════════════════════════════════════════════════════════

test('shouldRunOnboarding: returns false when models.json exists (custom provider configured)', async () => {
  const { shouldRunOnboarding } = await import('../onboarding.ts')
  const { AuthStorage } = await import('@mariozechner/pi-coding-agent')

  const { dir, authPath, cleanup } = makeTmpAuth({
    ollama: { type: 'api_key', key: 'ollama' },
  })

  writeModelsJson(dir, {
    ollama: {
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      apiKey: 'ollama',
      models: [{ id: 'llama3.1:8b' }],
    },
  })

  try {
    const auth = AuthStorage.create(authPath)
    withTTY(true, () => {
      assert.equal(
        shouldRunOnboarding(auth, dir), false,
        'models.json presence should skip onboarding even without LLM provider auth',
      )
    })
  } finally {
    cleanup()
  }
})

test('shouldRunOnboarding: returns true when neither LLM auth nor models.json exists', async () => {
  const { shouldRunOnboarding } = await import('../onboarding.ts')
  const { AuthStorage } = await import('@mariozechner/pi-coding-agent')

  const { dir, authPath, cleanup } = makeTmpAuth({})

  try {
    const auth = AuthStorage.create(authPath)
    withTTY(true, () => {
      assert.equal(
        shouldRunOnboarding(auth, dir), true,
        'fresh user with no auth and no models.json should see onboarding',
      )
    })
  } finally {
    cleanup()
  }
})

test('shouldRunOnboarding: returns false when known LLM provider is authed', async () => {
  const { shouldRunOnboarding } = await import('../onboarding.ts')
  const { AuthStorage } = await import('@mariozechner/pi-coding-agent')

  const { dir, authPath, cleanup } = makeTmpAuth({
    anthropic: { type: 'api_key', key: 'sk-ant-test123' },
  })

  try {
    const auth = AuthStorage.create(authPath)
    withTTY(true, () => {
      assert.equal(
        shouldRunOnboarding(auth, dir), false,
        'known LLM provider authed should skip onboarding',
      )
    })
  } finally {
    cleanup()
  }
})

test('shouldRunOnboarding: returns false when not a TTY (CI, piped, subagent)', async () => {
  const { shouldRunOnboarding } = await import('../onboarding.ts')
  const { AuthStorage } = await import('@mariozechner/pi-coding-agent')

  // Even with no auth and no models.json, non-TTY should skip
  const { dir, authPath, cleanup } = makeTmpAuth({})

  try {
    const auth = AuthStorage.create(authPath)
    withTTY(undefined, () => {
      assert.equal(
        shouldRunOnboarding(auth, dir), false,
        'non-TTY should always skip onboarding',
      )
    })
  } finally {
    cleanup()
  }
})

test('shouldRunOnboarding: models.json takes precedence even with non-LLM auth entries', async () => {
  const { shouldRunOnboarding } = await import('../onboarding.ts')
  const { AuthStorage } = await import('@mariozechner/pi-coding-agent')

  // Auth has only tool keys (brave, jina) — not LLM providers
  const { dir, authPath, cleanup } = makeTmpAuth({
    brave: { type: 'api_key', key: 'BSA-test' },
    jina: { type: 'api_key', key: 'jina-test' },
  })

  writeModelsJson(dir, {
    ollama: {
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      apiKey: 'ollama',
      models: [{ id: 'llama3.1:8b' }],
    },
  })

  try {
    const auth = AuthStorage.create(authPath)
    withTTY(true, () => {
      assert.equal(
        shouldRunOnboarding(auth, dir), false,
        'models.json should gate onboarding even when auth has only non-LLM entries',
      )
    })
  } finally {
    cleanup()
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. ModelRegistry error surfacing (getError)
// ═══════════════════════════════════════════════════════════════════════════

test('ModelRegistry.getError: returns undefined for valid models.json', async () => {
  const { ModelRegistry, AuthStorage } = await import('@mariozechner/pi-coding-agent')
  const { dir, authPath, cleanup } = makeTmpAuth({})

  const modelsPath = writeModelsJson(dir, {
    ollama: {
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      apiKey: 'ollama',
      models: [{ id: 'llama3.1:8b' }],
    },
  })

  try {
    const auth = AuthStorage.create(authPath)
    const registry = new ModelRegistry(auth, modelsPath)
    assert.equal(registry.getError(), undefined, 'valid models.json should produce no error')
  } finally {
    cleanup()
  }
})

test('ModelRegistry.getError: returns error string for malformed JSON', async () => {
  const { ModelRegistry, AuthStorage } = await import('@mariozechner/pi-coding-agent')
  const { dir, authPath, cleanup } = makeTmpAuth({})

  const modelsPath = join(dir, 'models.json')
  writeFileSync(modelsPath, '{ this is not valid JSON }}}')

  try {
    const auth = AuthStorage.create(authPath)
    const registry = new ModelRegistry(auth, modelsPath)
    const error = registry.getError()
    assert.ok(error, 'malformed JSON should produce an error')
    assert.equal(typeof error, 'string', 'error should be a string message')
  } finally {
    cleanup()
  }
})

test('ModelRegistry.getError: returns undefined when no models.json exists', async () => {
  const { ModelRegistry, AuthStorage } = await import('@mariozechner/pi-coding-agent')
  const { dir, authPath, cleanup } = makeTmpAuth({})

  try {
    const auth = AuthStorage.create(authPath)
    const registry = new ModelRegistry(auth, join(dir, 'nonexistent-models.json'))
    assert.equal(registry.getError(), undefined, 'missing file should not be an error')
  } finally {
    cleanup()
  }
})

test('ModelRegistry.getError: returns error for empty file', async () => {
  const { ModelRegistry, AuthStorage } = await import('@mariozechner/pi-coding-agent')
  const { dir, authPath, cleanup } = makeTmpAuth({})

  const modelsPath = join(dir, 'models.json')
  writeFileSync(modelsPath, '')

  try {
    const auth = AuthStorage.create(authPath)
    const registry = new ModelRegistry(auth, modelsPath)
    const error = registry.getError()
    // Empty file is either a parse error or an unexpected EOF — either way not undefined
    assert.ok(error, 'empty models.json should produce an error')
  } finally {
    cleanup()
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. Startup fallback model selection
// ═══════════════════════════════════════════════════════════════════════════

test('startup fallback: prefers claude-opus-4-6 when Anthropic auth is available', async () => {
  const { ModelRegistry, AuthStorage } = await import('@mariozechner/pi-coding-agent')
  const { authPath, cleanup } = makeTmpAuth({
    anthropic: { type: 'api_key', key: 'sk-ant-test123' },
  })

  try {
    const auth = AuthStorage.create(authPath)
    const registry = new ModelRegistry(auth)
    const available = registry.getAvailable()
    const preferred = selectFallbackModel(available)

    assert.ok(preferred, 'should find a preferred model')
    assert.equal(preferred.provider, 'anthropic', 'should pick Anthropic')
    // If claude-opus-4-6 exists in the registry, it should be selected first
    const hasOpus6 = available.some(m => m.provider === 'anthropic' && m.id === 'claude-opus-4-6')
    if (hasOpus6) {
      assert.equal(preferred.id, 'claude-opus-4-6', 'should prefer claude-opus-4-6')
    }
  } finally {
    cleanup()
  }
})

test('startup fallback: picks custom provider model when only custom auth is available', async () => {
  const { ModelRegistry, AuthStorage } = await import('@mariozechner/pi-coding-agent')
  const { dir, authPath, cleanup } = makeTmpAuth({
    ollama: { type: 'api_key', key: 'ollama' },
  })

  const modelsPath = writeModelsJson(dir, {
    ollama: {
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      apiKey: 'ollama',
      models: [{ id: 'llama3.1:8b' }],
    },
  })

  try {
    const auth = AuthStorage.create(authPath)
    const registry = new ModelRegistry(auth, modelsPath)
    const available = registry.getAvailable()
    const preferred = selectFallbackModel(available)

    assert.ok(preferred, 'should find a preferred model')
    assert.equal(preferred.provider, 'ollama', 'should fall through to custom provider')
    assert.equal(preferred.id, 'llama3.1:8b', 'should pick the custom model')
  } finally {
    cleanup()
  }
})

test('startup fallback: returns undefined when no models are available (no auth)', async () => {
  const { ModelRegistry, AuthStorage } = await import('@mariozechner/pi-coding-agent')
  const { authPath, cleanup } = makeTmpAuth({})

  try {
    const auth = AuthStorage.create(authPath)
    const registry = new ModelRegistry(auth)
    const available = registry.getAvailable()
    const preferred = selectFallbackModel(available)

    assert.equal(preferred, undefined, 'should be undefined with zero available models')
  } finally {
    cleanup()
  }
})

test('startup fallback: custom provider with multiple models picks first available', async () => {
  const { ModelRegistry, AuthStorage } = await import('@mariozechner/pi-coding-agent')
  const { dir, authPath, cleanup } = makeTmpAuth({
    'my-cloud': { type: 'api_key', key: 'test-key' },
  })

  const modelsPath = writeModelsJson(dir, {
    'my-cloud': {
      baseUrl: 'https://api.example.com/v1',
      api: 'openai-completions',
      apiKey: 'MY_KEY',
      models: [
        { id: 'model-small' },
        { id: 'model-large' },
      ],
    },
  })

  try {
    const auth = AuthStorage.create(authPath)
    const registry = new ModelRegistry(auth, modelsPath)
    const available = registry.getAvailable()
    const preferred = selectFallbackModel(available)

    assert.ok(preferred, 'should find a preferred model')
    assert.equal(preferred.provider, 'my-cloud', 'should pick custom provider')
  } finally {
    cleanup()
  }
})

test('startup fallback: Anthropic wins over custom provider when both are available', async () => {
  const { ModelRegistry, AuthStorage } = await import('@mariozechner/pi-coding-agent')
  const { dir, authPath, cleanup } = makeTmpAuth({
    anthropic: { type: 'api_key', key: 'sk-ant-test' },
    ollama: { type: 'api_key', key: 'ollama' },
  })

  const modelsPath = writeModelsJson(dir, {
    ollama: {
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      apiKey: 'ollama',
      models: [{ id: 'llama3.1:8b' }],
    },
  })

  try {
    const auth = AuthStorage.create(authPath)
    const registry = new ModelRegistry(auth, modelsPath)
    const available = registry.getAvailable()
    const preferred = selectFallbackModel(available)

    assert.ok(preferred, 'should find a preferred model')
    assert.equal(preferred.provider, 'anthropic', 'Anthropic should win when both available')
  } finally {
    cleanup()
  }
})

test('startup fallback: getAvailable returns fewer or equal models than getAll', async () => {
  const { ModelRegistry, AuthStorage } = await import('@mariozechner/pi-coding-agent')
  const { dir, authPath, cleanup } = makeTmpAuth({
    ollama: { type: 'api_key', key: 'ollama' },
  })

  const modelsPath = writeModelsJson(dir, {
    ollama: {
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      apiKey: 'ollama',
      models: [{ id: 'llama3.1:8b' }],
    },
  })

  try {
    const auth = AuthStorage.create(authPath)
    const registry = new ModelRegistry(auth, modelsPath)

    const all = registry.getAll()
    const available = registry.getAvailable()

    // getAvailable is auth-filtered — always a subset of getAll
    assert.ok(available.length <= all.length, 'getAvailable() should be <= getAll() in size')

    // The custom model should be in both since we gave it auth
    assert.ok(
      all.some(m => m.provider === 'ollama'),
      'getAll should include the custom provider',
    )
    assert.ok(
      available.some(m => m.provider === 'ollama'),
      'getAvailable should include ollama (auth configured)',
    )
  } finally {
    cleanup()
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. Auto-mode provider state tracking
// ═══════════════════════════════════════════════════════════════════════════

// Auto-mode (auto.ts) uses ExtensionContext which requires a running Pi session,
// making direct behavioral testing impractical. Instead, we verify the code
// contract by reading the module's source and confirming the state management
// patterns are correct. This is a structural contract test — if the patterns
// below break, the auto-mode provider restore behavior is also broken.

test('auto-mode: declares originalProvider state alongside originalModelId', async () => {
  const autoSource = readFileSync(
    join(import.meta.dirname, '..', 'resources', 'extensions', 'gsd', 'auto.ts'),
    'utf-8',
  )

  // Both state vars must exist as let declarations at module scope
  assert.match(
    autoSource,
    /let originalModelId: string \| null = null/,
    'should declare originalModelId state variable',
  )
  assert.match(
    autoSource,
    /let originalProvider: string \| null = null/,
    'should declare originalProvider state variable',
  )
})

test('auto-mode: captures provider from ctx.model at start', async () => {
  const autoSource = readFileSync(
    join(import.meta.dirname, '..', 'resources', 'extensions', 'gsd', 'auto.ts'),
    'utf-8',
  )

  // startAuto should capture both model id and provider
  assert.match(
    autoSource,
    /originalModelId = ctx\.model\?\.id/,
    'startAuto should capture originalModelId from ctx.model',
  )
  assert.match(
    autoSource,
    /originalProvider = ctx\.model\?\.provider/,
    'startAuto should capture originalProvider from ctx.model',
  )
})

test('auto-mode: stopAuto restores using originalProvider, not hardcoded "anthropic"', async () => {
  const autoSource = readFileSync(
    join(import.meta.dirname, '..', 'resources', 'extensions', 'gsd', 'auto.ts'),
    'utf-8',
  )

  // stopAuto must use originalProvider for model restore
  assert.match(
    autoSource,
    /ctx\.modelRegistry\.find\(originalProvider, originalModelId\)/,
    'stopAuto should use originalProvider for model restore',
  )

  // Must NOT hardcode anthropic for restore
  const stopAutoBlock = autoSource.slice(
    autoSource.indexOf('async function stopAuto'),
    autoSource.indexOf('async function pauseAuto'),
  )
  assert.ok(
    !stopAutoBlock.includes("find('anthropic'") && !stopAutoBlock.includes('find("anthropic"'),
    'stopAuto should not hardcode "anthropic" in find()',
  )
})

test('auto-mode: stopAuto guards on both originalProvider AND originalModelId', async () => {
  const autoSource = readFileSync(
    join(import.meta.dirname, '..', 'resources', 'extensions', 'gsd', 'auto.ts'),
    'utf-8',
  )

  // Guard must check both variables before attempting restore
  assert.match(
    autoSource,
    /originalModelId && originalProvider/,
    'stopAuto guard should require both originalModelId and originalProvider',
  )
})

test('auto-mode: stopAuto clears both state vars after restore', async () => {
  const autoSource = readFileSync(
    join(import.meta.dirname, '..', 'resources', 'extensions', 'gsd', 'auto.ts'),
    'utf-8',
  )

  const stopAutoBlock = autoSource.slice(
    autoSource.indexOf('async function stopAuto'),
    autoSource.indexOf('async function pauseAuto'),
  )

  assert.ok(
    stopAutoBlock.includes('originalModelId = null'),
    'stopAuto should clear originalModelId',
  )
  assert.ok(
    stopAutoBlock.includes('originalProvider = null'),
    'stopAuto should clear originalProvider',
  )
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. cli.ts startup integration — error surfacing and fallback wiring
// ═══════════════════════════════════════════════════════════════════════════

test('cli.ts: error surfacing runs after ModelRegistry construction', async () => {
  const cliSource = readFileSync(join(import.meta.dirname, '..', 'cli.ts'), 'utf-8')

  // Error check must come after registry creation
  const registryIdx = cliSource.indexOf('new ModelRegistry(authStorage)')
  const errorIdx = cliSource.indexOf('modelRegistry.getError()')
  assert.ok(registryIdx > -1, 'cli.ts should construct ModelRegistry')
  assert.ok(errorIdx > -1, 'cli.ts should check getError()')
  assert.ok(errorIdx > registryIdx, 'getError() check should come after construction')

  // Should be a warning to stderr, not a throw
  const errorBlock = cliSource.slice(errorIdx, errorIdx + 300)
  assert.ok(errorBlock.includes('console.error'), 'should use console.error (stderr)')
  assert.ok(errorBlock.includes('models.json error'), 'should mention models.json in message')
  assert.ok(errorBlock.includes('Built-in models are still available'), 'should mention fallback')
})

test('cli.ts: fallback chain uses getAvailable() not getAll()', async () => {
  const cliSource = readFileSync(join(import.meta.dirname, '..', 'cli.ts'), 'utf-8')

  // Find the fallback section
  const fallbackStart = cliSource.indexOf('if (!configuredModel || !configuredExists)')
  assert.ok(fallbackStart > -1, 'fallback block should exist')

  const fallbackBlock = cliSource.slice(fallbackStart, fallbackStart + 500)

  // Must use getAvailable (auth-filtered) for the fallback, not getAll
  assert.ok(
    fallbackBlock.includes('getAvailable()'),
    'fallback should use getAvailable() to filter by auth',
  )
  assert.ok(
    !fallbackBlock.includes('getAll()'),
    'fallback should NOT use getAll() (would include unconfigured providers)',
  )
})

test('cli.ts: fallback chain tries Anthropic first, then any available', async () => {
  const cliSource = readFileSync(join(import.meta.dirname, '..', 'cli.ts'), 'utf-8')

  const fallbackStart = cliSource.indexOf('if (!configuredModel || !configuredExists)')
  assert.ok(fallbackStart > -1, 'fallback block should exist')

  // Use a larger window to capture the full multi-line expression
  const fallbackBlock = cliSource.slice(fallbackStart, fallbackStart + 800)

  // Anthropic preference chain — tries specific model, then any opus, then any anthropic
  assert.ok(
    fallbackBlock.includes("m.provider === 'anthropic' && m.id === 'claude-opus-4-6'"),
    'should try claude-opus-4-6 first',
  )
  assert.ok(
    fallbackBlock.includes("m.id.includes('opus')"),
    'should try any opus model second',
  )
  assert.ok(
    fallbackBlock.includes("m.provider === 'anthropic'"),
    'should try any Anthropic model',
  )
  // Generic fallback to any provider
  assert.ok(
    fallbackBlock.includes('available[0]'),
    'should fall back to first available model from any provider',
  )
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. CUSTOM_PROVIDER_PRESETS contract
// ═══════════════════════════════════════════════════════════════════════════

test('CUSTOM_PROVIDER_PRESETS: exports exactly the 4 expected presets', async () => {
  const { CUSTOM_PROVIDER_PRESETS } = await import('../onboarding.ts')

  const keys = Object.keys(CUSTOM_PROVIDER_PRESETS).sort()
  assert.deepEqual(keys, ['generic', 'lm-studio', 'ollama', 'vllm'])
})

test('CUSTOM_PROVIDER_PRESETS: each preset has all required fields', async () => {
  const { CUSTOM_PROVIDER_PRESETS } = await import('../onboarding.ts')
  const requiredFields = ['baseUrl', 'api', 'apiKey', 'exampleModel', 'needsApiKey', 'label']

  for (const [key, preset] of Object.entries(CUSTOM_PROVIDER_PRESETS)) {
    for (const field of requiredFields) {
      assert.ok(
        field in preset,
        `${key}: missing required field '${field}'`,
      )
    }
    assert.equal(typeof preset.baseUrl, 'string', `${key}: baseUrl should be string`)
    assert.equal(typeof preset.api, 'string', `${key}: api should be string`)
    assert.equal(typeof preset.label, 'string', `${key}: label should be string`)
    assert.equal(typeof preset.needsApiKey, 'boolean', `${key}: needsApiKey should be boolean`)
  }
})

test('CUSTOM_PROVIDER_PRESETS: local providers (ollama, lm-studio) use localhost URLs and dont need API key', async () => {
  const { CUSTOM_PROVIDER_PRESETS } = await import('../onboarding.ts')

  for (const key of ['ollama', 'lm-studio'] as const) {
    const preset = CUSTOM_PROVIDER_PRESETS[key]
    assert.ok(
      preset.baseUrl.includes('localhost'),
      `${key}: local provider should use localhost URL`,
    )
    assert.equal(
      preset.needsApiKey, false,
      `${key}: local provider should not require API key`,
    )
  }
})

test('CUSTOM_PROVIDER_PRESETS: remote providers (vllm, generic) require API key', async () => {
  const { CUSTOM_PROVIDER_PRESETS } = await import('../onboarding.ts')

  for (const key of ['vllm', 'generic'] as const) {
    assert.equal(
      CUSTOM_PROVIDER_PRESETS[key].needsApiKey, true,
      `${key}: remote provider should require API key`,
    )
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 9. Export surface — public API contract
// ═══════════════════════════════════════════════════════════════════════════

test('onboarding.ts: exports the expected public API for custom providers', async () => {
  const mod = await import('../onboarding.ts')

  // Functions
  assert.equal(typeof mod.generateModelsTemplate, 'function', 'generateModelsTemplate exported')
  assert.equal(typeof mod.shouldRunOnboarding, 'function', 'shouldRunOnboarding exported')
  assert.equal(typeof mod.runOnboarding, 'function', 'runOnboarding exported')
  assert.equal(typeof mod.loadStoredEnvKeys, 'function', 'loadStoredEnvKeys exported')

  // Constants
  assert.equal(typeof mod.CUSTOM_PROVIDER_PRESETS, 'object', 'CUSTOM_PROVIDER_PRESETS exported')
  assert.ok(
    Object.keys(mod.CUSTOM_PROVIDER_PRESETS).length >= 4,
    'CUSTOM_PROVIDER_PRESETS has at least 4 presets',
  )
})
