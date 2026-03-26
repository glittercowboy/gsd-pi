/**
 * Tests for S02 CLI surface — --output-format, exit codes, HeadlessJsonResult, --resume.
 *
 * Uses extracted parsing logic (mirrors headless.ts) and direct imports from
 * headless-types.ts / headless-events.ts to avoid transitive @gsd/native
 * import that breaks in test environment.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// ─── Import exit code constants & mapStatusToExitCode ──────────────────────

import {
  EXIT_SUCCESS,
  EXIT_ERROR,
  EXIT_BLOCKED,
  EXIT_CANCELLED,
  mapStatusToExitCode,
} from '../headless-events.js'

import type { OutputFormat, HeadlessJsonResult } from '../headless-types.js'
import { VALID_OUTPUT_FORMATS } from '../headless-types.js'

// ─── Extracted parsing logic (mirrors headless.ts) ─────────────────────────

interface HeadlessOptions {
  timeout: number
  json: boolean
  outputFormat: OutputFormat
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
  resumeSession?: string
  bare?: boolean
}

function parseHeadlessArgs(argv: string[]): HeadlessOptions {
  const options: HeadlessOptions = {
    timeout: 300_000,
    json: false,
    outputFormat: 'text',
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
        options.outputFormat = 'stream-json'
      } else if (arg === '--output-format' && i + 1 < args.length) {
        const fmt = args[++i]
        if (!VALID_OUTPUT_FORMATS.has(fmt)) {
          throw new Error(`Invalid output format: ${fmt}`)
        }
        options.outputFormat = fmt as OutputFormat
        if (fmt === 'stream-json' || fmt === 'json') {
          options.json = true
        }
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
        if (options.outputFormat === 'text') {
          options.outputFormat = 'stream-json'
        }
      } else if (arg === '--supervised') {
        options.supervised = true
        options.json = true
        if (options.outputFormat === 'text') {
          options.outputFormat = 'stream-json'
        }
      } else if (arg === '--response-timeout' && i + 1 < args.length) {
        options.responseTimeout = parseInt(args[++i], 10)
      } else if (arg === '--resume' && i + 1 < args.length) {
        options.resumeSession = args[++i]
      } else if (arg === '--bare') {
        options.bare = true
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

// ─── --output-format flag parsing ──────────────────────────────────────────

test('--output-format text sets outputFormat to text', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', '--output-format', 'text', 'auto'])
  assert.equal(opts.outputFormat, 'text')
  assert.equal(opts.json, false)
})

test('--output-format json sets outputFormat to json and json=true', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', '--output-format', 'json', 'auto'])
  assert.equal(opts.outputFormat, 'json')
  assert.equal(opts.json, true)
})

test('--output-format stream-json sets outputFormat to stream-json and json=true', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', '--output-format', 'stream-json', 'auto'])
  assert.equal(opts.outputFormat, 'stream-json')
  assert.equal(opts.json, true)
})

test('default output format is text', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', 'auto'])
  assert.equal(opts.outputFormat, 'text')
  assert.equal(opts.json, false)
})

test('invalid --output-format value throws', () => {
  assert.throws(
    () => parseHeadlessArgs(['node', 'gsd', 'headless', '--output-format', 'yaml', 'auto']),
    /Invalid output format: yaml/,
  )
})

test('invalid --output-format value (empty) throws', () => {
  assert.throws(
    () => parseHeadlessArgs(['node', 'gsd', 'headless', '--output-format', 'xml', 'auto']),
    /Invalid output format/,
  )
})

// ─── --json backward compatibility ─────────────────────────────────────────

test('--json is alias for --output-format stream-json', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', '--json', 'auto'])
  assert.equal(opts.outputFormat, 'stream-json')
  assert.equal(opts.json, true)
})

test('--json before --output-format json: last writer wins', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', '--json', '--output-format', 'json', 'auto'])
  assert.equal(opts.outputFormat, 'json')
  assert.equal(opts.json, true)
})

// ─── --resume flag ─────────────────────────────────────────────────────────

test('--resume parses session ID', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', '--resume', 'abc-123', 'auto'])
  assert.equal(opts.resumeSession, 'abc-123')
  assert.equal(opts.command, 'auto')
})

test('no --resume means undefined', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', 'auto'])
  assert.equal(opts.resumeSession, undefined)
})

// ─── Exit code constants ───────────────────────────────────────────────────

test('EXIT_SUCCESS is 0', () => {
  assert.equal(EXIT_SUCCESS, 0)
})

test('EXIT_ERROR is 1', () => {
  assert.equal(EXIT_ERROR, 1)
})

test('EXIT_BLOCKED is 10', () => {
  assert.equal(EXIT_BLOCKED, 10)
})

test('EXIT_CANCELLED is 11', () => {
  assert.equal(EXIT_CANCELLED, 11)
})

// ─── mapStatusToExitCode ───────────────────────────────────────────────────

test('mapStatusToExitCode: success → 0', () => {
  assert.equal(mapStatusToExitCode('success'), EXIT_SUCCESS)
})

test('mapStatusToExitCode: complete → 0', () => {
  assert.equal(mapStatusToExitCode('complete'), EXIT_SUCCESS)
})

test('mapStatusToExitCode: error → 1', () => {
  assert.equal(mapStatusToExitCode('error'), EXIT_ERROR)
})

test('mapStatusToExitCode: timeout → 1', () => {
  assert.equal(mapStatusToExitCode('timeout'), EXIT_ERROR)
})

test('mapStatusToExitCode: blocked → 10', () => {
  assert.equal(mapStatusToExitCode('blocked'), EXIT_BLOCKED)
})

test('mapStatusToExitCode: cancelled → 11', () => {
  assert.equal(mapStatusToExitCode('cancelled'), EXIT_CANCELLED)
})

test('mapStatusToExitCode: unknown status defaults to EXIT_ERROR', () => {
  assert.equal(mapStatusToExitCode('unknown'), EXIT_ERROR)
  assert.equal(mapStatusToExitCode(''), EXIT_ERROR)
})

// ─── HeadlessJsonResult type shape ─────────────────────────────────────────

test('HeadlessJsonResult satisfies expected shape', () => {
  // Type-level assertion: construct a valid object and verify it compiles.
  // At runtime, verify all required keys exist.
  const result: HeadlessJsonResult = {
    status: 'success',
    exitCode: 0,
    duration: 12345,
    cost: { total: 0.05, input_tokens: 1000, output_tokens: 500, cache_read_tokens: 200, cache_write_tokens: 100 },
    toolCalls: 15,
    events: 42,
  }
  assert.equal(result.status, 'success')
  assert.equal(result.exitCode, 0)
  assert.equal(typeof result.duration, 'number')
  assert.ok(result.cost)
  assert.equal(typeof result.cost.total, 'number')
  assert.equal(typeof result.cost.input_tokens, 'number')
  assert.equal(typeof result.cost.output_tokens, 'number')
  assert.equal(typeof result.cost.cache_read_tokens, 'number')
  assert.equal(typeof result.cost.cache_write_tokens, 'number')
  assert.equal(typeof result.toolCalls, 'number')
  assert.equal(typeof result.events, 'number')
})

test('HeadlessJsonResult accepts optional fields', () => {
  const result: HeadlessJsonResult = {
    status: 'blocked',
    exitCode: 10,
    sessionId: 'sess-abc',
    duration: 5000,
    cost: { total: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    toolCalls: 0,
    events: 1,
    milestone: 'M001',
    phase: 'planning',
    nextAction: 'fix blocker',
    artifacts: ['ROADMAP.md'],
    commits: ['abc1234'],
  }
  assert.equal(result.sessionId, 'sess-abc')
  assert.equal(result.milestone, 'M001')
  assert.deepEqual(result.artifacts, ['ROADMAP.md'])
  assert.deepEqual(result.commits, ['abc1234'])
})

// ─── VALID_OUTPUT_FORMATS set ──────────────────────────────────────────────

test('VALID_OUTPUT_FORMATS contains exactly text, json, stream-json', () => {
  assert.equal(VALID_OUTPUT_FORMATS.size, 3)
  assert.ok(VALID_OUTPUT_FORMATS.has('text'))
  assert.ok(VALID_OUTPUT_FORMATS.has('json'))
  assert.ok(VALID_OUTPUT_FORMATS.has('stream-json'))
})

// ─── Regression: existing flags still parse correctly ──────────────────────

test('--events still works with new outputFormat default', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', '--events', 'agent_end,tool_execution_start', 'auto'])
  assert.ok(opts.eventFilter instanceof Set)
  assert.equal(opts.eventFilter!.size, 2)
  assert.equal(opts.json, true)
  assert.equal(opts.outputFormat, 'stream-json')
})

test('--timeout still works', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', '--timeout', '60000', 'auto'])
  assert.equal(opts.timeout, 60000)
})

test('--supervised still works and implies stream-json', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', '--supervised', 'auto'])
  assert.equal(opts.supervised, true)
  assert.equal(opts.json, true)
  assert.equal(opts.outputFormat, 'stream-json')
})

test('--answers still works', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', '--answers', 'answers.json', 'auto'])
  assert.equal(opts.answers, 'answers.json')
})

test('positional command parsing still works', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', 'next'])
  assert.equal(opts.command, 'next')
})

test('combined flags parse correctly', () => {
  const opts = parseHeadlessArgs([
    'node', 'gsd', 'headless',
    '--output-format', 'json',
    '--timeout', '120000',
    '--resume', 'sess-xyz',
    '--verbose',
    'auto',
  ])
  assert.equal(opts.outputFormat, 'json')
  assert.equal(opts.json, true)
  assert.equal(opts.timeout, 120000)
  assert.equal(opts.resumeSession, 'sess-xyz')
  assert.equal(opts.verbose, true)
  assert.equal(opts.command, 'auto')
})

// ─── --bare flag ───────────────────────────────────────────────────────────

test('--bare sets bare to true', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', '--bare', 'auto'])
  assert.equal(opts.bare, true)
  assert.equal(opts.command, 'auto')
})

test('no --bare means bare is undefined', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', 'auto'])
  assert.equal(opts.bare, undefined)
})

test('--bare is a boolean flag (no value needed)', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', '--bare', '--json', 'auto'])
  assert.equal(opts.bare, true)
  assert.equal(opts.json, true)
})

test('--bare combined with --output-format json', () => {
  const opts = parseHeadlessArgs([
    'node', 'gsd', 'headless',
    '--bare',
    '--output-format', 'json',
    'auto',
  ])
  assert.equal(opts.bare, true)
  assert.equal(opts.outputFormat, 'json')
  assert.equal(opts.json, true)
  assert.equal(opts.command, 'auto')
})

test('--bare does not affect other flags', () => {
  const opts = parseHeadlessArgs([
    'node', 'gsd', 'headless',
    '--bare',
    '--timeout', '60000',
    '--resume', 'sess-abc',
    'auto',
  ])
  assert.equal(opts.bare, true)
  assert.equal(opts.timeout, 60000)
  assert.equal(opts.resumeSession, 'sess-abc')
  assert.equal(opts.command, 'auto')
})
