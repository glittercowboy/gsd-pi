import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const projectRoot = process.cwd()

test('createAgentSession flushes queued extension providers before session restore and model selection', () => {
  const source = readFileSync(join(projectRoot, 'packages', 'pi-coding-agent', 'src', 'core', 'sdk.ts'), 'utf-8')

  const flushCommentIndex = source.indexOf('// Flush provider registrations queued during extension loading so that')
  const runtimeIndex = source.indexOf('const { runtime: extensionRuntime } = resourceLoader.getExtensions()', flushCommentIndex)
  const registerIndex = source.indexOf('modelRegistry.registerProvider(name, config)', runtimeIndex)
  const clearIndex = source.indexOf('extensionRuntime.pendingProviderRegistrations = []', registerIndex)
  const restoreIndex = source.indexOf('const existingSession = sessionManager.buildSessionContext()', clearIndex)
  const modelSelectionIndex = source.indexOf('const result = await findInitialModel({', restoreIndex)

  assert.ok(flushCommentIndex !== -1, 'sdk.ts documents the pre-selection provider flush')
  assert.ok(runtimeIndex > flushCommentIndex, 'sdk.ts reads queued provider registrations from the resource loader runtime')
  assert.ok(registerIndex > runtimeIndex, 'sdk.ts registers queued providers into the model registry')
  assert.ok(clearIndex > registerIndex, 'sdk.ts clears queued providers after registration')
  assert.ok(restoreIndex > clearIndex, 'sdk.ts restores session state only after extension providers are visible')
  assert.ok(modelSelectionIndex > clearIndex, 'sdk.ts selects the initial model only after extension providers are visible')
})
