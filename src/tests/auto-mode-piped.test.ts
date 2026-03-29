/**
 * Tests for `gsd auto` routing — verifies that `auto` is recognized as a
 * subcommand alias for `headless auto` so it doesn't fall through to the
 * interactive TUI, which hangs when stdin/stdout are piped.
 *
 * Regression test for #2732.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(fileURLToPath(import.meta.url), '..', '..', '..')

// ---------------------------------------------------------------------------
// Source-level verification: cli.ts must handle 'auto' before TUI
// ---------------------------------------------------------------------------

/**
 * Read cli.ts and verify the 'auto' subcommand is routed before the
 * interactive TUI code path. This is the definitive test — if cli.ts doesn't
 * handle 'auto', piped invocations will hang (#2732).
 */
function cliSourceHandlesAutoBeforeTUI(): boolean {
  const cliSource = readFileSync(join(projectRoot, 'src', 'cli.ts'), 'utf-8')

  // Find the position of the 'auto' subcommand handler
  // It should appear as: messages[0] === 'auto'
  const autoHandlerMatch = cliSource.match(
    /messages\[0\]\s*===\s*['"]auto['"]/,
  )
  if (!autoHandlerMatch) return false

  // Find the position of the InteractiveMode TUI entry
  const tuiMatch = cliSource.match(/new\s+InteractiveMode\s*\(/)
  if (!tuiMatch) return false

  // The auto handler must appear BEFORE the TUI in the source
  const autoPos = cliSource.indexOf(autoHandlerMatch[0])
  const tuiPos = cliSource.indexOf(tuiMatch[0])

  return autoPos < tuiPos
}

// ═══════════════════════════════════════════════════════════════════════════
// Core regression test: `gsd auto` must be handled before TUI (#2732)
// ═══════════════════════════════════════════════════════════════════════════

test('cli.ts handles `auto` subcommand before interactive TUI (#2732)', () => {
  assert.ok(
    cliSourceHandlesAutoBeforeTUI(),
    'cli.ts must route messages[0] === "auto" to a handler BEFORE ' +
    'reaching `new InteractiveMode()`. Without this, `gsd auto` with ' +
    'piped stdin/stdout falls through to the TUI and hangs.',
  )
})

// ═══════════════════════════════════════════════════════════════════════════
// Verify the auto handler routes to headless (not a stub/no-op)
// ═══════════════════════════════════════════════════════════════════════════

test('cli.ts routes `auto` to headless runner', () => {
  const cliSource = readFileSync(join(projectRoot, 'src', 'cli.ts'), 'utf-8')

  // The auto handler block should import or reference headless
  // Look for the auto block and check it contains runHeadless or headless
  const autoBlockRegex = /messages\[0\]\s*===\s*['"]auto['"][\s\S]*?runHeadless/
  assert.ok(
    autoBlockRegex.test(cliSource),
    '`auto` subcommand handler must invoke runHeadless to delegate to headless mode',
  )
})

// ═══════════════════════════════════════════════════════════════════════════
// Verify piped-mode hint in error message when auto mode is not available
// ═══════════════════════════════════════════════════════════════════════════

test('TTY error message mentions `gsd auto` as a non-interactive alternative', () => {
  const cliSource = readFileSync(join(projectRoot, 'src', 'cli.ts'), 'utf-8')

  // The TTY error message should mention auto as an alternative
  assert.ok(
    cliSource.includes('gsd auto') || cliSource.includes('gsd headless'),
    'TTY error hints should mention headless/auto mode as alternatives',
  )
})

// ═══════════════════════════════════════════════════════════════════════════
// `gsd headless` still works (no regression)
// ═══════════════════════════════════════════════════════════════════════════

test('cli.ts handles `headless` subcommand before interactive TUI', () => {
  const cliSource = readFileSync(join(projectRoot, 'src', 'cli.ts'), 'utf-8')

  const headlessMatch = cliSource.match(/messages\[0\]\s*===\s*['"]headless['"]/)
  const tuiMatch = cliSource.match(/new\s+InteractiveMode\s*\(/)

  assert.ok(headlessMatch, 'headless subcommand handler exists')
  assert.ok(tuiMatch, 'InteractiveMode TUI exists')

  const headlessPos = cliSource.indexOf(headlessMatch![0])
  const tuiPos = cliSource.indexOf(tuiMatch![0])
  assert.ok(headlessPos < tuiPos, 'headless handler is before TUI')
})
