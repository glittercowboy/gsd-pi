/**
 * Regression tests for #1709: non-extension libraries in extensions/ directory
 * must not produce spurious "Extension does not export a valid factory function"
 * errors.
 *
 * The defence-in-depth that closed #1709 moved from `loader.ts` (an ad-hoc
 * `isNonExtensionLibrary` predicate) into `resolveExtensionEntries` in
 * `src/extension-discovery.ts`: when a directory's package.json carries a
 * `pi` manifest with no extensions, the discovery step returns `[]` so the
 * loader never attempts a factory call. These tests exercise that real
 * function directly — a prior revision duplicated the algorithm into the
 * test file (dead test: both copies could drift independently).
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { resolveExtensionEntries } from '../extension-discovery.ts'

function makeTempDir(): string {
  const dir = join(tmpdir(), `nonext-lib-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('resolveExtensionEntries — #1709 defence-in-depth', () => {
  test('cmux pattern: pi: {} with an index.js returns no entries', (t) => {
    const root = makeTempDir()
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const libDir = join(root, 'cmux')
    mkdirSync(libDir)
    writeFileSync(
      join(libDir, 'package.json'),
      JSON.stringify({
        name: '@gsd/cmux',
        description:
          'cmux integration library — used by other extensions, not an extension itself',
        pi: {},
      }),
    )
    writeFileSync(join(libDir, 'index.js'), 'module.exports.utility = function() {}')

    assert.deepEqual(
      resolveExtensionEntries(libDir),
      [],
      'pi: {} opts out of discovery so the loader never tries a factory call',
    )
  })

  test('pi.extensions: [] returns no entries', (t) => {
    const root = makeTempDir()
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const libDir = join(root, 'lib-empty')
    mkdirSync(libDir)
    writeFileSync(
      join(libDir, 'package.json'),
      JSON.stringify({ name: 'lib-empty', pi: { extensions: [] } }),
    )
    writeFileSync(join(libDir, 'index.js'), 'module.exports.helper = function() {}')

    assert.deepEqual(resolveExtensionEntries(libDir), [])
  })

  test('pi present with other fields but no extensions → no entries (skills-only library)', (t) => {
    const root = makeTempDir()
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const libDir = join(root, 'lib-with-skills')
    mkdirSync(libDir)
    writeFileSync(
      join(libDir, 'package.json'),
      JSON.stringify({
        name: 'lib-with-skills',
        pi: { skills: ['./my-skill.md'] },
      }),
    )
    writeFileSync(join(libDir, 'index.js'), 'module.exports.helper = function() {}')

    assert.deepEqual(resolveExtensionEntries(libDir), [])
  })

  test('declared pi.extensions entries are resolved to absolute paths', (t) => {
    const root = makeTempDir()
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const extDir = join(root, 'declared-ext')
    mkdirSync(extDir)
    writeFileSync(
      join(extDir, 'package.json'),
      JSON.stringify({ name: 'declared-ext', pi: { extensions: ['./index.js'] } }),
    )
    writeFileSync(join(extDir, 'index.js'), 'module.exports = () => ({})')

    const entries = resolveExtensionEntries(extDir)
    assert.deepEqual(entries, [join(extDir, 'index.js')])
  })

  test('no package.json, no pi manifest → falls back to index.js (pre-#1709 behaviour)', (t) => {
    const root = makeTempDir()
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const extDir = join(root, 'legacy-ext')
    mkdirSync(extDir)
    writeFileSync(join(extDir, 'index.js'), 'module.exports = () => ({})')

    assert.deepEqual(resolveExtensionEntries(extDir), [join(extDir, 'index.js')])
  })

  test('package.json without a pi manifest falls back to index.js discovery', (t) => {
    const root = makeTempDir()
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const extDir = join(root, 'broken-ext')
    mkdirSync(extDir)
    writeFileSync(join(extDir, 'package.json'), JSON.stringify({ name: 'broken-ext' }))
    writeFileSync(join(extDir, 'index.js'), 'module.exports.notAFactory = function() {}')

    // No pi manifest → not a #1709 opt-out. Discovery falls through to
    // index.js; downstream loader surfaces the "not a factory" error
    // (that's exactly what the current behaviour is and what #1709 left
    //  intact for real broken extensions).
    assert.deepEqual(resolveExtensionEntries(extDir), [join(extDir, 'index.js')])
  })

  test('malformed package.json falls back to index.js discovery', (t) => {
    const root = makeTempDir()
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const badDir = join(root, 'bad-json')
    mkdirSync(badDir)
    writeFileSync(join(badDir, 'package.json'), 'not valid json {{{')
    writeFileSync(join(badDir, 'index.js'), 'module.exports = () => ({})')

    // Parse error is caught; discovery continues with index.js fallback.
    assert.deepEqual(resolveExtensionEntries(badDir), [join(badDir, 'index.js')])
  })
})
