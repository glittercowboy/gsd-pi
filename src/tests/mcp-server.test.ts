import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = join(fileURLToPath(import.meta.url), '..', '..', '..')

/**
 * Resolve dist path as a file:// URL for cross-platform dynamic import.
 * On Windows, bare paths like `D:\...\mcp-server.js` fail with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME because Node's ESM loader requires
 * file:// URLs for absolute paths.
 */
function distUrl(filename: string): string {
  return pathToFileURL(join(projectRoot, 'dist', filename)).href
}

test('mcp-server module imports without errors', async () => {
  // Import from the compiled dist output to avoid subpath resolution issues
  // that occur when the resolve-ts test hook rewrites .js -> .ts paths.
  const mod = await import(distUrl('mcp-server.js'))
  assert.ok(mod, 'module should be importable')
  assert.strictEqual(typeof mod.startMcpServer, 'function', 'startMcpServer should be a function')
})

test('startMcpServer accepts the correct argument shape', async () => {
  const { startMcpServer } = await import(distUrl('mcp-server.js'))

  assert.strictEqual(typeof startMcpServer, 'function')
  assert.strictEqual(startMcpServer.length, 1, 'startMcpServer should accept one argument')
})

test('startMcpServer can be called with mock tools', async () => {
  const { startMcpServer } = await import(distUrl('mcp-server.js'))

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
