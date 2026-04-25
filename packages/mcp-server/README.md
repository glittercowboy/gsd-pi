# @gsd-build/mcp-server

MCP server exposing GSD orchestration tools for Claude Code, Cursor, and other MCP-compatible clients.

Start GSD auto-mode sessions, poll progress, resolve blockers, and retrieve results — all through the [Model Context Protocol](https://modelcontextprotocol.io/).

This package now exposes two tool surfaces:

- session/read tools for starting and inspecting GSD sessions
- MCP-native interactive tools for structured user input
- headless-safe workflow tools for planning, completion, validation, reassessment, metadata persistence, and journal reads

## Installation

```bash
npm install @gsd-build/mcp-server
```

Or with the monorepo workspace:

```bash
# Already available as a workspace package
npx gsd-mcp-server
```

## Configuration

### Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "gsd": {
      "command": "npx",
      "args": ["gsd-mcp-server"],
      "env": {
        "GSD_CLI_PATH": "/path/to/gsd"
      }
    }
  }
}
```

Or if installed globally:

```json
{
  "mcpServers": {
    "gsd": {
      "command": "gsd-mcp-server"
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "gsd": {
      "command": "npx",
      "args": ["gsd-mcp-server"],
      "env": {
        "GSD_CLI_PATH": "/path/to/gsd"
      }
    }
  }
}
```

## Tools

### Workflow tools

The workflow MCP surface includes:

- `gsd_decision_save`
- `gsd_save_decision`
- `gsd_requirement_update`
- `gsd_update_requirement`
- `gsd_requirement_save`
- `gsd_save_requirement`
- `gsd_milestone_generate_id`
- `gsd_generate_milestone_id`
- `gsd_plan_milestone`
- `gsd_plan_slice`
- `gsd_plan_task`
- `gsd_task_plan`
- `gsd_replan_slice`
- `gsd_slice_replan`
- `gsd_task_complete`
- `gsd_complete_task`
- `gsd_slice_complete`
- `gsd_complete_slice`
- `gsd_skip_slice`
- `gsd_validate_milestone`
- `gsd_milestone_validate`
- `gsd_complete_milestone`
- `gsd_milestone_complete`
- `gsd_reassess_roadmap`
- `gsd_roadmap_reassess`
- `gsd_save_gate_result`
- `gsd_summary_save`
- `gsd_milestone_status`
- `gsd_journal_query`

These tools use the same GSD workflow handlers as the native in-process tool path wherever a shared handler exists.

### Interactive tools

The packaged server exposes `ask_user_questions` through MCP form elicitation. This keeps the existing GSD answer payload shape while allowing Claude Code CLI and other elicitation-capable clients to surface structured user choices.

The packaged server also exposes `secure_env_collect` through MCP form elicitation. Secret values are written directly to the selected destination and are not included in tool output. For dotenv writes, `envFilePath` must resolve inside the validated project directory; parent traversal and symlink escapes are rejected.

Current support boundary:

- when running inside the GSD monorepo checkout, the MCP server auto-discovers the shared workflow executor module
- outside the monorepo, set `GSD_WORKFLOW_EXECUTORS_MODULE` to an importable `workflow-tool-executors` module path if you want the mutation tools enabled
- `ask_user_questions` and `secure_env_collect` require an MCP client that supports form elicitation
- session/read tools do not depend on this bridge

If the executor bridge cannot be loaded, workflow mutation calls will fail with a precise configuration error instead of silently degrading.

### `gsd_execute`

Start a GSD auto-mode session for a project directory.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectDir` | `string` | ✅ | Absolute path to the project directory |
| `command` | `string` | | Command to send (default: `"/gsd auto"`) |
| `model` | `string` | | Model ID override |
| `bare` | `boolean` | | Run in bare mode (skip user config) |

**Returns:** `{ sessionId, status: "started" }`

### `gsd_status`

Poll the current status of a running GSD session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | `string` | ✅ | Session ID from `gsd_execute` |

**Returns:**

```json
{
  "status": "running",
  "progress": { "eventCount": 42, "toolCalls": 15 },
  "recentEvents": [ ... ],
  "pendingBlocker": null,
  "cost": { "totalCost": 0.12, "tokens": { "input": 5000, "output": 2000, "cacheRead": 1000, "cacheWrite": 500 } },
  "durationMs": 45000
}
```

### `gsd_result`

Get the accumulated result of a session. Works for both running (partial) and completed sessions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | `string` | ✅ | Session ID from `gsd_execute` |

**Returns:**

```json
{
  "sessionId": "abc-123",
  "projectDir": "/path/to/project",
  "status": "completed",
  "durationMs": 120000,
  "cost": { ... },
  "recentEvents": [ ... ],
  "pendingBlocker": null,
  "error": null
}
```

### `gsd_cancel`

Cancel a running session. Aborts the current operation and stops the agent process.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | `string` | ✅ | Session ID from `gsd_execute` |

**Returns:** `{ cancelled: true }`

### `gsd_query`

Query GSD project state from the filesystem without an active session. Returns STATE.md, PROJECT.md, requirements, and milestone listing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectDir` | `string` | ✅ | Absolute path to the project directory |
| `query` | `string` | ✅ | What to query (e.g. `"status"`, `"milestones"`) |

**Returns:**

```json
{
  "projectDir": "/path/to/project",
  "state": "...",
  "project": "...",
  "requirements": "...",
  "milestones": [
    { "id": "M001", "hasRoadmap": true, "hasSummary": false }
  ]
}
```

### `gsd_resolve_blocker`

Resolve a pending blocker in a session by sending a response to the blocked UI request.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | `string` | ✅ | Session ID from `gsd_execute` |
| `response` | `string` | ✅ | Response to send for the pending blocker |

**Returns:** `{ resolved: true }`

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GSD_CLI_PATH` | Absolute path to the GSD CLI binary. If not set, the server resolves `gsd` via `which`. |
| `GSD_WORKFLOW_EXECUTORS_MODULE` | Optional absolute path or `file:` URL for the shared GSD workflow executor module used by workflow mutation tools. |

The server also hydrates supported model-provider and tool credentials from `~/.gsd/agent/auth.json` on startup. Keys saved through `/gsd config` or `/gsd keys` become available to the MCP server process automatically, and any explicitly-set environment variable still wins.

## Architecture

```
┌─────────────────┐     stdio      ┌──────────────────┐
│  MCP Client     │ ◄────────────► │  @gsd-build/mcp-server │
│  (Claude Code,  │    JSON-RPC    │                  │
│   Cursor, etc.) │                │  SessionManager  │
└─────────────────┘                │       │          │
                                   │       ▼          │
                                   │  @gsd-build/rpc-client │
                                   │       │          │
                                   │       ▼          │
                                   │  GSD CLI (child  │
                                   │  process via RPC)│
                                   └──────────────────┘
```

- **@gsd-build/mcp-server** — MCP protocol adapter. Translates MCP tool calls into SessionManager operations.
- **SessionManager** — Manages RpcClient lifecycle. One session per project directory. Tracks events in a ring buffer (last 50), detects blockers, accumulates cost.
- **@gsd-build/rpc-client** — Low-level RPC client that spawns and communicates with the GSD CLI process via JSON-RPC over stdio.

## License

MIT
