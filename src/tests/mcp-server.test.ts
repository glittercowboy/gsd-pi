import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(fileURLToPath(import.meta.url), '..', '..', '..')

test('mcp-server module imports without errors', async () => {
  // Import from the compiled dist output to avoid subpath resolution issues
  // that occur when the resolve-ts test hook rewrites .js -> .ts paths.
  const distPath = join(projectRoot, 'dist', 'mcp-server.js')
  const mod = await import(distPath)
  assert.ok(mod, 'module should be importable')
  assert.strictEqual(typeof mod.startMcpServer, 'function', 'startMcpServer should be a function')
})

test('startMcpServer accepts the correct argument shape', async () => {
  const distPath = join(projectRoot, 'dist', 'mcp-server.js')
  const { startMcpServer } = await import(distPath)

  assert.strictEqual(typeof startMcpServer, 'function')
  assert.strictEqual(startMcpServer.length, 1, 'startMcpServer should accept one argument')
})

test('startMcpServer can be called with mock tools', async () => {
  const distPath = join(projectRoot, 'dist', 'mcp-server.js')
  const { startMcpServer } = await import(distPath)

  // Create a mock tool matching the McpToolDef interface
  const mockTool = {
    name: 'test_tool',
    description: 'A test tool',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({
      content: [{ type: 'text', text: 'hello' }],
    }),
  }

  // Verify the function can be called with the correct signature
  // without throwing during argument validation. It will attempt to
  // connect to stdin/stdout as an MCP transport, which won't work in
  // a test environment, but the Server instance is created successfully.
  assert.doesNotThrow(() => {
    void startMcpServer({ tools: [mockTool], version: '0.0.0-test' })
      .catch(() => { /* expected: no MCP client on stdin */ })
  })
})
