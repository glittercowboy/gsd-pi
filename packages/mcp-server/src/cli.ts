/**
 * @gsd-build/mcp-server CLI — stdio transport entry point.
 *
 * Connects the MCP server to stdin/stdout for use by Claude Code,
 * Cursor, and other MCP-compatible clients.
 */

import { SessionManager } from './session-manager.js';
import { createMcpServer } from './server.js';
import { loadStoredCredentialEnvKeys } from './tool-credentials.js';

const MCP_PKG = '@modelcontextprotocol/sdk';

async function main(): Promise<void> {
  loadStoredCredentialEnvKeys();

  const sessionManager = new SessionManager();

  // Create the configured MCP server with session, interactive, read-only,
  // and workflow tools.
  const { server } = await createMcpServer(sessionManager);

  // Dynamic import for StdioServerTransport (same TS subpath workaround)
  const { StdioServerTransport } = await import(`${MCP_PKG}/server/stdio.js`);
  const transport = new StdioServerTransport();

  // Cleanup handler — stop all sessions before exiting
  let cleaningUp = false;
  async function cleanup(): Promise<void> {
    if (cleaningUp) return;
    cleaningUp = true;
    process.stderr.write('[gsd-mcp-server] Shutting down...\n');
    try {
      await sessionManager.cleanup();
    } catch {
      // swallow cleanup errors
    }
    try {
      await server.close();
    } catch {
      // swallow close errors
    }
    process.exit(0);
  }

  process.on('SIGTERM', () => void cleanup());
  process.on('SIGINT', () => void cleanup());

  // Handle stdin end — MCP client disconnected
  process.stdin.on('end', () => void cleanup());

  // Connect and start serving
  try {
    await server.connect(transport);
    process.stderr.write('[gsd-mcp-server] MCP server started on stdio\n');
  } catch (err) {
    process.stderr.write(
      `[gsd-mcp-server] Fatal: failed to start — ${err instanceof Error ? err.message : String(err)}\n`
    );
    await sessionManager.cleanup();
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(
    `[gsd-mcp-server] Fatal: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
});
