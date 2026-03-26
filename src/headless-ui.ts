/**
 * Headless UI Handling — auto-response, progress formatting, and supervised stdin
 *
 * Handles extension UI requests (auto-responding in headless mode),
 * formats progress events for stderr output, and reads orchestrator
 * commands from stdin in supervised mode.
 */

import type { Readable } from 'node:stream'

import { RpcClient, attachJsonlLineReader, serializeJsonLine } from '@gsd/pi-coding-agent'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

export type { ExtensionUIRequest }

// ---------------------------------------------------------------------------
// Extension UI Auto-Responder
// ---------------------------------------------------------------------------

export function handleExtensionUIRequest(
  event: ExtensionUIRequest,
  writeToStdin: (data: string) => void,
): void {
  const { id, method } = event
  let response: Record<string, unknown>

  switch (method) {
    case 'select': {
      // Lock-guard prompts list "View status" first, but headless needs "Force start"
      // to proceed. Detect by title and pick the force option.
      const title = String(event.title ?? '')
      let selected = event.options?.[0] ?? ''
      if (title.includes('Auto-mode is running') && event.options) {
        const forceOption = event.options.find(o => o.toLowerCase().includes('force start'))
        if (forceOption) selected = forceOption
      }
      response = { type: 'extension_ui_response', id, value: selected }
      break
    }
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

export function formatProgress(event: Record<string, unknown>, verbose: boolean): string | null {
  const type = String(event.type ?? '')

  switch (type) {
    case 'tool_execution_start':
      if (verbose) return `  [tool]    ${event.toolName ?? 'unknown'}`
      return null

    case 'agent_start':
      return '[agent]   Session started'

    case 'agent_end':
      return '[agent]   Session ended'

    case 'extension_ui_request':
      if (event.method === 'notify') {
        return `[gsd]     ${event.message ?? ''}`
      }
      if (event.method === 'setStatus') {
        return `[status]  ${event.message ?? ''}`
      }
      return null

    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Supervised Stdin Reader
// ---------------------------------------------------------------------------

export function startSupervisedStdinReader(
  stdinWriter: (data: string) => void,
  client: RpcClient,
  onResponse: (id: string) => void,
): () => void {
  return attachJsonlLineReader(process.stdin as Readable, (line) => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line)
    } catch {
      process.stderr.write(`[headless] Warning: invalid JSON from orchestrator stdin, skipping\n`)
      return
    }

    const type = String(msg.type ?? '')

    switch (type) {
      case 'extension_ui_response':
        stdinWriter(line + '\n')
        if (typeof msg.id === 'string') {
          onResponse(msg.id)
        }
        break
      case 'prompt':
        client.prompt(String(msg.message ?? ''))
        break
      case 'steer':
        client.steer(String(msg.message ?? ''))
        break
      case 'follow_up':
        client.followUp(String(msg.message ?? ''))
        break
      default:
        process.stderr.write(`[headless] Warning: unknown message type "${type}" from orchestrator stdin\n`)
        break
    }
  })
}
