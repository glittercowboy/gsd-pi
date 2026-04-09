/**
 * Tests for headless v2 migration — execution_complete handling,
 * sendUIResponse-based auto-response, and v1 fallback behavior.
 *
 * Uses extracted logic mirrors to avoid importing modules with native
 * dependencies (same pattern as headless-events.test.ts and headless-detection.test.ts).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// ─── Extracted exit codes (mirrors headless-events.ts) ──────────────────────

const EXIT_SUCCESS = 0
const EXIT_ERROR = 1
const EXIT_BLOCKED = 10

function mapStatusToExitCode(status: string): number {
  switch (status) {
    case 'success':
    case 'complete':
      return EXIT_SUCCESS
    case 'error':
    case 'timeout':
      return EXIT_ERROR
    case 'blocked':
      return EXIT_BLOCKED
    case 'cancelled':
      return 11
    default:
      return EXIT_ERROR
  }
}

// ─── Extracted terminal detection (mirrors headless-events.ts) ──────────────

const TERMINAL_PREFIXES = ['auto-mode stopped', 'step-mode stopped']

function isTerminalNotification(event: Record<string, unknown>): boolean {
  if (event.type !== 'extension_ui_request' || event.method !== 'notify') return false
  const message = String(event.message ?? '').toLowerCase()
  return TERMINAL_PREFIXES.some((prefix) => message.startsWith(prefix))
}

function isBlockedNotification(event: Record<string, unknown>): boolean {
  if (event.type !== 'extension_ui_request' || event.method !== 'notify') return false
  const message = String(event.message ?? '').toLowerCase()
  return message.includes('blocked:')
}

// ─── Mock RpcClient ─────────────────────────────────────────────────────────

interface SendUICall {
  id: string
  response: { value?: string; values?: string[]; confirmed?: boolean; cancelled?: boolean }
}

class MockRpcClient {
  sendUICalls: SendUICall[] = []
  initCalled = false
  initShouldFail = false

  sendUIResponse(id: string, response: { value?: string; values?: string[]; confirmed?: boolean; cancelled?: boolean }): void {
    this.sendUICalls.push({ id, response })
  }

  async init(_options?: { clientId?: string }): Promise<{ protocolVersion: number }> {
    this.initCalled = true
    if (this.initShouldFail) {
      throw new Error('v2 init not supported')
    }
    return { protocolVersion: 2 }
  }
}

// ─── Extracted handleExtensionUIRequest (mirrors headless-ui.ts) ────────────

interface ExtensionUIRequest {
  type: 'extension_ui_request'
  id: string
  method: string
  title?: string
  options?: string[]
  message?: string
  prefill?: string
  [key: string]: unknown
}

function handleExtensionUIRequest(
  event: ExtensionUIRequest,
  client: MockRpcClient,
): void {
  const { id, method } = event

  switch (method) {
    case 'select': {
      const title = String(event.title ?? '')
      let selected = event.options?.[0] ?? ''
      if (title.includes('Auto-mode is running') && event.options) {
        const forceOption = event.options.find(o => o.toLowerCase().includes('force start'))
        if (forceOption) selected = forceOption
      }
      client.sendUIResponse(id, { value: selected })
      break
    }
    case 'confirm':
      client.sendUIResponse(id, { confirmed: true })
      break
    case 'input':
      client.sendUIResponse(id, { value: '' })
      break
    case 'editor':
      client.sendUIResponse(id, { value: event.prefill ?? '' })
      break
    case 'notify':
    case 'setStatus':
    case 'setWidget':
    case 'setTitle':
    case 'set_editor_text':
      client.sendUIResponse(id, { value: '' })
      break
    default:
      client.sendUIResponse(id, { cancelled: true })
      break
  }
}

// ─── Simulated event handler (mirrors headless.ts event handler logic) ──────

interface EventHandlerState {
  completed: boolean
  blocked: boolean
  exitCode: number
  v2Enabled: boolean
  isMultiTurnCommand?: boolean
}

function handleEvent(
  eventObj: Record<string, unknown>,
  state: EventHandlerState,
  client: MockRpcClient,
): void {
  // execution_complete (v2 structured completion)
  // Skip for multi-turn commands (auto, next) — their completion is detected via
  // isTerminalNotification, not per-turn events
  if (eventObj.type === 'execution_complete' && !state.completed && !state.isMultiTurnCommand) {
    state.completed = true
    const status = String(eventObj.status ?? 'success')
    state.exitCode = mapStatusToExitCode(status)
    if (eventObj.status === 'blocked') state.blocked = true
    return
  }

  // extension_ui_request (v1 fallback + UI responses)
  if (eventObj.type === 'extension_ui_request') {
    if (isBlockedNotification(eventObj)) {
      state.blocked = true
    }

    if (isTerminalNotification(eventObj)) {
      state.completed = true
    }

    handleExtensionUIRequest(eventObj as unknown as ExtensionUIRequest, client)

    if (state.completed) {
      state.exitCode = state.blocked ? EXIT_BLOCKED : EXIT_SUCCESS
      return
    }
  }
}

// ─── execution_complete event handling ──────────────────────────────────────

test('execution_complete with status success triggers completion with EXIT_SUCCESS', () => {
  const client = new MockRpcClient()
  const state: EventHandlerState = { completed: false, blocked: false, exitCode: -1, v2Enabled: true }

  handleEvent({ type: 'execution_complete', status: 'success' }, state, client)

  assert.equal(state.completed, true)
  assert.equal(state.exitCode, EXIT_SUCCESS)
  assert.equal(state.blocked, false)
})

test('execution_complete with status blocked sets blocked flag and EXIT_BLOCKED', () => {
  const client = new MockRpcClient()
  const state: EventHandlerState = { completed: false, blocked: false, exitCode: -1, v2Enabled: true }

  handleEvent({ type: 'execution_complete', status: 'blocked' }, state, client)

  assert.equal(state.completed, true)
  assert.equal(state.blocked, true)
  assert.equal(state.exitCode, EXIT_BLOCKED)
})

test('execution_complete with status error maps to EXIT_ERROR', () => {
  const client = new MockRpcClient()
  const state: EventHandlerState = { completed: false, blocked: false, exitCode: -1, v2Enabled: true }

  handleEvent({ type: 'execution_complete', status: 'error' }, state, client)

  assert.equal(state.completed, true)
  assert.equal(state.exitCode, EXIT_ERROR)
})

test('execution_complete with missing status defaults to success', () => {
  const client = new MockRpcClient()
  const state: EventHandlerState = { completed: false, blocked: false, exitCode: -1, v2Enabled: true }

  handleEvent({ type: 'execution_complete' }, state, client)

  assert.equal(state.completed, true)
  assert.equal(state.exitCode, EXIT_SUCCESS)
})

test('execution_complete ignored if already completed', () => {
  const client = new MockRpcClient()
  const state: EventHandlerState = { completed: true, blocked: false, exitCode: EXIT_SUCCESS, v2Enabled: true }

  handleEvent({ type: 'execution_complete', status: 'error' }, state, client)

  // Should not change exitCode because already completed
  assert.equal(state.exitCode, EXIT_SUCCESS)
})

// ─── v1 string-matching fallback ────────────────────────────────────────────

test('v1 fallback: terminal notification still triggers completion', () => {
  const client = new MockRpcClient()
  const state: EventHandlerState = { completed: false, blocked: false, exitCode: -1, v2Enabled: false }

  handleEvent(
    { type: 'extension_ui_request', method: 'notify', id: 'n1', message: 'Auto-mode stopped — all slices complete' },
    state,
    client,
  )

  assert.equal(state.completed, true)
  assert.equal(state.exitCode, EXIT_SUCCESS)
})

test('v1 fallback: blocked notification sets blocked flag', () => {
  const client = new MockRpcClient()
  const state: EventHandlerState = { completed: false, blocked: false, exitCode: -1, v2Enabled: false }

  handleEvent(
    { type: 'extension_ui_request', method: 'notify', id: 'n1', message: 'Auto-mode stopped (Blocked: plan invalid)' },
    state,
    client,
  )

  assert.equal(state.completed, true)
  assert.equal(state.blocked, true)
  assert.equal(state.exitCode, EXIT_BLOCKED)
})

test('string-matching fallback works when execution_complete never received', () => {
  const client = new MockRpcClient()
  const state: EventHandlerState = { completed: false, blocked: false, exitCode: -1, v2Enabled: false }

  // Simulate a normal session without execution_complete
  handleEvent({ type: 'extension_ui_request', method: 'select', id: 'q1', options: ['option1'] }, state, client)
  assert.equal(state.completed, false)

  handleEvent(
    { type: 'extension_ui_request', method: 'notify', id: 'n1', message: 'Step-mode stopped — done' },
    state,
    client,
  )
  assert.equal(state.completed, true)
  assert.equal(state.exitCode, EXIT_SUCCESS)
})

// ─── handleExtensionUIRequest uses client.sendUIResponse ────────────────────

test('handleExtensionUIRequest select calls sendUIResponse with value', () => {
  const client = new MockRpcClient()

  handleExtensionUIRequest(
    { type: 'extension_ui_request', id: 'sel1', method: 'select', options: ['option-a', 'option-b'] },
    client,
  )

  assert.equal(client.sendUICalls.length, 1)
  assert.equal(client.sendUICalls[0].id, 'sel1')
  assert.equal(client.sendUICalls[0].response.value, 'option-a')
})

test('handleExtensionUIRequest confirm calls sendUIResponse with confirmed', () => {
  const client = new MockRpcClient()

  handleExtensionUIRequest(
    { type: 'extension_ui_request', id: 'conf1', method: 'confirm' },
    client,
  )

  assert.equal(client.sendUICalls.length, 1)
  assert.equal(client.sendUICalls[0].id, 'conf1')
  assert.equal(client.sendUICalls[0].response.confirmed, true)
})

test('handleExtensionUIRequest input calls sendUIResponse with empty value', () => {
  const client = new MockRpcClient()

  handleExtensionUIRequest(
    { type: 'extension_ui_request', id: 'inp1', method: 'input' },
    client,
  )

  assert.equal(client.sendUICalls.length, 1)
  assert.equal(client.sendUICalls[0].id, 'inp1')
  assert.equal(client.sendUICalls[0].response.value, '')
})

test('handleExtensionUIRequest notify calls sendUIResponse with empty value', () => {
  const client = new MockRpcClient()

  handleExtensionUIRequest(
    { type: 'extension_ui_request', id: 'not1', method: 'notify', message: 'Task complete' },
    client,
  )

  assert.equal(client.sendUICalls.length, 1)
  assert.equal(client.sendUICalls[0].id, 'not1')
  assert.equal(client.sendUICalls[0].response.value, '')
})

test('handleExtensionUIRequest editor calls sendUIResponse with prefill', () => {
  const client = new MockRpcClient()

  handleExtensionUIRequest(
    { type: 'extension_ui_request', id: 'ed1', method: 'editor', prefill: 'initial text' },
    client,
  )

  assert.equal(client.sendUICalls.length, 1)
  assert.equal(client.sendUICalls[0].id, 'ed1')
  assert.equal(client.sendUICalls[0].response.value, 'initial text')
})

test('handleExtensionUIRequest unknown method calls sendUIResponse with cancelled', () => {
  const client = new MockRpcClient()

  handleExtensionUIRequest(
    { type: 'extension_ui_request', id: 'unk1', method: 'unknown_method' },
    client,
  )

  assert.equal(client.sendUICalls.length, 1)
  assert.equal(client.sendUICalls[0].id, 'unk1')
  assert.equal(client.sendUICalls[0].response.cancelled, true)
})

// ─── supervised stdin reader forwarding via sendUIResponse ──────────────────

test('extension_ui_response forwarding extracts fields and calls sendUIResponse', () => {
  // Simulates what startSupervisedStdinReader does with a parsed message
  const client = new MockRpcClient()

  const msg = { type: 'extension_ui_response', id: 'resp1', value: 'chosen option', confirmed: undefined, cancelled: undefined }
  const id = String(msg.id ?? '')
  const value = msg.value !== undefined ? String(msg.value) : undefined
  const confirmed = typeof msg.confirmed === 'boolean' ? msg.confirmed : undefined
  const cancelled = typeof msg.cancelled === 'boolean' ? msg.cancelled : undefined
  client.sendUIResponse(id, { value, confirmed, cancelled })

  assert.equal(client.sendUICalls.length, 1)
  assert.equal(client.sendUICalls[0].id, 'resp1')
  assert.equal(client.sendUICalls[0].response.value, 'chosen option')
  assert.equal(client.sendUICalls[0].response.confirmed, undefined)
  assert.equal(client.sendUICalls[0].response.cancelled, undefined)
})

test('extension_ui_response with confirmed=true forwards correctly', () => {
  const client = new MockRpcClient()

  const msg = { type: 'extension_ui_response', id: 'resp2', confirmed: true }
  const id = String(msg.id ?? '')
  const confirmed = typeof msg.confirmed === 'boolean' ? msg.confirmed : undefined
  client.sendUIResponse(id, { confirmed })

  assert.equal(client.sendUICalls.length, 1)
  assert.equal(client.sendUICalls[0].id, 'resp2')
  assert.equal(client.sendUICalls[0].response.confirmed, true)
})

// ─── v2 init negotiation ────────────────────────────────────────────────────

test('v2 init success sets v2Enabled', async () => {
  const client = new MockRpcClient()
  let v2Enabled = false
  try {
    await client.init({ clientId: 'gsd-headless' })
    v2Enabled = true
  } catch {
    // fall back to v1
  }

  assert.equal(client.initCalled, true)
  assert.equal(v2Enabled, true)
})

test('v2 init failure falls back gracefully (v1 mode)', async () => {
  const client = new MockRpcClient()
  client.initShouldFail = true
  let v2Enabled = false
  try {
    await client.init({ clientId: 'gsd-headless' })
    v2Enabled = true
  } catch {
    // fall back to v1 — this is expected
  }

  assert.equal(client.initCalled, true)
  assert.equal(v2Enabled, false)
})

// ─── injector adapter ───────────────────────────────────────────────────────

test('injector adapter parses serialized JSONL and calls sendUIResponse', () => {
  const client = new MockRpcClient()

  // Simulate what the adapter does
  const data = '{"type":"extension_ui_response","id":"inj1","value":"selected"}\n'
  const parsed = JSON.parse(data.trim())
  if (parsed.type === 'extension_ui_response' && parsed.id) {
    const { id, value, values, confirmed, cancelled } = parsed
    client.sendUIResponse(id, { value, values, confirmed, cancelled })
  }

  assert.equal(client.sendUICalls.length, 1)
  assert.equal(client.sendUICalls[0].id, 'inj1')
  assert.equal(client.sendUICalls[0].response.value, 'selected')
})

test('injector adapter handles cancelled response', () => {
  const client = new MockRpcClient()

  const data = '{"type":"extension_ui_response","id":"inj2","cancelled":true}\n'
  const parsed = JSON.parse(data.trim())
  if (parsed.type === 'extension_ui_response' && parsed.id) {
    const { id, value, values, confirmed, cancelled } = parsed
    client.sendUIResponse(id, { value, values, confirmed, cancelled })
  }

  assert.equal(client.sendUICalls.length, 1)
  assert.equal(client.sendUICalls[0].id, 'inj2')
  assert.equal(client.sendUICalls[0].response.cancelled, true)
})

test('injector adapter handles multi-select values', () => {
  const client = new MockRpcClient()

  const data = '{"type":"extension_ui_response","id":"inj3","values":["a","b"]}\n'
  const parsed = JSON.parse(data.trim())
  if (parsed.type === 'extension_ui_response' && parsed.id) {
    const { id, value, values, confirmed, cancelled } = parsed
    client.sendUIResponse(id, { value, values, confirmed, cancelled })
  }

  assert.equal(client.sendUICalls.length, 1)
  assert.equal(client.sendUICalls[0].id, 'inj3')
  assert.deepEqual(client.sendUICalls[0].response.values, ['a', 'b'])
})

// ─── multi-turn command (auto/next) skips execution_complete ───────────────

test('execution_complete is ignored for multi-turn commands (auto)', () => {
  const client = new MockRpcClient()
  const state: EventHandlerState = { completed: false, blocked: false, exitCode: -1, v2Enabled: true, isMultiTurnCommand: true }

  handleEvent({ type: 'execution_complete', status: 'success' }, state, client)

  assert.equal(state.completed, false, 'should not mark completed for auto/next commands')
  assert.equal(state.exitCode, -1, 'exit code should remain unchanged')
})

test('execution_complete is ignored for multi-turn commands even with error status', () => {
  const client = new MockRpcClient()
  const state: EventHandlerState = { completed: false, blocked: false, exitCode: -1, v2Enabled: true, isMultiTurnCommand: true }

  handleEvent({ type: 'execution_complete', status: 'error' }, state, client)

  assert.equal(state.completed, false, 'should not mark completed for auto/next commands')
  assert.equal(state.exitCode, -1, 'exit code should remain unchanged')
})

test('multi-turn commands still complete via terminal notification', () => {
  const client = new MockRpcClient()
  const state: EventHandlerState = { completed: false, blocked: false, exitCode: -1, v2Enabled: true, isMultiTurnCommand: true }

  // First, execution_complete fires (should be ignored)
  handleEvent({ type: 'execution_complete', status: 'success' }, state, client)
  assert.equal(state.completed, false, 'execution_complete should be skipped')

  // Then the real terminal notification fires
  handleEvent(
    { type: 'extension_ui_request', method: 'notify', id: 'n1', message: 'Auto-mode stopped — all slices complete' },
    state,
    client,
  )
  assert.equal(state.completed, true, 'terminal notification should trigger completion')
  assert.equal(state.exitCode, EXIT_SUCCESS)
})

test('multi-turn commands detect blocked via terminal notification', () => {
  const client = new MockRpcClient()
  const state: EventHandlerState = { completed: false, blocked: false, exitCode: -1, v2Enabled: true, isMultiTurnCommand: true }

  // execution_complete is ignored
  handleEvent({ type: 'execution_complete', status: 'success' }, state, client)
  assert.equal(state.completed, false)

  // Blocked terminal notification
  handleEvent(
    { type: 'extension_ui_request', method: 'notify', id: 'n2', message: 'Auto-mode stopped (Blocked: plan rejected)' },
    state,
    client,
  )
  assert.equal(state.completed, true)
  assert.equal(state.blocked, true)
  assert.equal(state.exitCode, EXIT_BLOCKED)
})

test('non-multi-turn commands still complete on execution_complete', () => {
  const client = new MockRpcClient()
  const state: EventHandlerState = { completed: false, blocked: false, exitCode: -1, v2Enabled: true, isMultiTurnCommand: false }

  handleEvent({ type: 'execution_complete', status: 'success' }, state, client)

  assert.equal(state.completed, true, 'single-turn commands should complete on execution_complete')
  assert.equal(state.exitCode, EXIT_SUCCESS)
})
