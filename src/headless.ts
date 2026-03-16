/**
 * Headless Orchestrator — `gsd headless`
 *
 * Runs GSD's auto-mode (or a single unit via --step) without a TUI by
 * spawning a child process in RPC mode, auto-responding to extension UI
 * requests, and streaming progress to stderr.
 *
 * Exit codes:
 *   0 — complete (auto-mode finished successfully)
 *   1 — error or timeout
 *   2 — blocked (auto-mode reported a blocker)
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ChildProcess } from 'node:child_process'

// RpcClient is not in @gsd/pi-coding-agent's public exports — import from dist directly.
// This relative path resolves correctly from both src/ (via tsx) and dist/ (compiled).
import { RpcClient } from '../packages/pi-coding-agent/dist/modes/rpc/rpc-client.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeadlessOptions {
  timeout: number
  step: boolean
  json: boolean
  verbose: boolean
  model?: string
}

interface ExtensionUIRequest {
  type: 'extension_ui_request'
  id: string
  method: string
  title?: string
  options?: string[]
  message?: string
  prefill?: string
  timeout?: number
  [key: string]: unknown
}

interface TrackedEvent {
  type: string
  timestamp: number
  detail?: string
}

// ---------------------------------------------------------------------------
// CLI Argument Parser
// ---------------------------------------------------------------------------

export function parseHeadlessArgs(argv: string[]): HeadlessOptions {
  const options: HeadlessOptions = {
    timeout: 300_000,
    step: false,
    json: false,
    verbose: false,
  }

  const args = argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === 'headless') continue
    if (arg === '--timeout' && i + 1 < args.length) {
      options.timeout = parseInt(args[++i], 10)
      if (Number.isNaN(options.timeout) || options.timeout <= 0) {
        process.stderr.write('[headless] Error: --timeout must be a positive integer (milliseconds)\n')
        process.exit(1)
      }
    } else if (arg === '--step') {
      options.step = true
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--verbose') {
      options.verbose = true
    } else if (arg === '--model' && i + 1 < args.length) {
      options.model = args[++i]
    }
  }

  return options
}

// ---------------------------------------------------------------------------
// JSONL Helper
// ---------------------------------------------------------------------------

function serializeJsonLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + '\n'
}

// ---------------------------------------------------------------------------
// Extension UI Auto-Responder
// ---------------------------------------------------------------------------

function handleExtensionUIRequest(
  event: ExtensionUIRequest,
  writeToStdin: (data: string) => void,
): void {
  const { id, method } = event
  let response: Record<string, unknown>

  switch (method) {
    case 'select':
      response = { type: 'extension_ui_response', id, value: event.options?.[0] ?? '' }
      break
    case 'confirm':
      response = { type: 'extension_ui_response', id, confirmed: true }
      break
    case 'input':
      response = { type: 'extension_ui_response', id, value: '' }
      break
    case 'editor':
      response = { type: 'extension_ui_response', id, value: event.prefill ?? '' }
      break
    case 'notify':
    case 'setStatus':
    case 'setWidget':
    case 'setTitle':
    case 'set_editor_text':
      response = { type: 'extension_ui_response', id, value: '' }
      break
    default:
      process.stderr.write(`[headless] Warning: unknown extension_ui_request method "${method}", cancelling\n`)
      response = { type: 'extension_ui_response', id, cancelled: true }
      break
  }

  writeToStdin(serializeJsonLine(response))
}

// ---------------------------------------------------------------------------
// Progress Formatter
// ---------------------------------------------------------------------------

function formatProgress(
  event: Record<string, unknown>,
  verbose: boolean,
): string | null {
  const type = String(event.type ?? '')

  switch (type) {
    case 'tool_execution_start':
      return `[tool] ${event.toolName ?? 'unknown'}`

    case 'tool_execution_end':
      if (verbose) {
        const result = String(event.result ?? '').slice(0, 200)
        return `[tool:result] ${event.toolName ?? 'unknown'}: ${result}`
      }
      return null

    case 'agent_start':
      return '[agent] Session started'

    case 'agent_end':
      return '[agent] Session ended'

    case 'extension_ui_request':
      if (event.method === 'notify') {
        return `[gsd] ${event.message ?? ''}`
      }
      return null

    case 'message_update':
      if (verbose) {
        const msgEvent = event.assistantMessageEvent as Record<string, unknown> | undefined
        const text = String(msgEvent?.text ?? '').slice(0, 200)
        if (text) return `[assistant] ${text}`
      }
      return null

    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Completion Detection
// ---------------------------------------------------------------------------

const TERMINAL_KEYWORDS = ['complete', 'stopped', 'blocked']
const IDLE_TIMEOUT_MS = 15_000

function isTerminalNotification(event: Record<string, unknown>): boolean {
  if (event.type !== 'extension_ui_request' || event.method !== 'notify') return false
  const message = String(event.message ?? '').toLowerCase()
  return TERMINAL_KEYWORDS.some((kw) => message.includes(kw))
}

function isBlockedNotification(event: Record<string, unknown>): boolean {
  if (event.type !== 'extension_ui_request' || event.method !== 'notify') return false
  return String(event.message ?? '').toLowerCase().includes('blocked')
}

// ---------------------------------------------------------------------------
// Main Orchestrator
// ---------------------------------------------------------------------------

export async function runHeadless(options: HeadlessOptions): Promise<void> {
  const startTime = Date.now()

  // Validate .gsd/ directory
  const gsdDir = join(process.cwd(), '.gsd')
  if (!existsSync(gsdDir)) {
    process.stderr.write('[headless] Error: No .gsd/ directory found in current directory.\n')
    process.stderr.write("[headless] Run 'gsd' interactively first to initialize a project.\n")
    process.exit(1)
  }

  // Resolve CLI path for the child process
  const cliPath = process.env.GSD_BIN_PATH || process.argv[1]
  if (!cliPath) {
    process.stderr.write('[headless] Error: Cannot determine CLI path. Set GSD_BIN_PATH or run via gsd.\n')
    process.exit(1)
  }

  // Create RPC client
  const clientOptions: Record<string, unknown> = {
    cliPath,
    cwd: process.cwd(),
  }
  if (options.model) {
    clientOptions.model = options.model
  }

  const client = new RpcClient(clientOptions)

  // Event tracking
  let totalEvents = 0
  let toolCallCount = 0
  let sawToolExecution = false
  let blocked = false
  let completed = false
  let exitCode = 0
  const recentEvents: TrackedEvent[] = []

  function trackEvent(event: Record<string, unknown>): void {
    totalEvents++
    const type = String(event.type ?? 'unknown')

    if (type === 'tool_execution_start') {
      toolCallCount++
      sawToolExecution = true
    }

    // Keep last 20 events for diagnostics
    const detail =
      type === 'tool_execution_start'
        ? String(event.toolName ?? '')
        : type === 'extension_ui_request'
          ? `${event.method}: ${event.title ?? event.message ?? ''}`
          : undefined

    recentEvents.push({ type, timestamp: Date.now(), detail })
    if (recentEvents.length > 20) recentEvents.shift()
  }

  // Stdin writer for sending extension_ui_response to child
  let stdinWriter: ((data: string) => void) | null = null

  // Completion promise
  let resolveCompletion: () => void
  let rejectCompletion: (err: Error) => void
  const completionPromise = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve
    rejectCompletion = reject
  })

  // Idle timeout — fallback completion detection
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer)
    if (sawToolExecution) {
      idleTimer = setTimeout(() => {
        completed = true
        resolveCompletion()
      }, IDLE_TIMEOUT_MS)
    }
  }

  // Overall timeout
  const timeoutTimer = setTimeout(() => {
    process.stderr.write(`[headless] Timeout after ${options.timeout / 1000}s\n`)
    exitCode = 1
    resolveCompletion()
  }, options.timeout)

  // Event handler
  client.onEvent((event) => {
    const eventObj = event as unknown as Record<string, unknown>
    trackEvent(eventObj)
    resetIdleTimer()

    // --json mode: forward all events as JSONL to stdout
    if (options.json) {
      process.stdout.write(JSON.stringify(eventObj) + '\n')
    } else {
      // Progress output to stderr
      const line = formatProgress(eventObj, options.verbose)
      if (line) process.stderr.write(line + '\n')
    }

    // Handle extension_ui_request
    if (eventObj.type === 'extension_ui_request' && stdinWriter) {
      // Check for terminal notification before auto-responding
      if (isBlockedNotification(eventObj)) {
        blocked = true
      }
      if (isTerminalNotification(eventObj)) {
        completed = true
      }

      handleExtensionUIRequest(eventObj as unknown as ExtensionUIRequest, stdinWriter)

      // If we detected a terminal notification, resolve after responding
      if (completed) {
        exitCode = blocked ? 2 : 0
        resolveCompletion()
        return
      }
    }

    // agent_end after tool execution — possible completion
    if (eventObj.type === 'agent_end' && sawToolExecution && !completed) {
      // Don't immediately resolve — wait for potential terminal notify or idle timeout.
      // The idle timer handles this case.
    }
  })

  // Signal handling
  const signalHandler = () => {
    process.stderr.write('\n[headless] Interrupted, stopping child process...\n')
    exitCode = 1
    client.stop().finally(() => {
      clearTimeout(timeoutTimer)
      if (idleTimer) clearTimeout(idleTimer)
      process.exit(exitCode)
    })
  }
  process.on('SIGINT', signalHandler)
  process.on('SIGTERM', signalHandler)

  // Start the RPC session
  try {
    await client.start()
  } catch (err) {
    process.stderr.write(`[headless] Error: Failed to start RPC session: ${err instanceof Error ? err.message : String(err)}\n`)
    clearTimeout(timeoutTimer)
    process.exit(1)
  }

  // Access stdin writer from the internal process
  const internalProcess = (client as any).process as ChildProcess
  if (!internalProcess?.stdin) {
    process.stderr.write('[headless] Error: Cannot access child process stdin\n')
    await client.stop()
    clearTimeout(timeoutTimer)
    process.exit(1)
  }

  stdinWriter = (data: string) => {
    internalProcess.stdin!.write(data)
  }

  // Detect child process crash
  internalProcess.on('exit', (code) => {
    if (!completed) {
      const msg = `[headless] Child process exited unexpectedly with code ${code ?? 'null'}\n`
      process.stderr.write(msg)
      exitCode = 1
      resolveCompletion()
    }
  })

  if (!options.json) {
    process.stderr.write('[headless] Starting auto-mode...\n')
  }

  // Send the command
  const command = options.step ? '/gsd next' : '/gsd auto'
  try {
    await client.prompt(command)
  } catch (err) {
    process.stderr.write(`[headless] Error: Failed to send prompt: ${err instanceof Error ? err.message : String(err)}\n`)
    exitCode = 1
  }

  // Wait for completion
  if (exitCode === 0 || exitCode === 2) {
    await completionPromise
  }

  // Cleanup
  clearTimeout(timeoutTimer)
  if (idleTimer) clearTimeout(idleTimer)
  process.removeListener('SIGINT', signalHandler)
  process.removeListener('SIGTERM', signalHandler)

  await client.stop()

  // Summary
  const duration = ((Date.now() - startTime) / 1000).toFixed(1)
  const status = blocked ? 'blocked' : exitCode === 1 ? (totalEvents === 0 ? 'error' : 'timeout') : 'complete'

  process.stderr.write(`[headless] Status: ${status}\n`)
  process.stderr.write(`[headless] Duration: ${duration}s\n`)
  process.stderr.write(`[headless] Events: ${totalEvents} total, ${toolCallCount} tool calls\n`)

  // On failure, print last 5 events for diagnostics
  if (exitCode !== 0) {
    const lastFive = recentEvents.slice(-5)
    if (lastFive.length > 0) {
      process.stderr.write('[headless] Last events:\n')
      for (const e of lastFive) {
        process.stderr.write(`  ${e.type}${e.detail ? `: ${e.detail}` : ''}\n`)
      }
    }
  }

  process.exit(exitCode)
}
