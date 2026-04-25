/**
 * Regression tests: MiniMax (and MiniMax CN) are first-class onboarding
 * providers, and pasting a MiniMax base URL into the custom-OpenAI flow
 * auto-routes the credential to the native MiniMax provider rather than
 * persisting it as an opaque custom endpoint.
 *
 * Previously these tests grep'd `onboarding.ts` for `value: 'minimax'`
 * and identifier names like `detectNativeProviderFromBaseUrl`. That
 * validates nothing: a comment containing `value: 'minimax'` would pass,
 * a renamed-but-equivalent helper would fail, and the actual routing
 * decision was never exercised. We now import the real provider list
 * and the real URL classifier.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  OTHER_PROVIDERS,
  detectNativeProviderFromBaseUrl,
} from '../onboarding.ts'

test('MiniMax is offered in the API-key provider list', () => {
  const values = OTHER_PROVIDERS.map((p) => p.value)
  assert.ok(values.includes('minimax'), `expected minimax in ${values.join(', ')}`)
})

test('MiniMax CN is offered in the API-key provider list', () => {
  const values = OTHER_PROVIDERS.map((p) => p.value)
  assert.ok(values.includes('minimax-cn'))
})

test('MiniMax base URL is routed to the native minimax provider', () => {
  assert.equal(
    detectNativeProviderFromBaseUrl('https://api.minimax.io/v1'),
    'minimax',
  )
  assert.equal(
    detectNativeProviderFromBaseUrl('https://platform.minimax.io/v1'),
    'minimax',
  )
})

test('MiniMax CN base URL is routed to the minimax-cn provider', () => {
  assert.equal(
    detectNativeProviderFromBaseUrl('https://api.minimaxi.com/v1'),
    'minimax-cn',
  )
})

test('non-MiniMax base URLs are not auto-routed', () => {
  for (const url of [
    'https://api.openai.com/v1',
    'https://api.anthropic.com',
    'http://localhost:11434',
    'https://api.groq.com',
  ]) {
    assert.equal(
      detectNativeProviderFromBaseUrl(url),
      null,
      `${url} should not auto-route`,
    )
  }
})

test('malformed base URL returns null instead of throwing', () => {
  assert.equal(detectNativeProviderFromBaseUrl('not a url'), null)
  assert.equal(detectNativeProviderFromBaseUrl(''), null)
})
