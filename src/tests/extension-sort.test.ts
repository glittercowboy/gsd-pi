// GSD-2 — Extension Sort Tests
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { sortExtensionPaths } from '../extension-sort.ts'

function makeTempDir(): string {
  const dir = join(tmpdir(), `ext-sort-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeExtension(baseDir: string, id: string, deps?: string[]): string {
  const extDir = join(baseDir, id)
  mkdirSync(extDir, { recursive: true })
  const manifest = {
    id,
    name: id,
    version: '1.0.0',
    description: 'test extension',
    tier: 'bundled',
    requires: { platform: 'node' },
    ...(deps && deps.length > 0 ? { dependencies: { extensions: deps } } : {}),
  }
  writeFileSync(join(extDir, 'extension-manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(extDir, 'index.ts'), `export default function() {}`)
  return join(extDir, 'index.ts')
}

describe('sortExtensionPaths', () => {
  test('Test 1: no deps — returns alphabetically sorted by ID, zero warnings', (t) => {
    const dir = makeTempDir()
    t.after(() => rmSync(dir, { recursive: true, force: true }))

    const pathC = makeExtension(dir, 'test.c')
    const pathA = makeExtension(dir, 'test.a')
    const pathB = makeExtension(dir, 'test.b')

    const result = sortExtensionPaths([pathC, pathA, pathB])

    assert.equal(result.warnings.length, 0, 'no warnings expected')
    assert.equal(result.sortedPaths.length, 3)
    // A before B before C
    const ids = result.sortedPaths.map(p => basename(dirname(p)))
    assert.deepEqual(ids, ['test.a', 'test.b', 'test.c'])
  })

  test('Test 2: linear chain — B depends on A, A appears before B', (t) => {
    const dir = makeTempDir()
    t.after(() => rmSync(dir, { recursive: true, force: true }))

    const pathA = makeExtension(dir, 'chain.a')
    const pathB = makeExtension(dir, 'chain.b', ['chain.a'])

    const result = sortExtensionPaths([pathB, pathA])

    assert.equal(result.warnings.length, 0, 'no warnings expected')
    assert.equal(result.sortedPaths.length, 2)
    const aIdx = result.sortedPaths.indexOf(pathA)
    const bIdx = result.sortedPaths.indexOf(pathB)
    assert.ok(aIdx < bIdx, 'A must appear before B')
  })

  test('Test 3: diamond — D depends on B and C; B and C depend on A → A first, B/C alphabetically, then D', (t) => {
    const dir = makeTempDir()
    t.after(() => rmSync(dir, { recursive: true, force: true }))

    const pathA = makeExtension(dir, 'diamond.a')
    const pathB = makeExtension(dir, 'diamond.b', ['diamond.a'])
    const pathC = makeExtension(dir, 'diamond.c', ['diamond.a'])
    const pathD = makeExtension(dir, 'diamond.d', ['diamond.b', 'diamond.c'])

    const result = sortExtensionPaths([pathD, pathC, pathB, pathA])

    assert.equal(result.warnings.length, 0, 'no warnings expected')
    assert.equal(result.sortedPaths.length, 4)
    const sorted = result.sortedPaths
    const aIdx = sorted.indexOf(pathA)
    const bIdx = sorted.indexOf(pathB)
    const cIdx = sorted.indexOf(pathC)
    const dIdx = sorted.indexOf(pathD)

    assert.ok(aIdx < bIdx, 'A must be before B')
    assert.ok(aIdx < cIdx, 'A must be before C')
    assert.ok(bIdx < dIdx, 'B must be before D')
    assert.ok(cIdx < dIdx, 'C must be before D')
    assert.ok(bIdx < cIdx, 'B before C alphabetically')
  })

  test('Test 4: missing dep — warns with correct format, extension still in output', (t) => {
    const dir = makeTempDir()
    t.after(() => rmSync(dir, { recursive: true, force: true }))

    const pathA = makeExtension(dir, 'test.a', ['gsd.nonexistent'])

    const result = sortExtensionPaths([pathA])

    assert.equal(result.sortedPaths.length, 1, 'A still in output')
    assert.ok(result.sortedPaths.includes(pathA), 'pathA in sorted output')
    assert.equal(result.warnings.length, 1, 'one warning for missing dep')
    const w = result.warnings[0]
    assert.equal(w.declaringId, 'test.a')
    assert.equal(w.missingId, 'gsd.nonexistent')
    assert.equal(w.message, "Extension 'test.a' declares dependency 'gsd.nonexistent' which is not installed — loading anyway")
  })

  test('Test 5: cycle — A depends on B, B depends on A → both loaded, cycle warnings emitted, appended alphabetically', (t) => {
    const dir = makeTempDir()
    t.after(() => rmSync(dir, { recursive: true, force: true }))

    const pathA = makeExtension(dir, 'cycle.a', ['cycle.b'])
    const pathB = makeExtension(dir, 'cycle.b', ['cycle.a'])

    const result = sortExtensionPaths([pathA, pathB])

    assert.equal(result.sortedPaths.length, 2, 'both extensions in output')
    assert.ok(result.sortedPaths.includes(pathA), 'pathA in output')
    assert.ok(result.sortedPaths.includes(pathB), 'pathB in output')
    assert.ok(result.warnings.length > 0, 'cycle warnings emitted')
    const hasCycleWarning = result.warnings.some(w => w.message.includes('form a dependency cycle'))
    assert.ok(hasCycleWarning, 'cycle warning with correct format')
    // Appended alphabetically: cycle.a before cycle.b
    const aIdx = result.sortedPaths.indexOf(pathA)
    const bIdx = result.sortedPaths.indexOf(pathB)
    assert.ok(aIdx < bIdx, 'cycle participants appended alphabetically')
  })

  test('Test 6: self-dep — A declares dependency on itself → no warning, A still in output', (t) => {
    const dir = makeTempDir()
    t.after(() => rmSync(dir, { recursive: true, force: true }))

    const pathA = makeExtension(dir, 'self.a', ['self.a'])

    const result = sortExtensionPaths([pathA])

    assert.equal(result.sortedPaths.length, 1, 'A still in output')
    assert.ok(result.sortedPaths.includes(pathA), 'pathA in output')
    assert.equal(result.warnings.length, 0, 'no warnings for self-dep')
  })

  test('Test 7: no manifest — paths without extension-manifest.json prepended in input order, zero warnings', (t) => {
    const dir = makeTempDir()
    t.after(() => rmSync(dir, { recursive: true, force: true }))

    // Create two paths without manifests
    const noManifestA = join(dir, 'no-manifest-a', 'index.ts')
    const noManifestB = join(dir, 'no-manifest-b', 'index.ts')
    mkdirSync(join(dir, 'no-manifest-a'), { recursive: true })
    mkdirSync(join(dir, 'no-manifest-b'), { recursive: true })
    writeFileSync(noManifestA, 'export default function() {}')
    writeFileSync(noManifestB, 'export default function() {}')

    const result = sortExtensionPaths([noManifestA, noManifestB])

    assert.equal(result.warnings.length, 0, 'no warnings expected')
    assert.equal(result.sortedPaths.length, 2)
    // Input order preserved
    assert.equal(result.sortedPaths[0], noManifestA)
    assert.equal(result.sortedPaths[1], noManifestB)
  })

  test('Test 8: mixed — no-manifest paths first (input order), then topologically sorted manifest paths', (t) => {
    const dir = makeTempDir()
    t.after(() => rmSync(dir, { recursive: true, force: true }))

    // No-manifest paths
    const noManifestX = join(dir, 'no-manifest-x', 'index.ts')
    mkdirSync(join(dir, 'no-manifest-x'), { recursive: true })
    writeFileSync(noManifestX, 'export default function() {}')

    // Manifest paths: B depends on A
    const pathA = makeExtension(dir, 'mixed.a')
    const pathB = makeExtension(dir, 'mixed.b', ['mixed.a'])

    // Input order: noManifestX, pathB (dependent), pathA (dependency)
    const result = sortExtensionPaths([noManifestX, pathB, pathA])

    assert.equal(result.warnings.length, 0, 'no warnings expected')
    assert.equal(result.sortedPaths.length, 3)

    // no-manifest first
    assert.equal(result.sortedPaths[0], noManifestX, 'no-manifest path must be first')

    // then dependency-ordered manifests: A before B
    const aIdx = result.sortedPaths.indexOf(pathA)
    const bIdx = result.sortedPaths.indexOf(pathB)
    assert.ok(aIdx < bIdx, 'A must be before B (dependency order)')
  })

  test('Test 9: string deps instead of array — treated as empty, no crash, extension in output', (t) => {
    const dir = makeTempDir()
    t.after(() => rmSync(dir, { recursive: true, force: true }))

    const extDir = join(dir, 'bad.deps')
    mkdirSync(extDir, { recursive: true })
    writeFileSync(join(extDir, 'extension-manifest.json'), JSON.stringify({
      id: 'bad.deps', name: 'bad.deps', version: '1.0.0',
      description: 'test', tier: 'bundled', requires: { platform: 'node' },
      dependencies: { extensions: 'not-an-array' }
    }))
    writeFileSync(join(extDir, 'index.ts'), 'export default function() {}')
    const pathBadDeps = join(extDir, 'index.ts')

    const result = sortExtensionPaths([pathBadDeps])

    assert.equal(result.warnings.length, 0, 'no warnings expected for string deps')
    assert.equal(result.sortedPaths.length, 1, 'extension still in output')
    assert.ok(result.sortedPaths.includes(pathBadDeps), 'pathBadDeps in output')
  })

  test('Test 10: null deps — treated as empty, no crash, extension in output', (t) => {
    const dir = makeTempDir()
    t.after(() => rmSync(dir, { recursive: true, force: true }))

    const extDir = join(dir, 'null.deps')
    mkdirSync(extDir, { recursive: true })
    writeFileSync(join(extDir, 'extension-manifest.json'), JSON.stringify({
      id: 'null.deps', name: 'null.deps', version: '1.0.0',
      description: 'test', tier: 'bundled', requires: { platform: 'node' },
      dependencies: { extensions: null }
    }))
    writeFileSync(join(extDir, 'index.ts'), 'export default function() {}')
    const pathNullDeps = join(extDir, 'index.ts')

    const result = sortExtensionPaths([pathNullDeps])

    assert.equal(result.warnings.length, 0, 'no warnings expected for null deps')
    assert.equal(result.sortedPaths.length, 1, 'extension still in output')
    assert.ok(result.sortedPaths.includes(pathNullDeps), 'pathNullDeps in output')
  })

  test('Test 11: numeric deps — treated as empty, no crash, extension in output', (t) => {
    const dir = makeTempDir()
    t.after(() => rmSync(dir, { recursive: true, force: true }))

    const extDir = join(dir, 'num.deps')
    mkdirSync(extDir, { recursive: true })
    writeFileSync(join(extDir, 'extension-manifest.json'), JSON.stringify({
      id: 'num.deps', name: 'num.deps', version: '1.0.0',
      description: 'test', tier: 'bundled', requires: { platform: 'node' },
      dependencies: { extensions: 42 }
    }))
    writeFileSync(join(extDir, 'index.ts'), 'export default function() {}')
    const pathNumDeps = join(extDir, 'index.ts')

    const result = sortExtensionPaths([pathNumDeps])

    assert.equal(result.warnings.length, 0, 'no warnings expected for numeric deps')
    assert.equal(result.sortedPaths.length, 1, 'extension still in output')
    assert.ok(result.sortedPaths.includes(pathNumDeps), 'pathNumDeps in output')
  })

  test('Test 12: chain with missing middle — A depends on B, B depends on missing C', (t) => {
    const dir = makeTempDir()
    t.after(() => rmSync(dir, { recursive: true, force: true }))

    const pathA = makeExtension(dir, 'chain.mid.a', ['chain.mid.b'])
    const pathB = makeExtension(dir, 'chain.mid.b', ['chain.mid.c']) // C is not installed

    const result = sortExtensionPaths([pathA, pathB])

    // Missing dep warning for B→C
    assert.equal(result.warnings.length, 1, 'one missing dep warning for B→C')
    assert.equal(result.warnings[0].declaringId, 'chain.mid.b')
    assert.equal(result.warnings[0].missingId, 'chain.mid.c')

    // No cycle warning
    const hasCycleWarning = result.warnings.some(w => w.message.includes('form a dependency cycle'))
    assert.ok(!hasCycleWarning, 'no cycle warning expected')

    // Both A and B in output
    assert.equal(result.sortedPaths.length, 2)
    assert.ok(result.sortedPaths.includes(pathA), 'pathA in output')
    assert.ok(result.sortedPaths.includes(pathB), 'pathB in output')

    // B before A (B is a dependency of A)
    const aIdx = result.sortedPaths.indexOf(pathA)
    const bIdx = result.sortedPaths.indexOf(pathB)
    assert.ok(bIdx < aIdx, 'B must appear before A')
  })

  test('Test 13: duplicate dependency declarations — A declares B twice, no double-counting', (t) => {
    const dir = makeTempDir()
    t.after(() => rmSync(dir, { recursive: true, force: true }))

    const pathB = makeExtension(dir, 'dup.b')
    const pathA = makeExtension(dir, 'dup.a', ['dup.b', 'dup.b'])

    const result = sortExtensionPaths([pathA, pathB])

    // B before A
    assert.equal(result.sortedPaths.length, 2)
    const aIdx = result.sortedPaths.indexOf(pathA)
    const bIdx = result.sortedPaths.indexOf(pathB)
    assert.ok(bIdx < aIdx, 'B must appear before A')

    // No cycle warning
    const hasCycleWarning = result.warnings.some(w => w.message.includes('form a dependency cycle'))
    assert.ok(!hasCycleWarning, 'no cycle warning expected for duplicate deps')
  })

  test('Test 14: empty paths array — returns empty result with no warnings', (_t) => {
    const result = sortExtensionPaths([])

    assert.equal(result.warnings.length, 0, 'no warnings for empty input')
    assert.equal(result.sortedPaths.length, 0, 'no paths in output')
  })
})
