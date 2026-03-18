import test from 'node:test'
import assert from 'node:assert/strict'

// =============================================================================
// Replicate buildMessageBlocks logic for testing (K001 pattern — no bundler
// available for node --test, and the source uses TS path aliases).
// =============================================================================

function getEventType(data) {
  return String(data.type ?? data.event ?? 'unknown')
}

function extractTextContent(data) {
  const message = data.message
  if (!message) return ''
  const content = message.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const entry of content) {
    if (entry.type === 'text' && typeof entry.text === 'string') {
      text += entry.text
    }
  }
  return text
}

function buildMessageBlocks(events) {
  const blocks = []
  let currentAssistantBlock = null
  const toolBlockIndex = new Map()

  for (const event of events) {
    const { data } = event
    const eventType = getEventType(data)

    switch (eventType) {
      case 'agent_start': {
        currentAssistantBlock = null
        const prompt = data.prompt ?? data.message
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
          currentAssistantBlock.content = text
        } else {
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
        const block = {
          type: 'tool-use',
          id: `tool-${event.id}`,
          toolName,
          toolCallId,
          status: 'running',
          args: data.args ?? data.input
        }
        toolBlockIndex.set(toolCallId, blocks.length)
        blocks.push(block)
        currentAssistantBlock = null
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String(data.tool_call_id ?? data.toolCallId ?? '')
        const idx = toolBlockIndex.get(toolCallId)
        if (idx !== undefined) {
          const block = blocks[idx]
          const hasError = data.error === true || data.status === 'error'
          block.status = hasError ? 'error' : 'done'
          block.result = data.result ?? data.output
        }
        break
      }

      default:
        break
    }
  }

  return blocks
}

// =============================================================================
// Helpers
// =============================================================================

let eventIdCounter = 1

function makeEvent(data) {
  return { id: eventIdCounter++, timestamp: Date.now(), data }
}

// Reset counter before each test
test.beforeEach(() => {
  eventIdCounter = 1
})

// =============================================================================
// Tests
// =============================================================================

test('empty events array → empty blocks', () => {
  const blocks = buildMessageBlocks([])
  assert.deepStrictEqual(blocks, [])
})

test('single message_update with text content → one assistant-text block', () => {
  const events = [
    makeEvent({
      type: 'message_update',
      message: {
        content: [{ type: 'text', text: 'Hello, world!' }]
      }
    })
  ]

  const blocks = buildMessageBlocks(events)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'assistant-text')
  assert.equal(blocks[0].content, 'Hello, world!')
})

test('multiple message_update events with growing content → single block with latest text', () => {
  const events = [
    makeEvent({
      type: 'message_update',
      message: { content: [{ type: 'text', text: 'Hello' }] }
    }),
    makeEvent({
      type: 'message_update',
      message: { content: [{ type: 'text', text: 'Hello, world!' }] }
    }),
    makeEvent({
      type: 'message_update',
      message: { content: [{ type: 'text', text: 'Hello, world! How are you?' }] }
    })
  ]

  const blocks = buildMessageBlocks(events)
  assert.equal(blocks.length, 1, 'should produce exactly one assistant-text block')
  assert.equal(blocks[0].content, 'Hello, world! How are you?')
})

test('tool_execution_start + tool_execution_end → correct status transitions', () => {
  const events = [
    makeEvent({
      type: 'tool_execution_start',
      tool_name: 'read_file',
      tool_call_id: 'call_abc123',
      args: { path: '/foo.ts' }
    }),
    makeEvent({
      type: 'tool_execution_end',
      tool_call_id: 'call_abc123',
      result: 'file contents here'
    })
  ]

  const blocks = buildMessageBlocks(events)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'tool-use')
  assert.equal(blocks[0].toolName, 'read_file')
  assert.equal(blocks[0].toolCallId, 'call_abc123')
  assert.equal(blocks[0].status, 'done')
  assert.equal(blocks[0].result, 'file contents here')
})

test('agent_start with prompt → user-prompt block', () => {
  const events = [
    makeEvent({
      type: 'agent_start',
      prompt: 'Explain monads to me'
    })
  ]

  const blocks = buildMessageBlocks(events)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'user-prompt')
  assert.equal(blocks[0].text, 'Explain monads to me')
})

test('K005 — events using data.event instead of data.type are handled', () => {
  const events = [
    makeEvent({
      event: 'message_update',
      message: { content: [{ type: 'text', text: 'K005 test' }] }
    })
  ]

  const blocks = buildMessageBlocks(events)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'assistant-text')
  assert.equal(blocks[0].content, 'K005 test')
})

test('K005 — tool events using data.event are handled', () => {
  const events = [
    makeEvent({
      event: 'tool_execution_start',
      toolName: 'bash',
      toolCallId: 'call_xyz',
      input: { command: 'ls' }
    })
  ]

  const blocks = buildMessageBlocks(events)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'tool-use')
  assert.equal(blocks[0].toolName, 'bash')
  assert.equal(blocks[0].args.command, 'ls')
})

test('mixed sequence → correct block ordering and types', () => {
  const events = [
    makeEvent({ type: 'agent_start', prompt: 'Fix the bug' }),
    makeEvent({
      type: 'message_update',
      message: { content: [{ type: 'text', text: 'Let me look at the code.' }] }
    }),
    makeEvent({
      type: 'tool_execution_start',
      tool_name: 'read_file',
      tool_call_id: 'call_001'
    }),
    makeEvent({
      type: 'message_update',
      message: { content: [{ type: 'text', text: 'I see the issue. Let me fix it.' }] }
    }),
    makeEvent({
      type: 'tool_execution_end',
      tool_call_id: 'call_001',
      result: 'file contents'
    }),
    makeEvent({ type: 'agent_end' })
  ]

  const blocks = buildMessageBlocks(events)

  assert.equal(blocks.length, 4, `expected 4 blocks, got ${blocks.length}: ${blocks.map(b => b.type).join(', ')}`)

  // Block 0: user prompt
  assert.equal(blocks[0].type, 'user-prompt')
  assert.equal(blocks[0].text, 'Fix the bug')

  // Block 1: first assistant text (before tool call)
  assert.equal(blocks[1].type, 'assistant-text')
  assert.equal(blocks[1].content, 'Let me look at the code.')

  // Block 2: tool use
  assert.equal(blocks[2].type, 'tool-use')
  assert.equal(blocks[2].toolName, 'read_file')
  assert.equal(blocks[2].status, 'done')

  // Block 3: second assistant text (after tool call, new block because tool interrupted)
  assert.equal(blocks[3].type, 'assistant-text')
  assert.equal(blocks[3].content, 'I see the issue. Let me fix it.')
})

test('tool_execution_end with error → status is error', () => {
  const events = [
    makeEvent({
      type: 'tool_execution_start',
      tool_name: 'bash',
      tool_call_id: 'call_err'
    }),
    makeEvent({
      type: 'tool_execution_end',
      tool_call_id: 'call_err',
      error: true,
      result: 'command not found'
    })
  ]

  const blocks = buildMessageBlocks(events)
  assert.equal(blocks[0].status, 'error')
  assert.equal(blocks[0].result, 'command not found')
})

test('non-renderable events (stderr, state_update, agent_end) are skipped', () => {
  const events = [
    makeEvent({ type: 'stderr', message: 'warning: something' }),
    makeEvent({ type: 'state_update', data: { model: { provider: 'test', id: 'x' } } }),
    makeEvent({ type: 'agent_end' })
  ]

  const blocks = buildMessageBlocks(events)
  assert.equal(blocks.length, 0)
})

test('agent_start without prompt → no user-prompt block', () => {
  const events = [
    makeEvent({ type: 'agent_start' })
  ]

  const blocks = buildMessageBlocks(events)
  assert.equal(blocks.length, 0)
})

test('message_update with empty content → no block', () => {
  const events = [
    makeEvent({
      type: 'message_update',
      message: { content: [] }
    })
  ]

  const blocks = buildMessageBlocks(events)
  assert.equal(blocks.length, 0)
})

test('idempotency — calling with same events produces same result', () => {
  const events = [
    makeEvent({ type: 'agent_start', prompt: 'test' }),
    makeEvent({
      type: 'message_update',
      message: { content: [{ type: 'text', text: 'response' }] }
    })
  ]

  const blocks1 = buildMessageBlocks(events)
  const blocks2 = buildMessageBlocks(events)

  assert.equal(blocks1.length, blocks2.length)
  assert.equal(blocks1[0].type, blocks2[0].type)
  assert.equal(blocks1[0].id, blocks2[0].id)
  assert.equal(blocks1[1].type, blocks2[1].type)
  assert.equal(blocks1[1].content, blocks2[1].content)
})
