import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const projectRoot = process.cwd()

test('cli list-models loads extension providers before reading available models', () => {
  const source = readFileSync(join(projectRoot, 'src', 'cli.ts'), 'utf-8')
  const branchStart = source.indexOf('if (cliFlags.listModels !== undefined) {')
  assert.notEqual(branchStart, -1, 'cli.ts contains a list-models branch')

  const loaderIndex = source.indexOf('const listModelsLoader = new DefaultResourceLoader({', branchStart)
  const registerIndex = source.indexOf('modelRegistry.registerProvider(name, config)', loaderIndex)
  const clearIndex = source.indexOf('listModelsExtensions.runtime.pendingProviderRegistrations = []', registerIndex)
  const modelsIndex = source.indexOf('const models = modelRegistry.getAvailable()', clearIndex)

  assert.ok(loaderIndex > branchStart, 'list-models creates a resource loader inside the branch')
  assert.ok(registerIndex > loaderIndex, 'list-models flushes extension provider registrations into the model registry')
  assert.ok(clearIndex > registerIndex, 'list-models clears the queued registrations after flushing them')
  assert.ok(modelsIndex > clearIndex, 'list-models reads available models only after extension providers are visible')
})

test('cli validates configured model only after flushing extension providers and before creating sessions', () => {
  const source = readFileSync(join(projectRoot, 'src', 'cli.ts'), 'utf-8')
  const validationNeedle = 'validateConfiguredModel(modelRegistry, settingsManager)'
  const validationCalls = [...source.matchAll(new RegExp(validationNeedle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))]

  assert.equal(validationCalls.length, 2, 'cli.ts validates the configured model in both startup paths')

  let searchFrom = 0
  for (const match of validationCalls) {
    const validationIndex = match.index ?? -1
    const flushIndex = source.lastIndexOf('runtime.pendingProviderRegistrations = []', validationIndex)
    const createIndex = source.indexOf('const { session, extensionsResult } = await createAgentSession({', validationIndex)

    assert.ok(flushIndex >= searchFrom, 'validation happens after a pending-provider flush in its startup block')
    assert.ok(validationIndex > flushIndex, 'validation runs after extension providers are registered')
    assert.ok(createIndex > validationIndex, 'validation runs before session creation')

    searchFrom = validationIndex + 1
  }
})
