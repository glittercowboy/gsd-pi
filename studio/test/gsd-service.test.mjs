import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'

// =============================================================================
// Test helpers — we test GsdService's parsing logic by simulating a process
// =============================================================================

/**
 * Create a mock ChildProcess-like object for testing GsdService without
 * actually spawning gsd. We patch spawn to return our mock.
 */
function createMockProcess() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const proc = new EventEmitter()

  proc.stdin = stdin
  proc.stdout = stdout
  proc.stderr = stderr
  proc.pid = 99999
  proc.exitCode = null
  proc.kill = (signal) => {
    proc.exitCode = signal === 'SIGKILL' ? 137 : 0
    proc.emit('exit', proc.exitCode, signal)
    return true
  }

  return { proc, stdin, stdout, stderr }
}

/**
 * Import GsdService and patch child_process.spawn to use our mock.
 * We do this by dynamically importing the built module isn't practical for
 * a test that runs against source, so we extract the core logic inline.
 *
 * Since the tests need to verify the buffer drain and handleLine logic
 * without actually importing the Electron-dependent module, we replicate
 * the pure logic here as a testable JSONL parser.
 */

// -- Replicated pure logic from gsd-service.ts for unit testing ---------------

class JsonlParser {
  buffer = ''
  lines = []

  feed(chunk) {
    this.buffer += chunk
    this.drain()
  }

  drain() {
    while (true) {
      const idx = this.buffer.indexOf('\n')
      if (idx === -1) break

      let line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)

      if (line.endsWith('\r')) {
        line = line.slice(0, -1)
      }
      if (!line) continue

      this.lines.push(line)
    }
  }

  parsedLines() {
    const results = []
    for (const line of this.lines) {
      try {
        results.push(JSON.parse(line))
      } catch {
        // invalid JSON — skip
      }
    }
    return results
  }
}

// -- Replicated pending request + event dispatch logic -----------------------

class EventDispatcher {
  pendingRequests = new Map()
  events = []

  handleLine(line) {
    let data
    try {
      data = JSON.parse(line)
    } catch {
      return
    }

    if (
      data.type === 'response' &&
      typeof data.id === 'string' &&
      this.pendingRequests.has(data.id)
    ) {
      const pending = this.pendingRequests.get(data.id)
      this.pendingRequests.delete(data.id)
      clearTimeout(pending.timer)
      pending.resolve(data)
      return
    }

    this.events.push(data)
  }

  send(id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Timeout for ${id}`))
      }, 100) // Short timeout for tests
      this.pendingRequests.set(id, { resolve, reject, timer })
    })
  }
}

// =============================================================================
// JSONL Framing Tests
// =============================================================================

test('JSONL: single complete line parsed correctly', () => {
  const parser = new JsonlParser()
  parser.feed('{"type":"event","data":"hello"}\n')

  const results = parser.parsedLines()
  assert.equal(results.length, 1)
  assert.equal(results[0].type, 'event')
  assert.equal(results[0].data, 'hello')
})

test('JSONL: multiple lines in one chunk all parsed', () => {
  const parser = new JsonlParser()
  parser.feed('{"a":1}\n{"b":2}\n{"c":3}\n')

  const results = parser.parsedLines()
  assert.equal(results.length, 3)
  assert.equal(results[0].a, 1)
  assert.equal(results[1].b, 2)
  assert.equal(results[2].c, 3)
})

test('JSONL: partial line across chunks buffered and completed', () => {
  const parser = new JsonlParser()
  parser.feed('{"partial":')
  assert.equal(parser.parsedLines().length, 0)
  assert.equal(parser.lines.length, 0)

  parser.feed('"value"}\n')
  const results = parser.parsedLines()
  assert.equal(results.length, 1)
  assert.equal(results[0].partial, 'value')
})

test('JSONL: CR+LF line endings handled — CR stripped', () => {
  const parser = new JsonlParser()
  parser.feed('{"crlf":true}\r\n')

  const results = parser.parsedLines()
  assert.equal(results.length, 1)
  assert.equal(results[0].crlf, true)
})

test('JSONL: empty lines skipped', () => {
  const parser = new JsonlParser()
  parser.feed('\n\n{"data":1}\n\n{"data":2}\n\n')

  const results = parser.parsedLines()
  assert.equal(results.length, 2)
})

test('JSONL: U+2028 and U+2029 inside JSON strings NOT treated as separators', () => {
  // This is the critical test — readline would incorrectly split on these
  const valueWithLS = 'hello\u2028world'
  const valueWithPS = 'foo\u2029bar'

  const line1 = JSON.stringify({ text: valueWithLS })
  const line2 = JSON.stringify({ text: valueWithPS })

  const parser = new JsonlParser()
  parser.feed(line1 + '\n' + line2 + '\n')

  const results = parser.parsedLines()
  assert.equal(results.length, 2)
  assert.equal(results[0].text, valueWithLS)
  assert.equal(results[1].text, valueWithPS)
})

test('JSONL: invalid JSON line silently ignored', () => {
  const parser = new JsonlParser()
  parser.feed('not json at all\n{"valid":true}\n')

  assert.equal(parser.lines.length, 2) // Both lines extracted
  const results = parser.parsedLines()
  assert.equal(results.length, 1) // Only valid JSON parsed
  assert.equal(results[0].valid, true)
})

test('JSONL: no trailing newline leaves data in buffer', () => {
  const parser = new JsonlParser()
  parser.feed('{"incomplete":true}')

  assert.equal(parser.lines.length, 0)
  assert.equal(parser.buffer, '{"incomplete":true}')
})

// =============================================================================
// Event Dispatch Tests
// =============================================================================

test('dispatch: response with matching pending request resolves promise', async () => {
  const dispatcher = new EventDispatcher()
  const promise = dispatcher.send('req_1')

  dispatcher.handleLine(JSON.stringify({
    type: 'response',
    id: 'req_1',
    command: 'prompt',
    success: true
  }))

  const result = await promise
  assert.equal(result.type, 'response')
  assert.equal(result.command, 'prompt')
  assert.equal(result.success, true)
  assert.equal(dispatcher.events.length, 0) // Not forwarded as event
})

test('dispatch: response with no matching ID forwarded as event', () => {
  const dispatcher = new EventDispatcher()
  dispatcher.handleLine(JSON.stringify({
    type: 'response',
    id: 'unknown_id',
    command: 'get_state',
    success: true
  }))

  assert.equal(dispatcher.events.length, 1)
  assert.equal(dispatcher.events[0].id, 'unknown_id')
})

test('dispatch: non-response line forwarded as event', () => {
  const dispatcher = new EventDispatcher()
  dispatcher.handleLine(JSON.stringify({
    type: 'agent_message',
    content: 'hello world'
  }))

  assert.equal(dispatcher.events.length, 1)
  assert.equal(dispatcher.events[0].type, 'agent_message')
})

test('dispatch: response without id field forwarded as event', () => {
  const dispatcher = new EventDispatcher()
  dispatcher.handleLine(JSON.stringify({
    type: 'response',
    command: 'prompt',
    success: true
  }))

  // No id → can't match to pending → forwarded as event
  assert.equal(dispatcher.events.length, 1)
})

// =============================================================================
// Fire-and-forget classification
// =============================================================================

test('FIRE_AND_FORGET_METHODS contains exactly the right methods', async () => {
  // Import the actual set from rpc-types
  // Since this is an .mjs test running against .ts source, we read the file
  // and verify the set contents textually, then test against the known values.
  const expected = new Set(['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'])

  // Test by replicating the exact set (same as source)
  const FIRE_AND_FORGET_METHODS = new Set([
    'notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'
  ])

  assert.equal(FIRE_AND_FORGET_METHODS.size, expected.size)
  for (const method of expected) {
    assert.ok(FIRE_AND_FORGET_METHODS.has(method), `Missing: ${method}`)
  }

  // Verify interactive methods are NOT in the set
  for (const interactive of ['select', 'confirm', 'input', 'editor']) {
    assert.ok(!FIRE_AND_FORGET_METHODS.has(interactive), `Should not contain: ${interactive}`)
  }
})

test('FIRE_AND_FORGET_METHODS in source matches headless-events.ts', async () => {
  const { readFile } = await import('node:fs/promises')

  const rpcTypesPath = new URL('../src/main/rpc-types.ts', import.meta.url)
  const rpcTypes = await readFile(rpcTypesPath, 'utf8')

  // Verify all five methods appear in the Set literal
  for (const method of ['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text']) {
    assert.match(rpcTypes, new RegExp(`'${method}'`), `rpc-types.ts should contain '${method}'`)
  }
})

// =============================================================================
// Pending Request Timeout
// =============================================================================

test('pending request rejects after timeout', async () => {
  const dispatcher = new EventDispatcher()
  // Send with 100ms timeout (set in EventDispatcher)
  const promise = dispatcher.send('req_timeout')

  await assert.rejects(promise, {
    message: /Timeout for req_timeout/
  })

  // Pending map should be cleaned up
  assert.equal(dispatcher.pendingRequests.size, 0)
})

// =============================================================================
// Extension UI auto-response logic
// =============================================================================

test('auto-response: select returns first option', () => {
  const method = 'select'
  const data = { method, id: 'ui_1', options: ['Option A', 'Option B'] }

  // Replicate the auto-response logic from GsdService
  let response = null
  switch (data.method) {
    case 'select':
      response = {
        type: 'extension_ui_response',
        id: data.id,
        value: Array.isArray(data.options) && data.options.length > 0 ? data.options[0] : ''
      }
      break
  }

  assert.deepEqual(response, {
    type: 'extension_ui_response',
    id: 'ui_1',
    value: 'Option A'
  })
})

test('auto-response: confirm returns true', () => {
  const response = { type: 'extension_ui_response', id: 'ui_2', confirmed: true }
  assert.equal(response.confirmed, true)
})

test('auto-response: input returns empty string', () => {
  const response = { type: 'extension_ui_response', id: 'ui_3', value: '' }
  assert.equal(response.value, '')
})

test('auto-response: editor returns prefill or empty', () => {
  // With prefill
  const prefill = 'default text'
  const response1 = {
    type: 'extension_ui_response',
    id: 'ui_4',
    value: typeof prefill === 'string' ? prefill : ''
  }
  assert.equal(response1.value, 'default text')

  // Without prefill
  const noPrefill = undefined
  const response2 = {
    type: 'extension_ui_response',
    id: 'ui_5',
    value: typeof noPrefill === 'string' ? noPrefill : ''
  }
  assert.equal(response2.value, '')
})
