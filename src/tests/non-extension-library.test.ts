/**
 * Regression tests for #1709: non-extension libraries in extensions/ directory
 * must not produce spurious "Extension does not export a valid factory function" errors.
 *
 * These tests verify the defense-in-depth behavior added to the extension loader:
 * when a module fails to export a factory function, the loader checks the parent
 * directory's package.json for a "pi" manifest opt-out before reporting an error.
 *
 * The isNonExtensionLibrary logic is replicated here to test the algorithm
 * independently of the loader's heavy dependency tree.
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { tmpdir } from 'node:os'

function makeTempDir(): string {
  const dir = join(tmpdir(), `nonext-lib-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Replica of the isNonExtensionLibrary function from loader.ts.
 * Tests the same algorithm to verify correctness without importing the loader.
 */
function isNonExtensionLibrary(resolvedPath: string): boolean {
  let dir = dirname(resolvedPath)
  const root = parse(dir).root
  while (dir !== root) {
    const packageJsonPath = join(dir, 'package.json')
    if (existsSync(packageJsonPath)) {
      try {
        const content = readFileSync(packageJsonPath, 'utf-8')
        const pkg = JSON.parse(content)
        if (pkg.pi && typeof pkg.pi === 'object') {
          const extensions = pkg.pi.extensions
          if (!Array.isArray(extensions) || extensions.length === 0) {
            return true
          }
        }
      } catch {
        // Malformed package.json
      }
      break
    }
    dir = dirname(dir)
  }
  return false
}

describe('isNonExtensionLibrary — defense-in-depth for #1709', () => {
  test('returns true for a file inside a directory with pi: {} (cmux pattern)', () => {
    const root = makeTempDir()
    try {
      const libDir = join(root, 'cmux')
      mkdirSync(libDir)
      writeFileSync(join(libDir, 'package.json'), JSON.stringify({
        name: '@gsd/cmux',
        description: 'cmux integration library — used by other extensions, not an extension itself',
        pi: {}
      }))
      writeFileSync(join(libDir, 'index.js'), 'module.exports.utility = function() {};')

      assert.equal(
        isNonExtensionLibrary(join(libDir, 'index.js')),
        true,
        'cmux with pi: {} should be identified as a non-extension library'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('returns true for pi.extensions as empty array', () => {
    const root = makeTempDir()
    try {
      const libDir = join(root, 'lib-empty')
      mkdirSync(libDir)
      writeFileSync(join(libDir, 'package.json'), JSON.stringify({
        name: 'lib-empty',
        pi: { extensions: [] }
      }))
      writeFileSync(join(libDir, 'index.js'), 'module.exports.helper = function() {};')

      assert.equal(
        isNonExtensionLibrary(join(libDir, 'index.js')),
        true,
        'pi: { extensions: [] } should be identified as non-extension library'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('returns false for a directory without pi manifest (broken extension)', () => {
    const root = makeTempDir()
    try {
      const extDir = join(root, 'broken-ext')
      mkdirSync(extDir)
      writeFileSync(join(extDir, 'package.json'), JSON.stringify({
        name: 'broken-ext'
      }))
      writeFileSync(join(extDir, 'index.js'), 'module.exports.notAFactory = function() {};')

      assert.equal(
        isNonExtensionLibrary(join(extDir, 'index.js')),
        false,
        'directory without pi manifest should NOT be identified as non-extension library'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('returns false when pi.extensions declares actual entries', () => {
    const root = makeTempDir()
    try {
      const extDir = join(root, 'declared-ext')
      mkdirSync(extDir)
      writeFileSync(join(extDir, 'package.json'), JSON.stringify({
        name: 'declared-ext',
        pi: { extensions: ['./index.js'] }
      }))
      writeFileSync(join(extDir, 'index.js'), 'module.exports.notAFactory = function() {};')

      assert.equal(
        isNonExtensionLibrary(join(extDir, 'index.js')),
        false,
        'directory with declared extensions should NOT be identified as non-extension library'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('returns false when no package.json exists at all', () => {
    const root = makeTempDir()
    try {
      const noManifest = join(root, 'no-manifest')
      mkdirSync(noManifest)
      writeFileSync(join(noManifest, 'index.js'), 'module.exports = {};')

      // Should return false since there is no package.json with pi manifest
      // (it will find the temp dir's absence of package.json and return false)
      assert.equal(
        isNonExtensionLibrary(join(noManifest, 'index.js')),
        false,
        'directory without any package.json should NOT be identified as non-extension library'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('handles malformed package.json gracefully', () => {
    const root = makeTempDir()
    try {
      const badDir = join(root, 'bad-json')
      mkdirSync(badDir)
      writeFileSync(join(badDir, 'package.json'), 'not valid json {{{')
      writeFileSync(join(badDir, 'index.js'), 'module.exports = {};')

      assert.equal(
        isNonExtensionLibrary(join(badDir, 'index.js')),
        false,
        'malformed package.json should not cause a crash and should return false'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('pi manifest with other fields but no extensions still opts out', () => {
    const root = makeTempDir()
    try {
      const libDir = join(root, 'lib-with-skills')
      mkdirSync(libDir)
      writeFileSync(join(libDir, 'package.json'), JSON.stringify({
        name: 'lib-with-skills',
        pi: { skills: ['./my-skill.md'] }
      }))
      writeFileSync(join(libDir, 'index.js'), 'module.exports.helper = function() {};')

      assert.equal(
        isNonExtensionLibrary(join(libDir, 'index.js')),
        true,
        'pi manifest with skills but no extensions should be identified as non-extension library'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
