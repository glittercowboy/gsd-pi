# CLI Flags

## Starting GSD

| Flag | Description |
|------|-------------|
| `gsd` | Start a new interactive session |
| `gsd --continue` (`-c`) | Resume the most recent session |
| `gsd --model <id>` | Override the default model for this session |
| `gsd --web [path]` | Start browser-based web interface |
| `gsd --worktree` (`-w`) [name] | Start in a git worktree |
| `gsd --no-session` | Disable session persistence |
| `gsd --extension <path>` | Load an additional extension (repeatable) |
| `gsd --append-system-prompt <text>` | Append text to the system prompt |
| `gsd --tools <list>` | Comma-separated tools to enable |
| `gsd --version` (`-v`) | Print version and exit |
| `gsd --help` (`-h`) | Print help and exit |
| `gsd --debug` | Enable diagnostic logging |

## Non-Interactive Modes

| Flag | Description |
|------|-------------|
| `gsd --print "msg"` (`-p`) | Single-shot prompt mode (no TUI) |
| `gsd --mode <text\|json\|rpc\|mcp>` | Output mode for non-interactive use |

## Session Management

| Command | Description |
|---------|-------------|
| `gsd sessions` | Interactive session picker — list and resume saved sessions |
| `gsd --list-models [search]` | List available models and exit |

## Configuration

| Command | Description |
|---------|-------------|
| `gsd config` | Set up global API keys |
| `gsd update` | Update to the latest version |

## Headless Mode

| Flag | Description |
|------|-------------|
| `gsd headless` | Run without TUI |
| `gsd headless --timeout N` | Timeout in ms (default: 300000) |
| `gsd headless --max-restarts N` | Auto-restart on crash (default: 3) |
| `gsd headless --json` | Stream events as JSONL |
| `gsd headless --model ID` | Override model |
| `gsd headless --context <file>` | Context file for `new-milestone` |
| `gsd headless --context-text <text>` | Inline context for `new-milestone` |
| `gsd headless --auto` | Chain into auto mode after milestone creation |
| `gsd headless query` | Instant JSON state snapshot (~50ms) |

## Web Interface

| Flag | Default | Description |
|------|---------|-------------|
| `--host` | `localhost` | Bind address |
| `--port` | `3000` | Port |
| `--allowed-origins` | (none) | CORS origins |
