/**
 * MCP (Model Context Protocol) server for the GSD extension.
 *
 * This module provides the same MCP server functionality as src/mcp-server.ts
 * but can be loaded via jiti in the extension runtime context. It enables
 * GSD's tools to be used by external AI clients (Claude Desktop, VS Code
 * Copilot, etc.) via the MCP standard protocol over stdin/stdout.
 */

interface McpTool {
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

export async function startMcpServer(options: {
  tools: McpTool[]
  version?: string
}): Promise<void> {
  const { tools, version = '0.0.0' } = options

  // Dynamic imports — MCP SDK subpath exports use a "./*" wildcard pattern
  // that cannot be statically resolved by all TypeScript configurations.
  // @ts-ignore
  const { Server } = await import('@modelcontextprotocol/sdk/server')
  // @ts-ignore
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
  // @ts-ignore
  const sdkTypes = await import('@modelcontextprotocol/sdk/types')
  const { ListToolsRequestSchema, CallToolRequestSchema } = sdkTypes

  const toolMap = new Map<string, McpTool>()
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
      tools: tools.map((t: McpTool) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.parameters,
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
        undefined,
        undefined,
      )

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

  const transport = new StdioServerTransport()
  await server.connect(transport)

  process.stderr.write(`[gsd] MCP server started (v${version})\n`)
}
