import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Regression test for #1881: Windows web mode — hardcoded Linux CI path in
 * standalone build.
 *
 * The Next.js standalone build bakes import.meta.url into compiled chunks as
 * the CI runner's absolute Linux path (file:///home/runner/work/gsd-2/gsd-2/…).
 * On Windows, fileURLToPath() rejects this with "File URL path must be
 * absolute". The fix wraps the derivation in safePackageRootFromImportUrl()
 * so the module-level constant never throws, and resolveBridgeRuntimeConfig
 * falls through to the GSD_WEB_PACKAGE_ROOT env var.
 */

import { safePackageRootFromImportUrl } from '../web/safe-import-meta-resolve.ts'

test('safePackageRootFromImportUrl returns a path for a valid native file URL', () => {
  const result = safePackageRootFromImportUrl(import.meta.url)
  assert.ok(result !== null, 'should return a path for a valid native file URL')
  assert.ok(typeof result === 'string')
  assert.ok(result.length > 0)
})

test('safePackageRootFromImportUrl returns null for a non-file URL', () => {
  const result = safePackageRootFromImportUrl('https://example.com/foo/bar.ts')
  assert.equal(result, null)
})

test('safePackageRootFromImportUrl returns null for empty input', () => {
  const result = safePackageRootFromImportUrl('')
  assert.equal(result, null)
})

test('safePackageRootFromImportUrl returns null for malformed URL', () => {
  const result = safePackageRootFromImportUrl('not-a-url')
  assert.equal(result, null)
})

test('safePackageRootFromImportUrl respects ancestorLevels', () => {
  // With 0 levels, should return the directory of the module itself
  const level0 = safePackageRootFromImportUrl(import.meta.url, 0)
  const level2 = safePackageRootFromImportUrl(import.meta.url, 2)
  assert.ok(level0 !== null)
  assert.ok(level2 !== null)
  // level0 is deeper than level2
  assert.ok(level0.length > level2.length)
})

test('bridge-service.ts uses safePackageRootFromImportUrl for DEFAULT_PACKAGE_ROOT', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'web', 'bridge-service.ts'), 'utf-8')
  assert.ok(
    source.includes('safePackageRootFromImportUrl(import.meta.url)'),
    'bridge-service.ts must derive DEFAULT_PACKAGE_ROOT via the safe helper',
  )
  const rawPattern = 'const DEFAULT_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url'
  assert.ok(
    !source.includes(rawPattern),
    'bridge-service.ts must not use raw fileURLToPath for DEFAULT_PACKAGE_ROOT',
  )
})

test('bridge-service resolveBridgeRuntimeConfig falls back to lazy default', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'web', 'bridge-service.ts'), 'utf-8')
  assert.ok(
    source.includes('env.GSD_WEB_PACKAGE_ROOT || getDefaultPackageRoot()'),
    'resolveBridgeRuntimeConfig must fall back to lazy default package root',
  )
})
