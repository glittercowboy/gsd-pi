/**
 * Headless Orchestrator — `gsd headless`
 *
 * Runs any /gsd subcommand without a TUI by spawning a child process in
 * RPC mode, auto-responding to extension UI requests, and streaming
 * progress to stderr.
 *
 * Exit codes:
 *   0 — complete (command finished successfully)
 *   1 — error or timeout
 *   2 — blocked (command reported a blocker)
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolve } from 'node:path'
import { ChildProcess } from 'node:child_process'

import { RpcClient } from '@gsd/pi-coding-agent'
import { loadAndValidateAnswerFile, AnswerInjector } from './headless-answers.js'

import {
  isTerminalNotification,
  isBlockedNotification,
  isMilestoneReadyNotification,
  isQuickCommand,
  FIRE_AND_FORGET_METHODS,
  IDLE_TIMEOUT_MS,
  NEW_MILESTONE_IDLE_TIMEOUT_MS,
} from './headless-events.js'

import {
  handleExtensionUIRequest,
  formatProgress,
  startSupervisedStdinReader,
} from './headless-ui.js'
import type { ExtensionUIRequest } from './headless-ui.js'

import {
  loadContext,
  bootstrapGsdProject,
} from './headless-context.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeadlessOptions {
  timeout: number
  json: boolean
  model?: string
  command: string
  commandArgs: string[]
  context?: string       // file path or '-' for stdin
  contextText?: string   // inline text
  auto?: boolean         // chain into auto-mode after milestone creation
  verbose?: boolean      // show tool calls in output
  maxRestarts?: number   // auto-restart on crash (default 3, 0 to disable)
  supervised?: boolean   // supervised mode: forward interactive requests to orchestrator
  responseTimeout?: number // timeout for orchestrator response (default 30000ms)
  answers?: string       // path to answers JSON file
  eventFilter?: Set<string>  // filter JSONL output to specific event types
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
        if (Number.isNaN(options.timeout) || options.timeout <= 0) {
          process.stderr.write('[headless] Error: --timeout must be a positive integer (milliseconds)\n')
          process.exit(1)
        }
      } else if (arg === '--json') {
        options.json = true
      } else if (arg === '--model' && i + 1 < args.length) {
        // --model can also be passed from the main CLI; headless-specific takes precedence
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
        if (Number.isNaN(options.maxRestarts) || options.maxRestarts < 0) {
          process.stderr.write('[headless] Error: --max-restarts must be a non-negative integer\n')
          process.exit(1)
        }
      } else if (arg === '--answers' && i + 1 < args.length) {
        options.answers = args[++i]
      } else if (arg === '--events' && i + 1 < args.length) {
        options.eventFilter = new Set(args[++i].split(','))
        options.json = true  // --events implies --json
      } else if (arg === '--supervised') {
        options.supervised = true
        options.json = true  // supervised implies json
      } else if (arg === '--response-timeout' && i + 1 < args.length) {
        options.responseTimeout = parseInt(args[++i], 10)
        if (Number.isNaN(options.responseTimeout) || options.responseTimeout <= 0) {
          process.stderr.write('[headless] Error: --response-timeout must be a positive integer (milliseconds)\n')
          process.exit(1)
        }
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

// ---------------------------------------------------------------------------
// Main Orchestrator
// ---------------------------------------------------------------------------

export async function runHeadless(options: HeadlessOptions): Promise<void> {
  const maxRestarts = options.maxRestarts ?? 3
  let restartCount = 0

  while (true) {
    const result = await runHeadlessOnce(options, restartCount)

    // Success or blocked — exit normally
    if (result.exitCode === 0 || result.exitCode === 2) {
      process.exit(result.exitCode)
    }

    // Crash/error — check if we should restart
    if (restartCount >= maxRestarts) {
      process.stderr.write(`[headless] Max restarts (${maxRestarts}) reached. Exiting.\n`)
      process.exit(result.exitCode)
    }

    // Don't restart if SIGINT/SIGTERM was received
    if (result.interrupted) {
      process.exit(result.exitCode)
    }

    restartCount++
    const backoffMs = Math.min(5000 * restartCount, 30_000)
    process.stderr.write(`[headless] Restarting in ${(backoffMs / 1000).toFixed(0)}s (attempt ${restartCount}/${maxRestarts})...\n`)
    await new Promise(resolve => setTimeout(resolve, backoffMs))
  }
}

async function runHeadlessOnce(options: HeadlessOptions, restartCount: number): Promise<{ exitCode: number; interrupted: boolean }> {
  let interrupted = false
  const startTime = Date.now()
  const isNewMilestone = options.command === 'new-milestone'

  // new-milestone involves codebase investigation + artifact writing — needs more time
  if (isNewMilestone && options.timeout === 300_000) {
    options.timeout = 600_000 // 10 minutes
  }

  // Supervised mode cannot share stdin with --context -
  if (options.supervised && options.context === '-') {
    process.stderr.write('[headless] Error: --supervised cannot be used with --context - (both require stdin)\n')
    process.exit(1)
  }

  // Load answer injection file
  let injector: AnswerInjector | undefined
  if (options.answers) {
    try {
      const answerFile = loadAndValidateAnswerFile(resolve(options.answers))
      injector = new AnswerInjector(answerFile)
      if (!options.json) {
        process.stderr.write(`[headless] Loaded answer file: ${options.answers}\n`)
      }
    } catch (err) {
      process.stderr.write(`[headless] Error loading answer file: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    }
  }

  // For new-milestone, load context and bootstrap .gsd/ before spawning RPC child
  if (isNewMilestone) {
    if (!options.context && !options.contextText) {
      process.stderr.write('[headless] Error: new-milestone requires --context <file> or --context-text <text>\n')
      process.exit(1)
    }

    let contextContent: string
    try {
      contextContent = await loadContext(options)
    } catch (err) {
      process.stderr.write(`[headless] Error loading context: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    }

    // Bootstrap .gsd/ if needed
    const gsdDir = join(process.cwd(), '.gsd')
    if (!existsSync(gsdDir)) {
      if (!options.json) {
        process.stderr.write('[headless] Bootstrapping .gsd/ project structure...\n')
      }
      bootstrapGsdProject(process.cwd())
    }

    // Write context to temp file for the RPC child to read
    const runtimeDir = join(gsdDir, 'runtime')
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(runtimeDir, 'headless-context.md'), contextContent, 'utf-8')
  }

  // Validate .gsd/ directory (skip for new-milestone since we just bootstrapped it)
  const gsdDir = join(process.cwd(), '.gsd')
  if (!isNewMilestone && !existsSync(gsdDir)) {
    process.stderr.write('[headless] Error: No .gsd/ directory found in current directory.\n')
    process.stderr.write("[headless] Run 'gsd' interactively first to initialize a project.\n")
    process.exit(1)
  }

  // Query: read-only state snapshot, no RPC child needed
  if (options.command === 'query') {
    const { handleQuery } = await import('./headless-query.js')
    const result = await handleQuery(process.cwd())
    return { exitCode: result.exitCode, interrupted: false }
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
  if (injector) {
    clientOptions.env = injector.getSecretEnvVars()
  }

  const client = new RpcClient(clientOptions)

  // Event tracking
  let totalEvents = 0
  let toolCallCount = 0
  let blocked = false
  let completed = false
  let exitCode = 0
  let milestoneReady = false  // tracks "Milestone X ready." for auto-chaining
  const recentEvents: TrackedEvent[] = []

  function trackEvent(event: Record<string, unknown>): void {
    totalEvents++
    const type = String(event.type ?? 'unknown')

    if (type === 'tool_execution_start') {
      toolCallCount++
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

  // Supervised mode state
  const pendingResponseTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let supervisedFallback = false
  let stopSupervisedReader: (() => void) | null = null
  const onStdinClose = () => {
    supervisedFallback = true
    process.stderr.write('[headless] Warning: orchestrator stdin closed, falling back to auto-response\n')
  }
  if (options.supervised) {
    process.stdin.on('close', onStdinClose)
  }

  // Completion promise
  let resolveCompletion: () => void
  const completionPromise = new Promise<void>((resolve) => {
    resolveCompletion = resolve
  })

  // Idle timeout — fallback completion detection
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const effectiveIdleTimeout = isNewMilestone ? NEW_MILESTONE_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer)
    if (toolCallCount > 0) {
      idleTimer = setTimeout(() => {
        completed = true
        resolveCompletion()
      }, effectiveIdleTimeout)
    }
  }

  // Precompute supervised response timeout
  const responseTimeout = options.responseTimeout ?? 30_000

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

    // Answer injector: observe events for question metadata
    injector?.observeEvent(eventObj)

    // --json mode: forward events as JSONL to stdout (filtered if --events)
    if (options.json) {
      const eventType = String(eventObj.type ?? '')
      if (!options.eventFilter || options.eventFilter.has(eventType)) {
        process.stdout.write(JSON.stringify(eventObj) + '\n')
      }
    } else {
      // Progress output to stderr
      const line = formatProgress(eventObj, !!options.verbose)
      if (line) process.stderr.write(line + '\n')
    }

    // Handle extension_ui_request
    if (eventObj.type === 'extension_ui_request' && stdinWriter) {
      // Check for terminal notification before auto-responding
      if (isBlockedNotification(eventObj)) {
        blocked = true
      }

      // Detect "Milestone X ready." for auto-mode chaining
      if (isMilestoneReadyNotification(eventObj)) {
        milestoneReady = true
      }

      if (isTerminalNotification(eventObj)) {
        completed = true
      }

      // Answer injection: try to handle with pre-supplied answers before supervised/auto
      if (injector && !FIRE_AND_FORGET_METHODS.has(String(eventObj.method ?? ''))) {
        if (injector.tryHandle(eventObj, stdinWriter)) {
          if (completed) {
            exitCode = blocked ? 2 : 0
            resolveCompletion()
          }
          return
        }
      }

      const method = String(eventObj.method ?? '')
      const shouldSupervise = options.supervised && !supervisedFallback
        && !FIRE_AND_FORGET_METHODS.has(method)

      if (shouldSupervise) {
        // Interactive request in supervised mode — let orchestrator respond
        const eventId = String(eventObj.id ?? '')
        const timer = setTimeout(() => {
          pendingResponseTimers.delete(eventId)
          handleExtensionUIRequest(eventObj as unknown as ExtensionUIRequest, stdinWriter!)
          process.stdout.write(JSON.stringify({ type: 'supervised_timeout', id: eventId, method }) + '\n')
        }, responseTimeout)
        pendingResponseTimers.set(eventId, timer)
      } else {
        handleExtensionUIRequest(eventObj as unknown as ExtensionUIRequest, stdinWriter)
      }

      // If we detected a terminal notification, resolve after responding
      if (completed) {
        exitCode = blocked ? 2 : 0
        resolveCompletion()
        return
      }
    }

    // Quick commands: resolve on first agent_end
    if (eventObj.type === 'agent_end' && isQuickCommand(options.command) && !completed) {
      completed = true
      resolveCompletion()
      return
    }

    // Long-running commands: agent_end after tool execution — possible completion
    // The idle timer + terminal notification handle this case.
  })

  // Signal handling
  const signalHandler = () => {
    process.stderr.write('\n[headless] Interrupted, stopping child process...\n')
    interrupted = true
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

  // Start supervised stdin reader for orchestrator commands
  if (options.supervised) {
    stopSupervisedReader = startSupervisedStdinReader(stdinWriter, client, (id) => {
      const timer = pendingResponseTimers.get(id)
      if (timer) {
        clearTimeout(timer)
        pendingResponseTimers.delete(id)
      }
    })
    // Ensure stdin is in flowing mode for JSONL reading
    process.stdin.resume()
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
    process.stderr.write(`[headless] Running /gsd ${options.command}${options.commandArgs.length > 0 ? ' ' + options.commandArgs.join(' ') : ''}...\n`)
  }

  // Send the command
  const command = `/gsd ${options.command}${options.commandArgs.length > 0 ? ' ' + options.commandArgs.join(' ') : ''}`
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

  // Auto-mode chaining: if --auto and milestone creation succeeded, send /gsd auto
  if (isNewMilestone && options.auto && milestoneReady && !blocked && exitCode === 0) {
    if (!options.json) {
      process.stderr.write('[headless] Milestone ready — chaining into auto-mode...\n')
    }

    // Reset completion state for the auto-mode phase
    completed = false
    milestoneReady = false
    blocked = false
    const autoCompletionPromise = new Promise<void>((resolve) => {
      resolveCompletion = resolve
    })

    try {
      await client.prompt('/gsd auto')
    } catch (err) {
      process.stderr.write(`[headless] Error: Failed to start auto-mode: ${err instanceof Error ? err.message : String(err)}\n`)
      exitCode = 1
    }

    if (exitCode === 0 || exitCode === 2) {
      await autoCompletionPromise
    }
  }

  // Cleanup
  clearTimeout(timeoutTimer)
  if (idleTimer) clearTimeout(idleTimer)
  pendingResponseTimers.forEach((timer) => clearTimeout(timer))
  pendingResponseTimers.clear()
  stopSupervisedReader?.()
  process.stdin.removeListener('close', onStdinClose)
  process.removeListener('SIGINT', signalHandler)
  process.removeListener('SIGTERM', signalHandler)

  await client.stop()

  // Summary
  const duration = ((Date.now() - startTime) / 1000).toFixed(1)
  const status = blocked ? 'blocked' : exitCode === 1 ? (totalEvents === 0 ? 'error' : 'timeout') : 'complete'

  process.stderr.write(`[headless] Status: ${status}\n`)
  process.stderr.write(`[headless] Duration: ${duration}s\n`)
  process.stderr.write(`[headless] Events: ${totalEvents} total, ${toolCallCount} tool calls\n`)
  if (options.eventFilter) {
    process.stderr.write(`[headless] Event filter: ${[...options.eventFilter].join(', ')}\n`)
  }
  if (restartCount > 0) {
    process.stderr.write(`[headless] Restarts: ${restartCount}\n`)
  }

  // Answer injection stats
  if (injector) {
    const stats = injector.getStats()
    process.stderr.write(`[headless] Answers: ${stats.questionsAnswered} answered, ${stats.questionsDefaulted} defaulted, ${stats.secretsProvided} secrets\n`)
    for (const warning of injector.getUnusedWarnings()) {
      process.stderr.write(`${warning}\n`)
    }
  }

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

  return { exitCode, interrupted }
}
