/**
 * Welcome screen unit tests.
 *
 * Verifies layout, content, and edge-case behaviour without requiring a TTY.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Import the compiled module under test
import { printWelcomeScreen } from '../../dist/welcome-screen.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Capture stderr output from printWelcomeScreen */
function capture(opts: Parameters<typeof printWelcomeScreen>[0], cols = 90): string {
  const chunks: string[] = []
  const original = process.stderr.write.bind(process.stderr)

  // Temporarily stub stderr.write
  ;(process.stderr as any).write = (chunk: string) => {
    chunks.push(chunk)
    return true
  }
  // Force TTY + columns
  const origIsTTY = (process.stderr as any).isTTY
  const origColumns = (process.stderr as any).columns
  ;(process.stderr as any).isTTY = true
  ;(process.stderr as any).columns = cols

  try {
    printWelcomeScreen(opts)
  } finally {
    ;(process.stderr as any).write = original
    ;(process.stderr as any).isTTY = origIsTTY
    ;(process.stderr as any).columns = origColumns
  }

  return chunks.join('')
}

/** Strip ANSI escape codes */
function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('renders box borders', () => {
  const out = strip(capture({ version: '1.0.0' }))
  assert.ok(out.includes('┌'), 'missing top-left corner')
  assert.ok(out.includes('┐'), 'missing top-right corner')
  assert.ok(out.includes('└'), 'missing bottom-left corner')
  assert.ok(out.includes('┘'), 'missing bottom-right corner')
  assert.ok(out.includes('┴'), 'missing bottom-tee divider')
})

test('renders version in title bar', () => {
  const out = strip(capture({ version: '2.38.0' }))
  assert.ok(out.includes('GSD v2.38.0'), `version not found in output:\n${out}`)
})

test('renders welcome back when hasPriorSessions=true', () => {
  const out = strip(capture({ version: '1.0.0', hasPriorSessions: true }))
  assert.ok(out.includes('Welcome back'), 'should say "Welcome back"')
})

test('renders plain Welcome when hasPriorSessions=false', () => {
  const out = strip(capture({ version: '1.0.0', hasPriorSessions: false }))
  assert.ok(out.includes('Welcome,'), 'should say "Welcome,"')
  assert.ok(!out.includes('Welcome back'), 'should NOT say "Welcome back"')
})

test('renders model and provider', () => {
  const out = strip(capture({ version: '1.0.0', modelName: 'claude-opus-4-6', provider: 'Anthropic' }))
  assert.ok(out.includes('claude-opus-4-6'), 'model name not found')
  assert.ok(out.includes('Anthropic'), 'provider not found')
})

test('renders GSD tips', () => {
  const out = strip(capture({ version: '1.0.0' }))
  assert.ok(out.includes('/gsd new-project'), 'tip /gsd new-project missing')
  assert.ok(out.includes('/gsd doctor'), 'tip /gsd doctor missing')
  assert.ok(out.includes('/gsd progress'), 'tip /gsd progress missing')
  assert.ok(out.includes('/gsd help'), 'tip /gsd help missing')
})

test('shows "No recent activity" when no sessionsDir', () => {
  const out = strip(capture({ version: '1.0.0' }))
  assert.ok(out.includes('No recent activity'), 'expected "No recent activity"')
})

test('shows "No recent activity" when sessionsDir is empty', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-ws-test-'))
  try {
    const out = strip(capture({ version: '1.0.0', sessionsDir: tmp }))
    assert.ok(out.includes('No recent activity'), 'expected "No recent activity" for empty dir')
  } finally {
    rmSync(tmp, { recursive: true })
  }
})

test('shows recent session preview from jsonl', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-ws-test-'))
  try {
    const cwd = process.cwd()
    const safePath = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
    const sessionDir = join(tmp, safePath)
    mkdirSync(sessionDir, { recursive: true })

    const sessionData = JSON.stringify({
      message: { content: [{ type: 'text', text: 'Fix the authentication bug in login flow' }] },
    })
    writeFileSync(join(sessionDir, 'session-001.jsonl'), sessionData + '\n')

    const out = strip(capture({ version: '1.0.0', sessionsDir: tmp }))
    assert.ok(
      out.includes('Fix the authentication bug'),
      `expected session preview in output:\n${out}`,
    )
  } finally {
    rmSync(tmp, { recursive: true })
  }
})

test('silently skips render when not a TTY', () => {
  const chunks: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  ;(process.stderr as any).write = (chunk: string) => { chunks.push(chunk); return true }
  const origIsTTY = (process.stderr as any).isTTY
  ;(process.stderr as any).isTTY = false

  try {
    printWelcomeScreen({ version: '1.0.0' })
    assert.equal(chunks.join(''), '', 'should produce no output when not a TTY')
  } finally {
    ;(process.stderr as any).write = original
    ;(process.stderr as any).isTTY = origIsTTY
  }
})

test('silently skips render when terminal is too narrow', () => {
  const out = capture({ version: '1.0.0' }, 40)  // below 60-col minimum
  assert.equal(out, '', 'should produce no output when terminal < 60 cols')
})
