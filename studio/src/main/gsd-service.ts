/**
 * GsdService — Main-process subprocess manager for gsd-2 RPC communication.
 *
 * Spawns `gsd --mode rpc`, communicates via LF-only JSONL framing,
 * manages pending requests by ID with timeouts, auto-responds to
 * interactive extension UI requests, and handles crash recovery with
 * exponential backoff.
 *
 * Design reference: vscode-extension/src/gsd-client.ts
 * Adapted for Electron IPC forwarding instead of VS Code event emitters.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { AgentEvent, RpcResponse, RpcExtensionUIResponse } from './rpc-types.js'
import { FIRE_AND_FORGET_METHODS } from './rpc-types.js'

// ============================================================================
// Types
// ============================================================================

export interface GsdServiceOptions {
  /** Path to gsd binary. Defaults to process.env.GSD_BIN_PATH or 'gsd'. */
  binaryPath?: string
  /** Working directory for the subprocess. */
  cwd: string
  /** Called for every event (non-response) from the agent. */
  onEvent: (event: AgentEvent) => void
  /** Called when connection state changes. */
  onConnectionChange: (connected: boolean) => void
  /** Called with stderr output from the agent. */
  onError: (message: string) => void
}

type PendingRequest = {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  command: string
}

// ============================================================================
// GsdService
// ============================================================================

export class GsdService {
  private process: ChildProcess | null = null
  private pendingRequests = new Map<string, PendingRequest>()
  private requestId = 0
  private buffer = ''
  private restartCount = 0
  private restartTimestamps: number[] = []
  private disposed = false

  private readonly binaryPath: string
  private readonly cwd: string
  private readonly onEvent: (event: AgentEvent) => void
  private readonly onConnectionChange: (connected: boolean) => void
  private readonly onError: (message: string) => void

  /** Last error message from the subprocess. */
  lastError: string | null = null
  /** Last exit code from the subprocess. */
  lastExitCode: number | null = null

  /** Request timeout in ms. Exposed for testing. */
  requestTimeoutMs = 30_000

  constructor(options: GsdServiceOptions) {
    this.binaryPath = options.binaryPath ?? process.env.GSD_BIN_PATH ?? 'gsd'
    this.cwd = options.cwd
    this.onEvent = options.onEvent
    this.onConnectionChange = options.onConnectionChange
    this.onError = options.onError
  }

  get isConnected(): boolean {
    return this.process !== null && this.process.exitCode === null
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Spawn the gsd agent in RPC mode.
   */
  async start(): Promise<void> {
    if (this.process || this.disposed) return

    const args = ['--mode', 'rpc', '--no-session']
    console.log(`[gsd-service] spawning: ${this.binaryPath} ${args.join(' ')}`)

    this.process = spawn(this.binaryPath, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    })

    const pid = this.process.pid
    console.log(`[gsd-service] spawned gsd --mode rpc (pid: ${pid})`)

    this.buffer = ''

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      this.drainBuffer()
    })

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) {
        this.lastError = text
        this.onError(text)
      }
    })

    this.process.on('exit', (code, signal) => {
      console.log(`[gsd-service] process exited (code=${code}, signal=${signal})`)
      this.process = null
      this.lastExitCode = code
      this.rejectAllPending(`GSD process exited (code=${code}, signal=${signal})`)
      this.onConnectionChange(false)

      // Crash recovery: non-zero exit that isn't our own SIGTERM
      if (code !== 0 && signal !== 'SIGTERM' && !this.disposed) {
        const now = Date.now()
        this.restartTimestamps.push(now)
        // Keep only timestamps within the last 60 seconds
        this.restartTimestamps = this.restartTimestamps.filter((t) => now - t < 60_000)

        if (this.restartTimestamps.length > 3) {
          const msg = `[gsd-service] process crashed ${this.restartTimestamps.length} times within 60s — not restarting`
          console.error(msg)
          this.onError(msg)
        } else if (this.restartCount < 3) {
          this.restartCount++
          const delay = 1000 * this.restartCount
          console.log(
            `[gsd-service] crash detected, restarting in ${delay}ms (attempt ${this.restartCount}/3)`
          )
          setTimeout(() => this.start(), delay)
        }
      }
    })

    this.onConnectionChange(true)
    this.restartCount = 0
  }

  /**
   * Gracefully stop the gsd agent process.
   * SIGTERM with 2s SIGKILL fallback.
   */
  async stop(): Promise<void> {
    if (!this.process) return

    const proc = this.process
    this.process = null
    console.log(`[gsd-service] stopping process (pid: ${proc.pid})`)
    proc.kill('SIGTERM')

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.log(`[gsd-service] SIGTERM timeout, sending SIGKILL`)
        proc.kill('SIGKILL')
        resolve()
      }, 2000)
      proc.on('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })

    this.rejectAllPending('Client stopped')
    this.onConnectionChange(false)
  }

  /**
   * Full cleanup — stop process, clear state, mark as disposed.
   */
  dispose(): void {
    console.log('[gsd-service] disposing')
    this.disposed = true
    this.stop()
  }

  // ==========================================================================
  // Command API
  // ==========================================================================

  /**
   * Send a command to the agent and wait for a correlated response.
   */
  send(command: Record<string, unknown>): Promise<RpcResponse> {
    if (!this.process?.stdin) {
      return Promise.reject(new Error('GSD service not started'))
    }

    const id = `req_${++this.requestId}`
    const fullCommand = { ...command, id }
    const commandType = String(command.type ?? 'unknown')

    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Timeout waiting for response to ${commandType} (id=${id})`))
      }, this.requestTimeoutMs)

      this.pendingRequests.set(id, { resolve, reject, timer, command: commandType })
      this.process!.stdin!.write(JSON.stringify(fullCommand) + '\n')
    })
  }

  /** Send a prompt message. */
  async sendPrompt(message: string): Promise<RpcResponse> {
    return this.send({ type: 'prompt', message })
  }

  /** Get current session state. */
  async getState(): Promise<RpcResponse> {
    return this.send({ type: 'get_state' })
  }

  /** Abort current operation. */
  async abort(): Promise<RpcResponse> {
    return this.send({ type: 'abort' })
  }

  // ==========================================================================
  // JSONL framing — LF-only splitting (no readline)
  // ==========================================================================

  /**
   * Drain the buffer, extracting complete lines delimited by LF (0x0A).
   * Handles CR+LF by stripping trailing CR. Skips empty lines.
   * Does NOT split on U+2028 or U+2029 — they are valid inside JSON strings.
   */
  private drainBuffer(): void {
    while (true) {
      const newlineIdx = this.buffer.indexOf('\n')
      if (newlineIdx === -1) break

      let line = this.buffer.slice(0, newlineIdx)
      this.buffer = this.buffer.slice(newlineIdx + 1)

      // Strip optional trailing CR
      if (line.endsWith('\r')) {
        line = line.slice(0, -1)
      }

      // Skip empty lines
      if (!line) continue

      this.handleLine(line)
    }
  }

  /**
   * Process a single JSONL line.
   * Routes responses to pending requests, auto-responds to extension UI,
   * and forwards everything else as events.
   */
  private handleLine(line: string): void {
    let data: Record<string, unknown>
    try {
      data = JSON.parse(line)
    } catch {
      // Silently ignore non-JSON lines (e.g. startup banners)
      return
    }

    // Route response to pending request
    if (
      data.type === 'response' &&
      typeof data.id === 'string' &&
      this.pendingRequests.has(data.id)
    ) {
      const pending = this.pendingRequests.get(data.id)!
      this.pendingRequests.delete(data.id)
      clearTimeout(pending.timer)
      pending.resolve(data as unknown as RpcResponse)
      return
    }

    // Handle extension UI requests
    if (data.type === 'extension_ui_request' && typeof data.method === 'string') {
      this.handleExtensionUIRequest(data)
    }

    // Forward all events (including extension_ui_request) to renderer
    this.onEvent(data as AgentEvent)
  }

  // ==========================================================================
  // Extension UI auto-responder
  // ==========================================================================

  /**
   * Auto-respond to interactive extension UI requests so the agent never blocks.
   * Fire-and-forget methods are forwarded as events without response.
   */
  private handleExtensionUIRequest(data: Record<string, unknown>): void {
    const method = data.method as string
    const id = data.id as string

    // Fire-and-forget methods need no response
    if (FIRE_AND_FORGET_METHODS.has(method)) return

    // Interactive methods — auto-respond with sensible defaults
    let response: RpcExtensionUIResponse | null = null

    switch (method) {
      case 'select':
        response = {
          type: 'extension_ui_response',
          id,
          value: Array.isArray(data.options) && data.options.length > 0
            ? String(data.options[0])
            : ''
        }
        break
      case 'confirm':
        response = { type: 'extension_ui_response', id, confirmed: true }
        break
      case 'input':
        response = { type: 'extension_ui_response', id, value: '' }
        break
      case 'editor':
        response = {
          type: 'extension_ui_response',
          id,
          value: typeof data.prefill === 'string' ? data.prefill : ''
        }
        break
      default:
        // Unknown interactive method — cancel to unblock
        response = { type: 'extension_ui_response', id, cancelled: true }
        break
    }

    if (response && this.process?.stdin) {
      console.warn(
        `[gsd-service] auto-responding to extension_ui_request (method=${method}, id=${id})`
      )
      this.process.stdin.write(JSON.stringify(response) + '\n')
    }
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`${reason} [pending: ${pending.command}, id=${id}]`))
    }
    this.pendingRequests.clear()
  }
}
