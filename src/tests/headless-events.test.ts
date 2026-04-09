/**
 * Tests for `--events` flag — JSONL event stream filtering.
 *
 * Validates argument parsing and the event filter logic used by
 * the headless orchestrator to reduce stdout noise for orchestrators.
 *
 * Uses extracted parsing logic (mirrors headless.ts) to avoid
 * transitive @gsd/native import that breaks in test environment.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// ─── Extracted parsing logic (mirrors headless.ts) ─────────────────────────

interface HeadlessOptions {
  timeout: number
  json: boolean
  model?: string
  command: string
  commandArgs: string[]
  context?: string
  contextText?: string
  auto?: boolean
  verbose?: boolean
  maxRestarts?: number
  supervised?: boolean
  responseTimeout?: number
  answers?: string
  eventFilter?: Set<string>
}

function parseHeadlessArgs(argv: string[]): HeadlessOptions {
  const options: HeadlessOptions = {
    timeout: 300_000,
    json: false,
    command: 'auto',
    commandArgs: [],
  }

  const args = argv.slice(2)
  let positionalStarted = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === 'headless') continue

    if (!positionalStarted && arg.startsWith('--')) {
      if (arg === '--timeout' && i + 1 < args.length) {
        options.timeout = parseInt(args[++i], 10)
      } else if (arg === '--json') {
        options.json = true
      } else if (arg === '--model' && i + 1 < args.length) {
        options.model = args[++i]
      } else if (arg === '--context' && i + 1 < args.length) {
        options.context = args[++i]
      } else if (arg === '--context-text' && i + 1 < args.length) {
        options.contextText = args[++i]
      } else if (arg === '--auto') {
        options.auto = true
      } else if (arg === '--verbose') {
        options.verbose = true
      } else if (arg === '--max-restarts' && i + 1 < args.length) {
        options.maxRestarts = parseInt(args[++i], 10)
      } else if (arg === '--answers' && i + 1 < args.length) {
        options.answers = args[++i]
      } else if (arg === '--events' && i + 1 < args.length) {
        options.eventFilter = new Set(args[++i].split(','))
        options.json = true
      } else if (arg === '--supervised') {
        options.supervised = true
        options.json = true
      } else if (arg === '--response-timeout' && i + 1 < args.length) {
        options.responseTimeout = parseInt(args[++i], 10)
      }
    } else if (!positionalStarted) {
      positionalStarted = true
      options.command = arg
    } else {
      options.commandArgs.push(arg)
    }
  }

  return options
}

// ─── parseHeadlessArgs: --events flag ──────────────────────────────────────

test('--events parses comma-separated event types into a Set', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', '--events', 'agent_end,extension_ui_request', 'auto'])
  assert.ok(opts.eventFilter instanceof Set)
  assert.equal(opts.eventFilter!.size, 2)
  assert.ok(opts.eventFilter!.has('agent_end'))
  assert.ok(opts.eventFilter!.has('extension_ui_request'))
})

test('--events implies --json', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', '--events', 'agent_end', 'auto'])
  assert.equal(opts.json, true)
})

test('--events with single type', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', '--events', 'agent_end', 'auto'])
  assert.equal(opts.eventFilter!.size, 1)
  assert.ok(opts.eventFilter!.has('agent_end'))
})

test('no --events flag means no filter', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', '--json', 'auto'])
  assert.equal(opts.eventFilter, undefined)
})

test('--events with all common types', () => {
  const types = 'agent_start,agent_end,tool_execution_start,tool_execution_end,extension_ui_request'
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', '--events', types, 'auto'])
  assert.equal(opts.eventFilter!.size, 5)
})

test('--events combined with other flags', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', '--timeout', '60000', '--events', 'agent_end', '--verbose', 'next'])
  assert.equal(opts.timeout, 60000)
  assert.equal(opts.verbose, true)
  assert.equal(opts.command, 'next')
  assert.ok(opts.eventFilter!.has('agent_end'))
  assert.equal(opts.json, true)
})

// ─── Event filter matching logic ───────────────────────────────────────────

test('filter allows matching event types', () => {
  const filter = new Set(['agent_end', 'extension_ui_request'])
  assert.ok(filter.has('agent_end'))
  assert.ok(filter.has('extension_ui_request'))
  assert.ok(!filter.has('message_update'))
  assert.ok(!filter.has('tool_execution_start'))
})

test('no filter allows all event types (undefined check)', () => {
  const filter: Set<string> | undefined = undefined
  const shouldEmit = (type: string) => !filter || filter.has(type)
  assert.ok(shouldEmit('agent_end'))
  assert.ok(shouldEmit('message_update'))
  assert.ok(shouldEmit('tool_execution_start'))
})

test('empty filter blocks all events', () => {
  const filter = new Set<string>()
  const shouldEmit = (type: string) => !filter || filter.has(type)
  assert.ok(!shouldEmit('agent_end'))
  assert.ok(!shouldEmit('message_update'))
})

import { mapStatusToExitCode, EXIT_SUCCESS, EXIT_ERROR, EXIT_BLOCKED, EXIT_CANCELLED } from '../headless-events.js'

// ─── mapStatusToExitCode ─────────────────────────────────────────────────

test('mapStatusToExitCode: "complete" returns EXIT_SUCCESS', () => {
  assert.equal(mapStatusToExitCode('complete'), EXIT_SUCCESS)
})

test('mapStatusToExitCode: "completed" returns EXIT_SUCCESS', () => {
  assert.equal(mapStatusToExitCode('completed'), EXIT_SUCCESS)
})

test('mapStatusToExitCode: "success" returns EXIT_SUCCESS', () => {
  assert.equal(mapStatusToExitCode('success'), EXIT_SUCCESS)
})

test('mapStatusToExitCode: "error" returns EXIT_ERROR', () => {
  assert.equal(mapStatusToExitCode('error'), EXIT_ERROR)
})

test('mapStatusToExitCode: "timeout" returns EXIT_ERROR', () => {
  assert.equal(mapStatusToExitCode('timeout'), EXIT_ERROR)
})

test('mapStatusToExitCode: "blocked" returns EXIT_BLOCKED', () => {
  assert.equal(mapStatusToExitCode('blocked'), EXIT_BLOCKED)
})

test('mapStatusToExitCode: "cancelled" returns EXIT_CANCELLED', () => {
  assert.equal(mapStatusToExitCode('cancelled'), EXIT_CANCELLED)
})

test('mapStatusToExitCode: unknown status returns EXIT_ERROR', () => {
  assert.equal(mapStatusToExitCode('unknown'), EXIT_ERROR)
})
