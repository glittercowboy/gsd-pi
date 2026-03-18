/**
 * Self-contained RPC protocol types for GSD Studio.
 *
 * These are simplified copies of the canonical types from
 * packages/pi-coding-agent/src/modes/rpc/rpc-types.ts.
 * Zero imports from any agent package — studio must be fully decoupled.
 */

// ============================================================================
// Shared primitives
// ============================================================================

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'

export interface ModelInfo {
  provider: string
  id: string
  contextWindow?: number
  reasoning?: boolean
}

export interface SessionStats {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalCost?: number
  messageCount?: number
  turnCount?: number
  duration?: number
}

// ============================================================================
// RPC Commands (stdin → agent)
// ============================================================================

export type RpcCommand =
  // Prompting
  | { id?: string; type: 'prompt'; message: string; streamingBehavior?: 'steer' | 'followUp' }
  | { id?: string; type: 'steer'; message: string }
  | { id?: string; type: 'follow_up'; message: string }
  | { id?: string; type: 'abort' }
  | { id?: string; type: 'new_session'; parentSession?: string }

  // State
  | { id?: string; type: 'get_state' }

  // Model
  | { id?: string; type: 'set_model'; provider: string; modelId: string }
  | { id?: string; type: 'cycle_model' }
  | { id?: string; type: 'get_available_models' }

  // Thinking
  | { id?: string; type: 'set_thinking_level'; level: ThinkingLevel }
  | { id?: string; type: 'cycle_thinking_level' }

  // Compaction
  | { id?: string; type: 'compact'; customInstructions?: string }
  | { id?: string; type: 'set_auto_compaction'; enabled: boolean }

  // Session
  | { id?: string; type: 'get_session_stats' }
  | { id?: string; type: 'get_messages' }
  | { id?: string; type: 'get_commands' }

export type RpcCommandType = RpcCommand['type']

// ============================================================================
// RPC Responses (agent → stdout)
// ============================================================================

export interface RpcResponse {
  id?: string
  type: 'response'
  command: string
  success: boolean
  data?: unknown
  error?: string
}

// ============================================================================
// RPC Session State
// ============================================================================

export interface RpcSessionState {
  model?: ModelInfo
  thinkingLevel: ThinkingLevel
  isStreaming: boolean
  isCompacting: boolean
  steeringMode: 'all' | 'one-at-a-time'
  followUpMode: 'all' | 'one-at-a-time'
  sessionFile?: string
  sessionId: string
  sessionName?: string
  autoCompactionEnabled: boolean
  messageCount: number
  pendingMessageCount: number
}

// ============================================================================
// Agent Events (generic streaming events)
// ============================================================================

export interface AgentEvent {
  type: string
  [key: string]: unknown
}

// ============================================================================
// Extension UI Protocol
// ============================================================================

export type RpcExtensionUIRequest =
  // Interactive — require response
  | {
      type: 'extension_ui_request'
      id: string
      method: 'select'
      title: string
      options: string[]
      timeout?: number
      allowMultiple?: boolean
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'confirm'
      title: string
      message: string
      timeout?: number
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'input'
      title: string
      placeholder?: string
      timeout?: number
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'editor'
      title: string
      prefill?: string
    }
  // Fire-and-forget — no response needed
  | {
      type: 'extension_ui_request'
      id: string
      method: 'notify'
      message: string
      notifyType?: 'info' | 'warning' | 'error'
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'setStatus'
      statusKey: string
      statusText: string | undefined
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'setWidget'
      widgetKey: string
      widgetLines: string[] | undefined
      widgetPlacement?: 'aboveEditor' | 'belowEditor'
    }
  | { type: 'extension_ui_request'; id: string; method: 'setTitle'; title: string }
  | { type: 'extension_ui_request'; id: string; method: 'set_editor_text'; text: string }

export type RpcExtensionUIResponse =
  | { type: 'extension_ui_response'; id: string; value: string }
  | { type: 'extension_ui_response'; id: string; values: string[] }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean }
  | { type: 'extension_ui_response'; id: string; cancelled: true }

// ============================================================================
// Fire-and-forget classification
// ============================================================================

/** Extension UI methods that need no response — purely informational. */
export const FIRE_AND_FORGET_METHODS = new Set([
  'notify',
  'setStatus',
  'setWidget',
  'setTitle',
  'set_editor_text'
])
