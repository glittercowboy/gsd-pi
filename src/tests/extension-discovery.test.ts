// GSD-2 — Extension Discovery Tests
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveExtensionEntries, discoverExtensionEntryPaths, mergeExtensionEntryPaths } from '../extension-discovery.ts'

function makeTempDir(): string {
  const dir = join(tmpdir(), `ext-discovery-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('resolveExtensionEntries', () => {
  test('returns index.ts when no package.json exists', (t) => {
    const dir = makeTempDir()
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'index.ts'), 'export default function() {}')
    const entries = resolveExtensionEntries(dir)
    assert.equal(entries.length, 1)
    assert.ok(entries[0].endsWith('index.ts'))
  })

  test('returns index.js when no package.json and no index.ts', (t) => {
    const dir = makeTempDir()
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'index.js'), 'module.exports = function() {}')
    const entries = resolveExtensionEntries(dir)
    assert.equal(entries.length, 1)
    assert.ok(entries[0].endsWith('index.js'))
  })

  test('returns declared extensions from pi.extensions array', (t) => {
    const dir = makeTempDir()
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      pi: { extensions: ['main.js'] }
    }))
    writeFileSync(join(dir, 'main.js'), 'module.exports = function() {}')
    writeFileSync(join(dir, 'index.js'), 'should not be returned')
    const entries = resolveExtensionEntries(dir)
    assert.equal(entries.length, 1)
    assert.ok(entries[0].endsWith('main.js'))
  })

  test('returns empty array when pi manifest has no extensions (library opt-out)', (t) => {
    const dir = makeTempDir()
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: '@gsd/cmux',
      pi: {}
    }))
    writeFileSync(join(dir, 'index.js'), 'export function utility() {}')
    const entries = resolveExtensionEntries(dir)
    assert.equal(entries.length, 0, 'pi: {} should opt out of extension discovery')
  })

  test('returns empty array when pi.extensions is an empty array', (t) => {
    const dir = makeTempDir()
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      pi: { extensions: [] }
    }))
    writeFileSync(join(dir, 'index.js'), 'should not be returned')
    const entries = resolveExtensionEntries(dir)
    assert.equal(entries.length, 0)
  })

  test('falls back to index.ts when package.json has no pi field', (t) => {
    const dir = makeTempDir()
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'some-pkg' }))
    writeFileSync(join(dir, 'index.ts'), 'export default function() {}')
    const entries = resolveExtensionEntries(dir)
    assert.equal(entries.length, 1)
    assert.ok(entries[0].endsWith('index.ts'))
  })
})

describe('discoverExtensionEntryPaths', () => {
  test('falls back to index.ts detection when extension directory has malformed package.json', (t) => {
    const root = makeTempDir()
    t.after(() => rmSync(root, { recursive: true, force: true }))

    const extDir = join(root, 'malformed-ext')
    mkdirSync(extDir)
    // Write deliberately invalid JSON — resolveExtensionEntries catches the parse error and falls through
    writeFileSync(join(extDir, 'package.json'), '{ "pi": { INVALID')
    writeFileSync(join(extDir, 'index.ts'), 'export default function() {}')

    const paths = discoverExtensionEntryPaths(root)
    assert.equal(paths.length, 1, 'should discover the extension via index.ts fallback')
    assert.ok(paths[0].includes('malformed-ext'), 'discovered path should be from malformed-ext')
    assert.ok(paths[0].endsWith('index.ts'), 'should have fallen back to index.ts')
  })

  test('skips library directories with pi: {} opt-out', (t) => {
    const root = makeTempDir()
    t.after(() => rmSync(root, { recursive: true, force: true }));
    // Real extension
    const extDir = join(root, 'my-ext')
    mkdirSync(extDir)
    writeFileSync(join(extDir, 'index.js'), 'module.exports = function() {}')

    // Library with opt-out (like cmux)
    const libDir = join(root, 'cmux')
    mkdirSync(libDir)
    writeFileSync(join(libDir, 'package.json'), JSON.stringify({ pi: {} }))
    writeFileSync(join(libDir, 'index.js'), 'export function utility() {}')

    const paths = discoverExtensionEntryPaths(root)
    assert.equal(paths.length, 1, 'should discover my-ext but skip cmux')
    assert.ok(paths[0].includes('my-ext'))
    assert.ok(!paths.some(p => p.includes('cmux')), 'cmux should not be discovered')
  })
})

describe('mergeExtensionEntryPaths', () => {
  function makeManifest(id: string): string {
    return JSON.stringify({ id, name: id, version: '1.0.0', description: 'test', tier: 'bundled', requires: { platform: 'node' } })
  }

  test('returns bundledPaths unchanged when installedExtDir does not exist', (t) => {
    const nonExistent = join(tmpdir(), `nonexistent-${Date.now()}`)
    const bundled = ['/fake/path/ext-a/index.ts']
    const result = mergeExtensionEntryPaths(bundled, nonExistent)
    assert.deepEqual(result, bundled)
  })

  test('returns bundledPaths unchanged when installedExtDir is empty', (t) => {
    const installedDir = join(tmpdir(), `installed-empty-${Date.now()}`)
    t.after(() => rmSync(installedDir, { recursive: true, force: true }))
    mkdirSync(installedDir, { recursive: true })
    const bundled = ['/fake/path/ext-a/index.ts']
    const result = mergeExtensionEntryPaths(bundled, installedDir)
    assert.deepEqual(result, bundled)
  })

  test('appends installed extension entries to bundled paths when IDs differ', (t) => {
    const root = join(tmpdir(), `installed-additive-${Date.now()}`)
    t.after(() => rmSync(root, { recursive: true, force: true }))

    // Create installed extension with different ID
    const installedDir = join(root, 'installed')
    const newExtDir = join(installedDir, 'new-extension')
    mkdirSync(newExtDir, { recursive: true })
    writeFileSync(join(newExtDir, 'extension-manifest.json'), makeManifest('new-extension'))
    writeFileSync(join(newExtDir, 'index.ts'), 'export default function() {}')

    const bundled = ['/fake/bundled/ext-a/index.ts']
    const result = mergeExtensionEntryPaths(bundled, installedDir)

    assert.equal(result.length, 2, 'should have 1 bundled + 1 installed')
    assert.ok(result.includes('/fake/bundled/ext-a/index.ts'), 'bundled entry should be preserved')
    assert.ok(result.some(p => p.includes('new-extension')), 'installed extension should be appended')
  })

  test('removes bundled entry when installed extension has same manifest ID (LOADER-02 precedence)', (t) => {
    const root = join(tmpdir(), `installed-shadow-${Date.now()}`)
    t.after(() => rmSync(root, { recursive: true, force: true }))

    // Create bundled extension (just a fake entry path pointing to a real location with manifest)
    const bundledDir = join(root, 'bundled')
    const bundledExtDir = join(bundledDir, 'my-ext')
    mkdirSync(bundledExtDir, { recursive: true })
    writeFileSync(join(bundledExtDir, 'extension-manifest.json'), makeManifest('my-ext'))
    writeFileSync(join(bundledExtDir, 'index.ts'), 'export default function() {}')
    const bundledEntryPath = join(bundledExtDir, 'index.ts')

    // Create installed extension with same ID
    const installedDir = join(root, 'installed')
    const installedExtDir = join(installedDir, 'my-ext-installed')
    mkdirSync(installedExtDir, { recursive: true })
    writeFileSync(join(installedExtDir, 'extension-manifest.json'), makeManifest('my-ext'))
    writeFileSync(join(installedExtDir, 'index.ts'), 'export default function() {}')

    const result = mergeExtensionEntryPaths([bundledEntryPath], installedDir)

    assert.equal(result.length, 1, 'only one entry: installed takes precedence over bundled')
    assert.ok(!result.includes(bundledEntryPath), 'bundled entry should be excluded')
    assert.ok(result.some(p => p.includes('my-ext-installed')), 'installed entry should be present')
  })

  test('silently skips installed extension with corrupt/unreadable manifest (invalid JSON)', (t) => {
    const root = join(tmpdir(), `installed-corrupt-manifest-${Date.now()}`)
    t.after(() => rmSync(root, { recursive: true, force: true }))

    const installedDir = join(root, 'installed')
    const corruptExtDir = join(installedDir, 'corrupt-ext')
    mkdirSync(corruptExtDir, { recursive: true })
    // Write deliberately invalid JSON to extension-manifest.json
    writeFileSync(join(corruptExtDir, 'extension-manifest.json'), '{ "id": "corrupt-ext" INVALID JSON')
    writeFileSync(join(corruptExtDir, 'index.ts'), 'export default function() {}')

    const bundled = ['/fake/bundled/ext-a/index.ts']
    const result = mergeExtensionEntryPaths(bundled, installedDir)

    assert.deepEqual(result, bundled, 'corrupt manifest should be silently skipped, bundled paths unchanged')
  })

  test('skips installed extension directory with no index.ts/index.js even if manifest is valid', (t) => {
    const root = join(tmpdir(), `installed-no-entries-${Date.now()}`)
    t.after(() => rmSync(root, { recursive: true, force: true }))

    const installedDir = join(root, 'installed')
    const emptyExtDir = join(installedDir, 'empty-ext')
    mkdirSync(emptyExtDir, { recursive: true })
    // Valid manifest but no index.ts/index.js
    writeFileSync(join(emptyExtDir, 'extension-manifest.json'), makeManifest('empty-ext'))

    const bundled = ['/fake/bundled/ext-a/index.ts']
    const result = mergeExtensionEntryPaths(bundled, installedDir)

    assert.deepEqual(result, bundled, 'extension with no entry files should be skipped even if manifest is valid')
  })

  test('handles multiple installed extensions, some shadowing, some additive', (t) => {
    const root = join(tmpdir(), `installed-mixed-${Date.now()}`)
    t.after(() => rmSync(root, { recursive: true, force: true }))

    // Create two bundled extensions
    const bundledDir = join(root, 'bundled')
    const bundledExtA = join(bundledDir, 'ext-a')
    const bundledExtB = join(bundledDir, 'ext-b')
    mkdirSync(bundledExtA, { recursive: true })
    mkdirSync(bundledExtB, { recursive: true })
    writeFileSync(join(bundledExtA, 'extension-manifest.json'), makeManifest('ext-a'))
    writeFileSync(join(bundledExtA, 'index.ts'), 'export default function() {}')
    writeFileSync(join(bundledExtB, 'extension-manifest.json'), makeManifest('ext-b'))
    writeFileSync(join(bundledExtB, 'index.ts'), 'export default function() {}')
    const bundledPathA = join(bundledExtA, 'index.ts')
    const bundledPathB = join(bundledExtB, 'index.ts')

    // Create installed extensions: one shadows ext-a, one is new
    const installedDir = join(root, 'installed')
    const installedExtA = join(installedDir, 'ext-a-installed')
    const installedExtNew = join(installedDir, 'ext-new')
    mkdirSync(installedExtA, { recursive: true })
    mkdirSync(installedExtNew, { recursive: true })
    writeFileSync(join(installedExtA, 'extension-manifest.json'), makeManifest('ext-a'))
    writeFileSync(join(installedExtA, 'index.ts'), 'export default function() {}')
    writeFileSync(join(installedExtNew, 'extension-manifest.json'), makeManifest('ext-new'))
    writeFileSync(join(installedExtNew, 'index.ts'), 'export default function() {}')

    const result = mergeExtensionEntryPaths([bundledPathA, bundledPathB], installedDir)

    assert.equal(result.length, 3, 'ext-b preserved, ext-a-installed and ext-new added')
    assert.ok(!result.includes(bundledPathA), 'bundled ext-a should be shadowed')
    assert.ok(result.includes(bundledPathB), 'bundled ext-b should be preserved')
    assert.ok(result.some(p => p.includes('ext-a-installed')), 'installed ext-a should replace bundled')
    assert.ok(result.some(p => p.includes('ext-new')), 'new installed ext should be added')
  })
})
