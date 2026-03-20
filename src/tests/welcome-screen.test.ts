/**
 * Welcome screen unit tests.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { printWelcomeScreen } from '../../dist/welcome-screen.js'

function capture(opts: Parameters<typeof printWelcomeScreen>[0]): string {
  const chunks: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  ;(process.stderr as any).write = (chunk: string) => { chunks.push(chunk); return true }
  const origIsTTY = (process.stderr as any).isTTY
  ;(process.stderr as any).isTTY = true

  try {
    printWelcomeScreen(opts)
  } finally {
    ;(process.stderr as any).write = original
    ;(process.stderr as any).isTTY = origIsTTY
  }

  return chunks.join('')
}

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

test('renders GSD logo', () => {
  const out = strip(capture({ version: '1.0.0' }))
  assert.ok(out.includes('██'), 'logo block characters missing')
})

test('renders version', () => {
  const out = strip(capture({ version: '2.38.0' }))
  assert.ok(out.includes('v2.38.0'), 'version missing')
  assert.ok(out.includes('Get Shit Done'), 'brand name missing')
})

test('renders model and provider', () => {
  const out = strip(capture({ version: '1.0.0', modelName: 'claude-opus-4-6', provider: 'Anthropic' }))
  assert.ok(out.includes('claude-opus-4-6'), 'model name missing')
  assert.ok(out.includes('Anthropic'), 'provider missing')
})

test('renders cwd hint', () => {
  const out = strip(capture({ version: '1.0.0' }))
  assert.ok(out.includes('/gsd to begin'), 'hint line missing')
})

test('skips when not a TTY', () => {
  const chunks: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  ;(process.stderr as any).write = (chunk: string) => { chunks.push(chunk); return true }
  const origIsTTY = (process.stderr as any).isTTY
  ;(process.stderr as any).isTTY = false

  try {
    printWelcomeScreen({ version: '1.0.0' })
    assert.equal(chunks.join(''), '', 'should produce no output when not TTY')
  } finally {
    ;(process.stderr as any).write = original
    ;(process.stderr as any).isTTY = origIsTTY
  }
})

test('renders without model or provider', () => {
  const out = strip(capture({ version: '3.0.0' }))
  assert.ok(out.includes('v3.0.0'), 'version missing when no model provided')
})
