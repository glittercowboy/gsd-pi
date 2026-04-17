/**
 * Minimal tool interface matching GSD's AgentTool shape.
 * Avoids a direct dependency on @gsd/pi-agent-core from this compiled module.
 */
export interface McpToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
  ): Promise<{
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  }>
}

// MCP SDK subpath imports use wildcard exports (./*) in @modelcontextprotocol/sdk's
// package.json export map. The wildcard maps "./foo" → "./dist/cjs/foo" (no .js
// suffix), so bare subpath specifiers like `${MCP_PKG}/server/stdio` resolve to
// a non-existent file. Historically the workaround (#3603) used createRequire so
// the CJS resolver could auto-append `.js`; that no longer works with current
// Node + SDK releases (#3914) — `_require.resolve` also fails with
// "Cannot find module .../dist/cjs/server/stdio".
//
// The reliable convention (matching packages/mcp-server/{server,cli}.ts) is to
// write the `.js` suffix explicitly on every wildcard subpath. Specifiers are
// built via a template string so TypeScript's NodeNext resolver treats them as
// `any` and skips static checking.
const MCP_PKG = '@modelcontextprotocol/sdk'

/**
 * Starts a native MCP (Model Context Protocol) server over stdin/stdout.
 *
 * This enables GSD's tools (read, write, edit, bash, grep, glob, ls, etc.)
 * to be used by external AI clients such as Claude Desktop, VS Code Copilot,
 * and any MCP-compatible host.
 *
 * The server registers all tools from the agent session's tool registry and
 * maps MCP tools/list and tools/call requests to GSD tool definitions and
 * execution, respectively.
 *
 * All MCP SDK imports are dynamic to avoid subpath export resolution issues
 * with TypeScript's NodeNext module resolution.
 */
export async function startMcpServer(options: {
  tools: McpToolDef[]
  version?: string
}): Promise<void> {
  const { tools, version = '0.0.0' } = options

  const serverMod = await import(`${MCP_PKG}/server/index.js`)
  const stdioMod = await import(`${MCP_PKG}/server/stdio.js`)
  const typesMod = await import(`${MCP_PKG}/types.js`)

  const Server = serverMod.Server
  const StdioServerTransport = stdioMod.StdioServerTransport
  const { ListToolsRequestSchema, CallToolRequestSchema } = typesMod

  // Build a lookup map for fast tool resolution on calls
  const toolMap = new Map<string, McpToolDef>()
  for (const tool of tools) {
    toolMap.set(tool.name, tool)
  }

  const server = new Server(
    { name: 'gsd', version },
    { capabilities: { tools: {} } },
  )

  // tools/list — return every registered GSD tool with its JSON Schema parameters
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t: McpToolDef) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters,
    })),
  }))

  // tools/call — execute the requested tool and return content blocks.
  //
  // The MCP SDK passes an `extra` argument to request handlers that includes
  // an AbortSignal scoped to the RPC request (cancelled when the client
  // cancels the tool call or the transport closes). Threading it into
  // AgentTool.execute ensures long-running tools (Bash, WebFetch, grep on
  // huge trees) actually stop when the client gives up on the result.
  server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: Record<string, unknown> } }, extra: { signal?: AbortSignal }) => {
    const { name, arguments: args } = request.params
    const tool = toolMap.get(name)
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
      }
    }

    const signal: AbortSignal | undefined = extra?.signal

    try {
      const result = await tool.execute(
        `mcp-${Date.now()}`,
        args ?? {},
        signal,
        undefined, // onUpdate not yet wired — progress notifications require a progressToken round-trip
      )

      // Convert AgentToolResult content blocks to MCP content format.
      // text and image pass through; any other shape is serialized as text
      // so the client sees the payload rather than an empty response.
      const content = result.content.map((block: { type: string; text?: string; data?: string; mimeType?: string }) => {
        if (block.type === 'text') return { type: 'text' as const, text: block.text ?? '' }
        if (block.type === 'image') {
          return {
            type: 'image' as const,
            data: block.data ?? '',
            mimeType: block.mimeType ?? 'image/png',
          }
        }
        // Preserve unknown block types (resource, resource_link, audio, ...)
        // by stringifying into a text block so clients see the payload.
        return { type: 'text' as const, text: JSON.stringify(block) }
      })
      return { content }
    } catch (err: unknown) {
      // AbortError from a cancelled tool surfaces as a normal error — MCP
      // clients interpret `isError: true` as a failed call, which is the
      // correct behaviour for a cancelled request.
      const message = err instanceof Error ? err.message : String(err)
      return { isError: true, content: [{ type: 'text' as const, text: message }] }
    }
  })

  // Connect to stdin/stdout transport
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write(`[gsd] MCP server started (v${version})\n`)
}
