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

test('compiled MCP runtime dependencies resolve with explicit .js subpaths', async () => {
  const stdioMod = await import('@modelcontextprotocol/sdk/server/stdio.js')
  const typesMod = await import('@modelcontextprotocol/sdk/types.js')

  assert.strictEqual(typeof stdioMod.StdioServerTransport, 'function')
  assert.ok(typesMod.ListToolsRequestSchema, 'ListToolsRequestSchema should be exported')
  assert.ok(typesMod.CallToolRequestSchema, 'CallToolRequestSchema should be exported')
})
