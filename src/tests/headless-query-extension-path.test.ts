/**
 * Regression test for #3471: headless-query must load extensions from
 * the synced agent directory when populated, not directly from
 * src/resources/.
 *
 * Previously this test grep'd `headless-query.ts` for one of two literal
 * identifiers — either branch (e.g. inside a comment) was sufficient to
 * pass. The path-selection logic is now an exported pure function so we
 * can drive it with a fixture filesystem.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  resolveGsdAgentExtensionsDir,
  shouldUseAgentExtensionsDir,
} from '../headless-query.ts'

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `headless-query-ext-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

test('GSD_AGENT_DIR overrides homedir-based agent dir resolution', () => {
  const root = resolveGsdAgentExtensionsDir({ GSD_AGENT_DIR: '/some/agent' })
  assert.equal(root, join('/some/agent', 'extensions', 'gsd'))
})

test('agent dir is selected when state.ts exists under it (#3471)', (t) => {
  const root = makeTempDir()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const extDir = join(root, 'extensions', 'gsd')
  mkdirSync(extDir, { recursive: true })
  writeFileSync(join(extDir, 'state.ts'), '// fixture')

  const result = shouldUseAgentExtensionsDir({ env: { GSD_AGENT_DIR: root } })
  assert.equal(result.agentDir, extDir)
  assert.equal(result.useAgentDir, true)
})

test('agent dir is rejected when state.ts is absent (falls back to bundled)', (t) => {
  const root = makeTempDir()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // GSD_AGENT_DIR exists but is unpopulated — exactly the state pre-#3471
  // where headless-query silently fell back to src/resources.
  const result = shouldUseAgentExtensionsDir({ env: { GSD_AGENT_DIR: root } })
  assert.equal(result.useAgentDir, false)
})

test('fileExists callback drives the decision (no real fs required)', () => {
  const calls: string[] = []
  const result = shouldUseAgentExtensionsDir({
    env: { GSD_AGENT_DIR: '/agent' },
    fileExists: (p) => {
      calls.push(p)
      return true
    },
  })
  assert.equal(result.useAgentDir, true)
  assert.deepEqual(calls, [join('/agent', 'extensions', 'gsd', 'state.ts')])
})
