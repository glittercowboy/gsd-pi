# MCP Servers

GSD can connect to external MCP (Model Context Protocol) servers for local tools, internal APIs, self-hosted services, or integrations not built in as native extensions.

## Configuration Files

GSD reads MCP config from these project-local paths:

- `.mcp.json` — repo-shared config (safe to commit)
- `.gsd/mcp.json` — local-only config (not shared)

If both exist, server names are merged and the first definition found wins.

## Supported Transports

| Transport | Config Shape | Use When |
|-----------|-------------|----------|
| `stdio` | `command` + optional `args`, `env`, `cwd` | Launching a local MCP server |
| `http` | `url` | Connecting to an already-running server |

## Examples

### stdio Server

```json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "/absolute/path/to/python3",
      "args": ["/absolute/path/to/server.py"],
      "env": {
        "API_URL": "http://localhost:8000"
      }
    }
  }
}
```

### HTTP Server

```json
{
  "mcpServers": {
    "my-http-server": {
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

## Verifying a Server

After adding config, verify from a GSD session:

1. `mcp_servers` — confirms GSD sees the config
2. `mcp_discover(server="my-server")` — confirms the server starts and responds
3. `mcp_call(server="my-server", tool="<tool>", args={...})` — confirms a real tool call works

## Tips

- Use **absolute paths** for executables and scripts
- Set required **environment variables** directly in the MCP config's `env` block
- Use `.mcp.json` for team-shared servers; `.gsd/mcp.json` for machine-local ones
- If a server depends on local paths or personal secrets, keep it in `.gsd/mcp.json`
