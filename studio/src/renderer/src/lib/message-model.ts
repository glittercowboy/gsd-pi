// ---------------------------------------------------------------------------
// Message Model — pure transformer from StoreEvent[] → MessageBlock[]
// No React dependencies. Importable in Node tests.
// ---------------------------------------------------------------------------

import type { StoreEvent } from '@/stores/session-store'

// ---------------------------------------------------------------------------
// Block types
// ---------------------------------------------------------------------------

export type AssistantTextBlock = {
  type: 'assistant-text'
  id: string
  content: string
}

export type ToolUseBlock = {
  type: 'tool-use'
  id: string
  toolName: string
  toolCallId: string
  status: 'running' | 'done' | 'error'
  args?: unknown
  result?: unknown
}

export type UserPromptBlock = {
  type: 'user-prompt'
  id: string
  text: string
}

export type MessageBlock = AssistantTextBlock | ToolUseBlock | UserPromptBlock

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve event type from either `data.type` or `data.event` (K005). */
function getEventType(data: Record<string, unknown>): string {
  return String(data.type ?? data.event ?? 'unknown')
}

/**
 * Extract accumulated text from a message_update event.
 * The event shape is `{ message: { content: [{ type: 'text', text: '...' }, ...] } }`.
 * We concatenate all text entries from the content array (strategy b — read accumulated snapshot).
 */
function extractTextContent(data: Record<string, unknown>): string {
  const message = data.message as Record<string, unknown> | undefined
  if (!message) return ''

  const content = message.content as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(content)) return ''

  let text = ''
  for (const entry of content) {
    if (entry.type === 'text' && typeof entry.text === 'string') {
      text += entry.text
    }
  }
  return text
}

// ---------------------------------------------------------------------------
// Main transformer
// ---------------------------------------------------------------------------

/**
 * Derives a structured `MessageBlock[]` from raw store events.
 *
 * Pure function — idempotent, no side effects. Re-derives from scratch on
 * each call. Memoization happens at the React layer (useMemo keyed on events).
 */
export function buildMessageBlocks(events: StoreEvent[]): MessageBlock[] {
  const blocks: MessageBlock[] = []
  // Track the current assistant-text block being accumulated within a turn.
  // A new turn starts at each agent_start.
  let currentAssistantBlock: AssistantTextBlock | null = null
  // Map toolCallId → index in blocks[] for efficient lookup on tool_execution_end.
  const toolBlockIndex = new Map<string, number>()

  for (const event of events) {
    const { data } = event
    const eventType = getEventType(data)

    switch (eventType) {
      case 'agent_start': {
        // End any prior assistant text accumulation.
        currentAssistantBlock = null

        // If prompt info is present, create a user-prompt block.
        const prompt =
          (data.prompt as string | undefined) ??
          (data.message as string | undefined)
        if (prompt) {
          blocks.push({
            type: 'user-prompt',
            id: `user-${event.id}`,
            text: prompt
          })
        }
        break
      }

      case 'message_update': {
        const text = extractTextContent(data)
        if (!text) break

        if (currentAssistantBlock) {
          // Update the existing block's content with the latest accumulated text.
          currentAssistantBlock.content = text
        } else {
          // Start a new assistant-text block for this turn.
          currentAssistantBlock = {
            type: 'assistant-text',
            id: `assistant-${event.id}`,
            content: text
          }
          blocks.push(currentAssistantBlock)
        }
        break
      }

      case 'tool_execution_start': {
        const toolName = String(data.tool_name ?? data.toolName ?? 'unknown')
        const toolCallId = String(data.tool_call_id ?? data.toolCallId ?? `tool-${event.id}`)
        const block: ToolUseBlock = {
          type: 'tool-use',
          id: `tool-${event.id}`,
          toolName,
          toolCallId,
          status: 'running',
          args: data.args ?? data.input
        }
        toolBlockIndex.set(toolCallId, blocks.length)
        blocks.push(block)
        // A tool invocation interrupts the current text run — the next
        // message_update will start a new assistant-text block.
        currentAssistantBlock = null
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String(data.tool_call_id ?? data.toolCallId ?? '')
        const idx = toolBlockIndex.get(toolCallId)
        if (idx !== undefined) {
          const block = blocks[idx] as ToolUseBlock
          const hasError = data.error === true || data.status === 'error'
          block.status = hasError ? 'error' : 'done'
          block.result = data.result ?? data.output
        }
        break
      }

      case 'agent_end':
      case 'stderr':
      case 'state_update':
      default:
        // Non-renderable — skip.
        break
    }
  }

  return blocks
}
