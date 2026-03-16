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

  // Dynamic imports to work around MCP SDK subpath export resolution.
  // The @ts-ignore directives suppress TS2307 for wildcard subpath exports
  // that NodeNext module resolution cannot statically resolve.
  const { Server } = await import('@modelcontextprotocol/sdk/server')
  // @ts-ignore — subpath export via "./*" wildcard
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
  // @ts-ignore — subpath export via "./*" wildcard
  const sdkTypes = await import('@modelcontextprotocol/sdk/types')
  const { ListToolsRequestSchema, CallToolRequestSchema } = sdkTypes

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
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.parameters as Record<string, unknown>,
      })),
    }
  })

  // tools/call — execute the requested tool and return content blocks
  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: args } = request.params
    const tool = toolMap.get(name)
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
      }
    }

    try {
      const result = await tool.execute(
        `mcp-${Date.now()}`,
        args ?? {},
        undefined, // no AbortSignal
        undefined, // no onUpdate callback
      )

      // Convert AgentToolResult content blocks to MCP content format
      const content = result.content.map((block: any) => {
        if (block.type === 'text') {
          return { type: 'text' as const, text: block.text ?? '' }
        }
        if (block.type === 'image') {
          return {
            type: 'image' as const,
            data: block.data ?? '',
            mimeType: block.mimeType ?? 'image/png',
          }
        }
        // Fallback for any unrecognized content type
        return { type: 'text' as const, text: JSON.stringify(block) }
      })

      return { content }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        isError: true,
        content: [{ type: 'text' as const, text: message }],
      }
    }
  })

  // Connect to stdin/stdout transport
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Log startup to stderr (stdout is reserved for MCP protocol)
  process.stderr.write(`[gsd] MCP server started (v${version})\n`)
}
