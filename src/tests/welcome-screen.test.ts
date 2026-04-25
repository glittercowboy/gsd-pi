/**
 * Welcome screen unit tests.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

test('renders GSD project state or fallback hint', (t) => {
  // Model/provider intentionally removed from the welcome screen — they live
  // in the persistent footer. Without .gsd/STATE.md present the welcome
  // should surface the "No active GSD project" fallback instead.
  // chdir into an empty tmp dir so the fallback path is actually exercised
  // regardless of what the repo we're running from has in .gsd/.
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-welcome-fallback-'))
  const origCwd = process.cwd()
  process.chdir(tmp)
  t.after(() => {
    process.chdir(origCwd)
    rmSync(tmp, { recursive: true, force: true })
  })

  const out = strip(capture({ version: '1.0.0', modelName: 'claude-opus-4-6', provider: 'Anthropic' }))
  assert.ok(
    out.includes('No active GSD project') || /Active\s+M\d+/.test(out),
    'welcome should show GSD state lines or the no-project fallback',
  )
})

test('renders cwd hint', () => {
  const out = strip(capture({ version: '1.0.0' }))
  assert.ok(out.includes('/gsd to begin'), 'hint line missing')
})

test('skips when not a TTY', (t) => {
  const chunks: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  ;(process.stderr as any).write = (chunk: string) => { chunks.push(chunk); return true }
  const origIsTTY = (process.stderr as any).isTTY
  ;(process.stderr as any).isTTY = false

  t.after(() => {
    ;(process.stderr as any).write = original
    ;(process.stderr as any).isTTY = origIsTTY
  });

  printWelcomeScreen({ version: '1.0.0' })
  assert.equal(chunks.join(''), '', 'should produce no output when not TTY')
})

test('renders without model or provider', () => {
  const out = strip(capture({ version: '3.0.0' }))
  assert.ok(out.includes('v3.0.0'), 'version missing when no model provided')
})

test('renders remote channel in tools row', () => {
  const out = strip(capture({ version: '1.0.0', remoteChannel: 'discord' }))
  assert.ok(out.includes('Discord'), 'remote channel name missing')
})

test('omits remote channel when not provided', () => {
  const out = strip(capture({ version: '1.0.0' }))
  assert.ok(!out.includes('Discord'), 'should not show Discord when no remote')
  assert.ok(!out.includes('Slack'), 'should not show Slack when no remote')
  assert.ok(!out.includes('Telegram'), 'should not show Telegram when no remote')
})

test('Active row truncates with ellipsis when milestone text overflows panel width', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-welcome-test-'))
  mkdirSync(join(tmp, '.gsd'))
  writeFileSync(
    join(tmp, '.gsd', 'STATE.md'),
    [
      '**Active Milestone:** M001: Todo App – Core add/complete/delete with localStorage persistence and offline sync support',
      '**Phase:** evaluating-gates',
      '**Active Slice:** S01: implement full persistence layer with IndexedDB fallback',
    ].join('\n'),
  )
  const origCwd = process.cwd()
  process.chdir(tmp)
  const origColumns = (process.stderr as any).columns
  ;(process.stderr as any).columns = 120

  t.after(() => {
    process.chdir(origCwd)
    ;(process.stderr as any).columns = origColumns
    rmSync(tmp, { recursive: true, force: true })
  })

  const columns = (process.stderr as any).columns as number
  const out = strip(capture({ version: '1.0.0' }))
  const activeLine = out.split('\n').find(l => /Active\s/.test(l))
  assert.ok(activeLine, 'Active row should be present')
  assert.ok(activeLine!.includes('…'), 'Active row should truncate long text with ellipsis')
  assert.ok(activeLine!.length <= columns, `Active row length ${activeLine!.length} should not exceed terminal width ${columns}`)
})

test('Active row does not truncate short milestone text', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-welcome-test-'))
  mkdirSync(join(tmp, '.gsd'))
  writeFileSync(join(tmp, '.gsd', 'STATE.md'), '**Active Milestone:** M001: Short title\n')
  const origCwd = process.cwd()
  process.chdir(tmp)
  const origColumns = (process.stderr as any).columns
  ;(process.stderr as any).columns = 120

  t.after(() => {
    process.chdir(origCwd)
    ;(process.stderr as any).columns = origColumns
    rmSync(tmp, { recursive: true, force: true })
  })

  const out = strip(capture({ version: '1.0.0' }))
  const activeLine = out.split('\n').find(l => /Active\s/.test(l))
  assert.ok(activeLine, 'Active row should be present')
  assert.ok(activeLine!.includes('M001: Short title'), 'short title should appear in full')
  assert.ok(!activeLine!.includes('…'), 'short title should not be truncated')
})

test('separator lines extend to full terminal width on wide terminals', (t) => {
  const origColumns = process.stderr.columns
  ;(process.stderr as any).columns = 250
  t.after(() => { ;(process.stderr as any).columns = origColumns })

  const out = strip(capture({ version: '1.0.0' }))
  const lines = out.split('\n')
  // Top and bottom separator bars should be 249 chars (columns - 1)
  const separatorLines = lines.filter(l => /^─+$/.test(l.trim()))
  assert.ok(separatorLines.length >= 2, 'expected at least 2 full-width separator lines')
  for (const sep of separatorLines) {
    assert.equal(sep.trim().length, 249, `separator should be 249 chars wide, got ${sep.trim().length}`)
  }
})
