/**
 * Headless Orchestrator — `gsd headless`
 *
 * Runs any /gsd subcommand without a TUI by spawning a child process in
 * RPC mode, auto-responding to extension UI requests, and streaming
 * progress to stderr.
 *
 * Exit codes:
 *   0  — complete (command finished successfully)
 *   1  — error or timeout
 *   10 — blocked (command reported a blocker)
 *   11 — cancelled (SIGINT/SIGTERM received)
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolve } from 'node:path'
import { ChildProcess } from 'node:child_process'

import { RpcClient, SessionManager } from '@gsd/pi-coding-agent'
import type { SessionInfo } from '@gsd/pi-coding-agent'
import { getProjectSessionsDir } from './project-sessions.js'
import { loadAndValidateAnswerFile, AnswerInjector } from './headless-answers.js'

import {
  isTerminalNotification,
  isBlockedNotification,
  isMilestoneReadyNotification,
  isQuickCommand,
  FIRE_AND_FORGET_METHODS,
  IDLE_TIMEOUT_MS,
  NEW_MILESTONE_IDLE_TIMEOUT_MS,
  EXIT_SUCCESS,
  EXIT_ERROR,
  EXIT_BLOCKED,
  EXIT_CANCELLED,
  mapStatusToExitCode,
} from './headless-events.js'

import type { OutputFormat, HeadlessJsonResult } from './headless-types.js'
import { VALID_OUTPUT_FORMATS } from './headless-types.js'

import {
  handleExtensionUIRequest,
  formatProgress,
  formatThinkingLine,
  formatTextStart,
  formatTextEnd,
  formatThinkingStart,
  formatThinkingEnd,
  startSupervisedStdinReader,
} from './headless-ui.js'
import type { ExtensionUIRequest, ProgressContext } from './headless-ui.js'

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
  outputFormat: OutputFormat
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
  resumeSession?: string // session ID to resume (--resume <id>)
  bare?: boolean         // --bare: suppress CLAUDE.md/AGENTS.md, user skills, project preferences
}

interface TrackedEvent {
  type: string
  timestamp: number
  detail?: string
}

// ---------------------------------------------------------------------------
// Resume Session Resolution
// ---------------------------------------------------------------------------

export interface ResumeSessionResult {
  session?: SessionInfo
  error?: string
}

/**
 * Resolve a session prefix to a single session.
 * Exact id match is preferred over prefix match.
 * Returns `{ session }` on unique match or `{ error }` on 0/ambiguous matches.
 */
export function resolveResumeSession(sessions: SessionInfo[], prefix: string): ResumeSessionResult {
  // Exact match takes priority
  const exact = sessions.find(s => s.id === prefix)
  if (exact) {
    return { session: exact }
  }

  // Prefix match
  const matches = sessions.filter(s => s.id.startsWith(prefix))
  if (matches.length === 0) {
    return { error: `No session matching '${prefix}' found` }
  }
  if (matches.length > 1) {
    const list = matches.map(s => `  ${s.id}`).join('\n')
    return { error: `Ambiguous session prefix '${prefix}' matches ${matches.length} sessions:\n${list}` }
  }
  return { session: matches[0] }
}

// ---------------------------------------------------------------------------
// CLI Argument Parser
// ---------------------------------------------------------------------------

export function parseHeadlessArgs(argv: string[]): HeadlessOptions {
  const options: HeadlessOptions = {
    timeout: 300_000,
    json: false,
    outputFormat: 'text',
    command: 'auto',
    commandArgs: [],
  }

  const args = argv.slice(2)

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === 'headless') continue

    if (arg.startsWith('--')) {
      if (arg === '--timeout' && i + 1 < args.length) {
        options.timeout = parseInt(args[++i], 10)
        if (Number.isNaN(options.timeout) || options.timeout < 0) {
          process.stderr.write('[headless] Error: --timeout must be a non-negative integer (milliseconds, 0 to disable)\n')
          process.exit(1)
        }
      } else if (arg === '--json') {
        options.json = true
        options.outputFormat = 'stream-json'
      } else if (arg === '--output-format' && i + 1 < args.length) {
        const fmt = args[++i]
        if (!VALID_OUTPUT_FORMATS.has(fmt)) {
          process.stderr.write(`[headless] Error: --output-format must be one of: text, json, stream-json (got '${fmt}')\n`)
          process.exit(1)
        }
        options.outputFormat = fmt as OutputFormat
        if (fmt === 'stream-json' || fmt === 'json') {
          options.json = true
        }
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
        if (options.outputFormat === 'text') {
          options.outputFormat = 'stream-json'
        }
      } else if (arg === '--supervised') {
        options.supervised = true
        options.json = true  // supervised implies json
        if (options.outputFormat === 'text') {
          options.outputFormat = 'stream-json'
        }
      } else if (arg === '--response-timeout' && i + 1 < args.length) {
        options.responseTimeout = parseInt(args[++i], 10)
        if (Number.isNaN(options.responseTimeout) || options.responseTimeout <= 0) {
          process.stderr.write('[headless] Error: --response-timeout must be a positive integer (milliseconds)\n')
          process.exit(1)
        }
      } else if (arg === '--resume' && i + 1 < args.length) {
        options.resumeSession = args[++i]
      } else if (arg === '--bare') {
        options.bare = true
      }
    } else if (options.command === 'auto') {
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
    if (result.exitCode === EXIT_SUCCESS || result.exitCode === EXIT_BLOCKED) {
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

  // auto-mode sessions are long-running (minutes to hours) with their own internal
  // per-unit timeout via auto-supervisor. Disable the overall timeout unless the
  // user explicitly set --timeout.
  const isAutoMode = options.command === 'auto'
  // discuss and plan are multi-turn: they involve multiple question rounds,
  // codebase scanning, and artifact writing before the workflow completes (#3547).
  const isMultiTurnCommand = options.command === 'auto' || options.command === 'next' || options.command === 'discuss' || options.command === 'plan'
  if (isAutoMode && options.timeout === 300_000) {
    options.timeout = 0
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
  // Signal headless mode to the GSD extension (skips UAT human pause, etc.)
  clientOptions.env = { ...(clientOptions.env as Record<string, string> || {}), GSD_HEADLESS: '1' }
  // Propagate --bare to the child process
  if (options.bare) {
    clientOptions.args = [...((clientOptions.args as string[]) || []), '--bare']
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

  // JSON batch mode: cost aggregation (cumulative-max pattern per K004)
  let cumulativeCostUsd = 0
  let cumulativeInputTokens = 0
  let cumulativeOutputTokens = 0
  let cumulativeCacheReadTokens = 0
  let cumulativeCacheWriteTokens = 0
  let lastSessionId: string | undefined

  // Verbose text-mode state
  const toolStartTimes = new Map<string, number>()
  let lastCostData: { costUsd: number; inputTokens: number; outputTokens: number } | undefined
  let thinkingBuffer = ''
  // Streaming state: tracks whether we're inside a text or thinking block
  let inTextBlock = false
  let inThinkingBlock = false

  // Emit HeadlessJsonResult to stdout for --output-format json batch mode
  function emitBatchJsonResult(): void {
    if (options.outputFormat !== 'json') return
    const duration = Date.now() - startTime
    const status: HeadlessJsonResult['status'] = blocked ? 'blocked'
      : exitCode === EXIT_CANCELLED ? 'cancelled'
      : exitCode === EXIT_ERROR ? (totalEvents === 0 ? 'error' : 'timeout')
      : 'success'
    const result: HeadlessJsonResult = {
      status,
      exitCode,
      sessionId: lastSessionId,
      duration,
      cost: {
        total: cumulativeCostUsd,
        input_tokens: cumulativeInputTokens,
        output_tokens: cumulativeOutputTokens,
        cache_read_tokens: cumulativeCacheReadTokens,
        cache_write_tokens: cumulativeCacheWriteTokens,
      },
      toolCalls: toolCallCount,
      events: totalEvents,
    }
    process.stdout.write(JSON.stringify(result) + '\n')
  }

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

  // Client started flag — replaces old stdinWriter null-check
  let clientStarted = false
  // Adapter for AnswerInjector — wraps client.sendUIResponse in a writeToStdin-compatible callback
  // Initialized after client.start(); events won't fire before then
  let injectorStdinAdapter: (data: string) => void = () => {}

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

  // Overall timeout (disabled when options.timeout === 0, e.g. auto-mode)
  const timeoutTimer = options.timeout > 0
    ? setTimeout(() => {
        process.stderr.write(`[headless] Timeout after ${options.timeout / 1000}s\n`)
        exitCode = EXIT_ERROR
        resolveCompletion()
      }, options.timeout)
    : null

  // Event handler
  client.onEvent((event) => {
    const eventObj = event as unknown as Record<string, unknown>
    trackEvent(eventObj)
    resetIdleTimer()

    // Answer injector: observe events for question metadata
    injector?.observeEvent(eventObj)

    // --json / --output-format stream-json: forward events as JSONL to stdout (filtered if --events)
    // --output-format json (batch mode): suppress streaming, track cost for final result
    if (options.json && options.outputFormat === 'stream-json') {
      const eventType = String(eventObj.type ?? '')
      if (!options.eventFilter || options.eventFilter.has(eventType)) {
        process.stdout.write(JSON.stringify(eventObj) + '\n')
      }
    } else if (options.outputFormat === 'json') {
      // Batch mode: silently track cost_update events (cumulative-max per K004)
      const eventType = String(eventObj.type ?? '')
      if (eventType === 'cost_update') {
        const data = eventObj as Record<string, unknown>
        const cumCost = data.cumulativeCost as Record<string, unknown> | undefined
        if (cumCost) {
          cumulativeCostUsd = Math.max(cumulativeCostUsd, Number(cumCost.costUsd ?? 0))
          const tokens = data.tokens as Record<string, number> | undefined
          if (tokens) {
            cumulativeInputTokens = Math.max(cumulativeInputTokens, tokens.input ?? 0)
            cumulativeOutputTokens = Math.max(cumulativeOutputTokens, tokens.output ?? 0)
            cumulativeCacheReadTokens = Math.max(cumulativeCacheReadTokens, tokens.cacheRead ?? 0)
            cumulativeCacheWriteTokens = Math.max(cumulativeCacheWriteTokens, tokens.cacheWrite ?? 0)
          }
        }
      }
      // Track sessionId from init_result
      if (eventType === 'init_result') {
        lastSessionId = String((eventObj as Record<string, unknown>).sessionId ?? '')
      }
    } else if (!options.json) {
      // Progress output to stderr with verbose state tracking
      const eventType = String(eventObj.type ?? '')

      // Track cost_update events for agent_end summary
      if (eventType === 'cost_update') {
        const data = eventObj as Record<string, unknown>
        const cumCost = data.cumulativeCost as Record<string, unknown> | undefined
        if (cumCost) {
          const tokens = data.tokens as Record<string, number> | undefined
          lastCostData = {
            costUsd: Number(cumCost.costUsd ?? 0),
            inputTokens: tokens?.input ?? 0,
            outputTokens: tokens?.output ?? 0,
          }
        }
      }

      // Stream assistant text and thinking deltas in verbose mode
      if (eventType === 'message_update') {
        const ame = eventObj.assistantMessageEvent as Record<string, unknown> | undefined
        if (ame && options.verbose) {
          const ameType = String(ame.type ?? '')

          // --- Text streaming ---
          if (ameType === 'text_start') {
            inTextBlock = true
            process.stderr.write(formatTextStart())
          } else if (ameType === 'text_delta') {
            const delta = String(ame.delta ?? ame.text ?? '')
            if (delta) {
              if (!inTextBlock) {
                // Edge case: delta without start
                inTextBlock = true
                process.stderr.write(formatTextStart())
              }
              process.stderr.write(delta)
            }
          } else if (ameType === 'text_end') {
            if (inTextBlock) {
              process.stderr.write(formatTextEnd() + '\n')
              inTextBlock = false
            }
          }

          // --- Thinking streaming ---
          else if (ameType === 'thinking_start') {
            inThinkingBlock = true
            process.stderr.write(formatThinkingStart())
          } else if (ameType === 'thinking_delta') {
            const delta = String(ame.delta ?? ame.text ?? '')
            if (delta) {
              if (!inThinkingBlock) {
                inThinkingBlock = true
                process.stderr.write(formatThinkingStart())
              }
              process.stderr.write(delta)
            }
          } else if (ameType === 'thinking_end') {
            if (inThinkingBlock) {
              process.stderr.write(formatThinkingEnd() + '\n')
              inThinkingBlock = false
            }
          }
        }
        // Non-verbose: accumulate text_delta for truncated one-liner
        else if (ame?.type === 'text_delta') {
          thinkingBuffer += String(ame.delta ?? ame.text ?? '')
        }
      }

      // Track tool execution start timestamps
      if (eventType === 'tool_execution_start') {
        const toolCallId = String(eventObj.toolCallId ?? eventObj.id ?? '')
        if (toolCallId) toolStartTimes.set(toolCallId, Date.now())
      }

      // Close any open streaming blocks before tool calls or message end
      if (options.verbose && (eventType === 'tool_execution_start' || eventType === 'message_end')) {
        if (inTextBlock) {
          process.stderr.write('\n')
          inTextBlock = false
        }
        if (inThinkingBlock) {
          process.stderr.write('\n')
          inThinkingBlock = false
        }
      }
      // Non-verbose: flush accumulated buffer as truncated one-liner
      else if (!options.verbose && thinkingBuffer.trim() &&
          (eventType === 'tool_execution_start' || eventType === 'message_end')) {
        process.stderr.write(formatThinkingLine(thinkingBuffer) + '\n')
        thinkingBuffer = ''
      }

      // Compute tool duration for tool_execution_end
      let toolDuration: number | undefined
      let isToolError = false
      if (eventType === 'tool_execution_end') {
        const toolCallId = String(eventObj.toolCallId ?? eventObj.id ?? '')
        const startTime = toolStartTimes.get(toolCallId)
        if (startTime) {
          toolDuration = Date.now() - startTime
          toolStartTimes.delete(toolCallId)
        }
        isToolError = eventObj.isError === true || eventObj.error != null
      }

      const ctx: ProgressContext = {
        verbose: !!options.verbose,
        toolDuration,
        isError: isToolError,
        lastCost: eventType === 'agent_end' ? lastCostData : undefined,
      }

      const line = formatProgress(eventObj, ctx)
      if (line) process.stderr.write(line + '\n')
    }

    // Handle execution_complete (v2 structured completion)
    // Skip for multi-turn commands (auto, next) — their completion is detected via
    // isTerminalNotification("Auto-mode stopped..."/"Step-mode stopped..."), not per-turn events
    if (eventObj.type === 'execution_complete' && !completed && !isMultiTurnCommand) {
      completed = true
      const status = String(eventObj.status ?? 'success')
      exitCode = mapStatusToExitCode(status)
      if (eventObj.status === 'blocked') blocked = true
      resolveCompletion()
      return
    }

    // Handle extension_ui_request
    if (eventObj.type === 'extension_ui_request' && clientStarted) {
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
        if (injector.tryHandle(eventObj, injectorStdinAdapter)) {
          if (completed) {
            exitCode = blocked ? EXIT_BLOCKED : EXIT_SUCCESS
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
          handleExtensionUIRequest(eventObj as unknown as ExtensionUIRequest, client)
          process.stdout.write(JSON.stringify({ type: 'supervised_timeout', id: eventId, method }) + '\n')
        }, responseTimeout)
        pendingResponseTimers.set(eventId, timer)
      } else {
        handleExtensionUIRequest(eventObj as unknown as ExtensionUIRequest, client)
      }

      // If we detected a terminal notification, resolve after responding
      if (completed) {
        exitCode = blocked ? EXIT_BLOCKED : EXIT_SUCCESS
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
    exitCode = EXIT_CANCELLED
    // Kill child process — don't await, just fire and exit.
    // The main flow may be awaiting a promise that resolves when the child dies,
    // which would race with this handler. Exit synchronously to ensure correct exit code.
    try { client.stop().catch(() => {}) } catch {}
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (idleTimer) clearTimeout(idleTimer)
    // Emit batch JSON result if in json mode before exiting
    if (options.outputFormat === 'json') {
      emitBatchJsonResult()
    }
    process.exit(exitCode)
  }
  process.on('SIGINT', signalHandler)
  process.on('SIGTERM', signalHandler)

  // Start the RPC session
  try {
    await client.start()
  } catch (err) {
    process.stderr.write(`[headless] Error: Failed to start RPC session: ${err instanceof Error ? err.message : String(err)}\n`)
    if (timeoutTimer) clearTimeout(timeoutTimer)
    process.exit(1)
  }

  // v2 protocol negotiation — attempt init for structured completion events
  let v2Enabled = false
  try {
    await client.init({ clientId: 'gsd-headless' })
    v2Enabled = true
  } catch {
    process.stderr.write('[headless] Warning: v2 init failed, falling back to v1 string-matching\n')
  }

  clientStarted = true

  // --resume: resolve session ID and switch to it
  if (options.resumeSession) {
    const projectSessionsDir = getProjectSessionsDir(process.cwd())
    const sessions = await SessionManager.list(process.cwd(), projectSessionsDir)
    const result = resolveResumeSession(sessions, options.resumeSession)
    if (result.error) {
      process.stderr.write(`[headless] Error: ${result.error}\n`)
      await client.stop()
      if (timeoutTimer) clearTimeout(timeoutTimer)
      process.exit(1)
    }
    const matched = result.session!
    const switchResult = await client.switchSession(matched.path)
    if (switchResult.cancelled) {
      process.stderr.write(`[headless] Error: Session switch to '${matched.id}' was cancelled by an extension\n`)
      await client.stop()
      if (timeoutTimer) clearTimeout(timeoutTimer)
      process.exit(1)
    }
    process.stderr.write(`[headless] Resuming session ${matched.id}\n`)
  }

  // Build injector adapter — wraps client.sendUIResponse for AnswerInjector's writeToStdin interface
  injectorStdinAdapter = (data: string) => {
    try {
      const parsed = JSON.parse(data.trim())
      if (parsed.type === 'extension_ui_response' && parsed.id) {
        const { id, value, values, confirmed, cancelled } = parsed
        client.sendUIResponse(id, { value, values, confirmed, cancelled })
      }
    } catch {
      process.stderr.write('[headless] Warning: injector adapter received unparseable data\n')
    }
  }

  // Start supervised stdin reader for orchestrator commands
  if (options.supervised) {
    stopSupervisedReader = startSupervisedStdinReader(client, (id) => {
      const timer = pendingResponseTimers.get(id)
      if (timer) {
        clearTimeout(timer)
        pendingResponseTimers.delete(id)
      }
    })
    // Ensure stdin is in flowing mode for JSONL reading
    process.stdin.resume()
  }

  // Detect child process crash (read-only exit event subscription — not stdin access)
  const internalProcess = (client as any).process as ChildProcess
  if (internalProcess) {
    internalProcess.on('exit', (code) => {
      if (!completed) {
        const msg = `[headless] Child process exited unexpectedly with code ${code ?? 'null'}\n`
        process.stderr.write(msg)
        exitCode = EXIT_ERROR
        resolveCompletion()
      }
    })
  }

  if (!options.json) {
    process.stderr.write(`[headless] Running /gsd ${options.command}${options.commandArgs.length > 0 ? ' ' + options.commandArgs.join(' ') : ''}...\n`)
  }

  // Send the command
  const command = `/gsd ${options.command}${options.commandArgs.length > 0 ? ' ' + options.commandArgs.join(' ') : ''}`
  try {
    await client.prompt(command)
  } catch (err) {
    process.stderr.write(`[headless] Error: Failed to send prompt: ${err instanceof Error ? err.message : String(err)}\n`)
    exitCode = EXIT_ERROR
  }

  // Wait for completion
  if (exitCode === EXIT_SUCCESS || exitCode === EXIT_BLOCKED) {
    await completionPromise
  }

  // Auto-mode chaining: if --auto and milestone creation succeeded, send /gsd auto
  if (isNewMilestone && options.auto && milestoneReady && !blocked && exitCode === EXIT_SUCCESS) {
    if (!options.json) {
      process.stderr.write('[headless] Milestone ready — chaining into auto-mode...\n')
    }

    // Reset completion state for the auto-mode phase.
    // Disable the overall timeout — auto-mode has its own internal supervisor.
    if (timeoutTimer) clearTimeout(timeoutTimer)
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
      exitCode = EXIT_ERROR
    }

    if (exitCode === EXIT_SUCCESS || exitCode === EXIT_BLOCKED) {
      await autoCompletionPromise
    }
  }

  // Cleanup
  if (timeoutTimer) clearTimeout(timeoutTimer)
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
  const status = blocked ? 'blocked' : exitCode === EXIT_CANCELLED ? 'cancelled' : exitCode === EXIT_ERROR ? (totalEvents === 0 ? 'error' : 'timeout') : 'complete'

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

  // Emit structured JSON result in batch mode
  emitBatchJsonResult()

  return { exitCode, interrupted }
}
