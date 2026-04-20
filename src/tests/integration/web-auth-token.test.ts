/**
 * Tests for the web auth token flow (web/lib/auth.ts).
 *
 * The auth module runs in the browser, so we verify the source code contains
 * the expected patterns for token extraction, persistence, and transmission.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const projectRoot = process.cwd()

// ─── Source contract tests ──────────────────────────────────────────────────

const authSource = readFileSync(join(projectRoot, 'web', 'lib', 'auth.ts'), 'utf-8')

test('auth.ts persists token to localStorage on extraction', () => {
  assert.match(authSource, /localStorage\.setItem/, 'should persist token to localStorage after extracting from hash')
})

test('auth.ts falls back to localStorage when hash is absent', () => {
  assert.match(authSource, /localStorage\.getItem/, 'should read from localStorage when URL hash is empty')
})

test('auth.ts defines an auth storage key constant', () => {
  assert.match(authSource, /AUTH_STORAGE_KEY/, 'should use a named constant for the localStorage key')
})

test('auth.ts clears the URL fragment after token extraction', () => {
  assert.match(authSource, /replaceState/, 'should clear the hash from the address bar')
})

test('auth.ts wraps localStorage calls in try/catch for private browsing', () => {
  // localStorage can throw in private browsing when quota is exceeded
  const setItemIndex = authSource.indexOf('localStorage.setItem')
  const getItemIndex = authSource.indexOf('localStorage.getItem')
  assert.ok(setItemIndex > -1)
  assert.ok(getItemIndex > -1)
  // Both localStorage accesses should be inside try blocks
  const beforeSetItem = authSource.slice(Math.max(0, setItemIndex - 200), setItemIndex)
  const beforeGetItem = authSource.slice(Math.max(0, getItemIndex - 200), getItemIndex)
  assert.match(beforeSetItem, /try\s*\{/, 'localStorage.setItem should be inside a try block')
  assert.match(beforeGetItem, /try\s*\{/, 'localStorage.getItem should be inside a try block')
})

// ─── sendBeacon auth token tests ────────────────────────────────────────────

const appShellSource = readFileSync(join(projectRoot, 'web', 'components', 'gsd', 'app-shell.tsx'), 'utf-8')

test('app-shell.tsx sendBeacon includes auth token as query parameter', () => {
  // sendBeacon cannot set custom headers, so the token must be passed
  // as a _token query parameter for the proxy to accept the request.
  assert.match(appShellSource, /_token=/, 'sendBeacon URL should include _token query parameter')
})

test('app-shell.tsx sendBeacon does not send bare unauthenticated URL', () => {
  // Every sendBeacon to /api/ should include the auth token
  const beaconCalls = appShellSource.match(/sendBeacon\([^)]+\)/g) || []
  for (const call of beaconCalls) {
    if (call.includes('/api/')) {
      // The URL should be constructed with the token, not a bare string literal
      assert.ok(
        !call.includes('"/api/shutdown"') && !call.includes("'/api/shutdown'"),
        `sendBeacon call should not use a bare /api/ URL without auth: ${call}`
      )
    }
  }
})

// ─── middleware.ts contract tests ─────────────────────────────────��─────────

const middlewareSource = readFileSync(join(projectRoot, 'web', 'middleware.ts'), 'utf-8')

test('middleware.ts exports a function named middleware', () => {
  assert.match(middlewareSource, /export function middleware/, 'must export "middleware" for Next.js to activate it')
})

test('middleware.ts accepts _token query parameter as fallback authentication', () => {
  assert.match(middlewareSource, /_token/, 'middleware should support _token query parameter for SSE/sendBeacon')
})

test('middleware.ts validates bearer token from Authorization header', () => {
  assert.match(middlewareSource, /Bearer/, 'middleware should check Authorization: Bearer header')
})

test('middleware.ts skips auth when GSD_WEB_AUTH_TOKEN is not set', () => {
  assert.match(middlewareSource, /GSD_WEB_AUTH_TOKEN/, 'middleware should read GSD_WEB_AUTH_TOKEN from env')
  assert.match(middlewareSource, /NextResponse\.next\(\)/, 'middleware should pass through when no token is configured')
})
