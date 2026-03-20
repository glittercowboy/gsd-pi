import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveExtensionEntries, discoverExtensionEntryPaths } from '../extension-discovery.ts'

function makeTempDir(): string {
  const dir = join(tmpdir(), `ext-discovery-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('resolveExtensionEntries', () => {
  test('returns index.ts when no package.json exists', () => {
    const dir = makeTempDir()
    try {
      writeFileSync(join(dir, 'index.ts'), 'export default function() {}')
      const entries = resolveExtensionEntries(dir)
      assert.equal(entries.length, 1)
      assert.ok(entries[0].endsWith('index.ts'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns index.js when no package.json and no index.ts', () => {
    const dir = makeTempDir()
    try {
      writeFileSync(join(dir, 'index.js'), 'module.exports = function() {}')
      const entries = resolveExtensionEntries(dir)
      assert.equal(entries.length, 1)
      assert.ok(entries[0].endsWith('index.js'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns declared extensions from pi.extensions array', () => {
    const dir = makeTempDir()
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        pi: { extensions: ['main.js'] }
      }))
      writeFileSync(join(dir, 'main.js'), 'module.exports = function() {}')
      writeFileSync(join(dir, 'index.js'), 'should not be returned')
      const entries = resolveExtensionEntries(dir)
      assert.equal(entries.length, 1)
      assert.ok(entries[0].endsWith('main.js'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns empty array when pi manifest has no extensions (library opt-out)', () => {
    const dir = makeTempDir()
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: '@gsd/cmux',
        pi: {}
      }))
      writeFileSync(join(dir, 'index.js'), 'export function utility() {}')
      const entries = resolveExtensionEntries(dir)
      assert.equal(entries.length, 0, 'pi: {} should opt out of extension discovery')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns empty array when pi.extensions is an empty array', () => {
    const dir = makeTempDir()
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        pi: { extensions: [] }
      }))
      writeFileSync(join(dir, 'index.js'), 'should not be returned')
      const entries = resolveExtensionEntries(dir)
      assert.equal(entries.length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('falls back to index.ts when package.json has no pi field', () => {
    const dir = makeTempDir()
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'some-pkg' }))
      writeFileSync(join(dir, 'index.ts'), 'export default function() {}')
      const entries = resolveExtensionEntries(dir)
      assert.equal(entries.length, 1)
      assert.ok(entries[0].endsWith('index.ts'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('discoverExtensionEntryPaths', () => {
  test('skips library directories with pi: {} opt-out', () => {
    const root = makeTempDir()
    try {
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
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
