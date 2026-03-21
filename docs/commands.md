# Commands Reference

## Session Commands

| Command | Description |
|---------|-------------|
| `/gsd` | Step mode — execute one unit at a time, pause between each |
| `/gsd next` | Explicit step mode (same as `/gsd`) |
| `/gsd auto` | Autonomous mode — research, plan, execute, commit, repeat |
| `/gsd quick` | Execute a quick task with GSD guarantees (atomic commits, state tracking) without full planning overhead |
| `/gsd stop` | Stop auto mode gracefully |
| `/gsd steer` | Hard-steer plan documents during execution |
| `/gsd discuss` | Discuss architecture and decisions (works alongside auto mode) |
| `/gsd status` | Progress dashboard |
| `/gsd queue` | Queue and reorder future milestones (safe during auto mode) |
| `/gsd capture` | Fire-and-forget thought capture (works during auto mode) |
| `/gsd triage` | Manually trigger triage of pending captures |
| `/gsd forensics` | Full-access GSD debugger — structured anomaly detection, unit traces, and LLM-guided root-cause analysis for auto-mode failures |
| `/gsd cleanup` | Clean up GSD state files and stale worktrees |
| `/gsd visualize` | Open workflow visualizer (progress, deps, metrics, timeline) |
| `/gsd export --html` | Generate self-contained HTML report for current or completed milestone |
| `/gsd export --html --all` | Generate retrospective reports for all milestones at once |
| `/gsd update` | Update GSD to the latest version in-session |
| `/gsd knowledge` | Add persistent project knowledge (rule, pattern, or lesson) |
| `/gsd help` | Categorized command reference with descriptions for all GSD subcommands |

## Configuration & Diagnostics

| Command | Description |
|---------|-------------|
| `/gsd prefs` | Model selection, timeouts, budget ceiling |
| `/gsd mode` | Switch workflow mode (solo/team) with coordinated defaults for milestone IDs, git commit behavior, and documentation |
| `/gsd config` | Re-run the provider setup wizard (LLM provider + tool keys) |
| `/gsd keys` | API key manager — list, add, remove, test, rotate, doctor |
| `/gsd doctor` | Runtime health checks with auto-fix — issues surface in real time across widget, visualizer, and HTML reports (v2.40) |
| `/gsd skill-health` | Skill lifecycle dashboard — usage stats, success rates, token trends, staleness warnings |
| `/gsd skill-health <name>` | Detailed view for a single skill |
| `/gsd skill-health --declining` | Show only skills flagged for declining performance |
| `/gsd skill-health --stale N` | Show skills unused for N+ days |
| `/gsd hooks` | Show configured post-unit and pre-dispatch hooks |
| `/gsd run-hook` | Manually trigger a specific hook |
| `/gsd migrate` | Migrate a v1 `.planning` directory to `.gsd` format |

## Milestone Management

| Command | Description |
|---------|-------------|
| `/gsd new-milestone` | Create a new milestone |
| `/gsd skip` | Prevent a unit from auto-mode dispatch |
| `/gsd undo` | Revert last completed unit |
| Park milestone | Available via `/gsd` wizard → "Milestone actions" → "Park" |
| Unpark milestone | Available via `/gsd` wizard → "Milestone actions" → "Unpark" |
| Discard milestone | Available via `/gsd` wizard → "Milestone actions" → "Discard" |

## Parallel Orchestration

| Command | Description |
|---------|-------------|
| `/gsd parallel start` | Analyze eligibility, confirm, and start workers |
| `/gsd parallel status` | Show all workers with state, progress, and cost |
| `/gsd parallel stop [MID]` | Stop all workers or a specific milestone's worker |
| `/gsd parallel pause [MID]` | Pause all workers or a specific one |
| `/gsd parallel resume [MID]` | Resume paused workers |
| `/gsd parallel merge [MID]` | Merge completed milestones back to main |

See [Parallel Orchestration](./parallel-orchestration.md) for full documentation.

## GitHub Sync (v2.39)

| Command | Description |
|---------|-------------|
| `/github-sync bootstrap` | Initial setup — creates GitHub Milestones, Issues, and draft PRs from current `.gsd/` state |
| `/github-sync status` | Show sync mapping counts (milestones, slices, tasks) |

Enable with `github.enabled: true` in preferences. Requires `gh` CLI installed and authenticated. Sync mapping is persisted in `.gsd/.github-sync.json`.

## Git Commands

| Command | Description |
|---------|-------------|
| `/worktree` (`/wt`) | Git worktree lifecycle — create, switch, merge, remove |

## Session Management

| Command | Description |
|---------|-------------|
| `/clear` | Start a new session (alias for `/new`) |
| `/exit` | Graceful shutdown — saves session state before exiting |
| `/kill` | Kill GSD process immediately |
| `/model` | Switch the active model |
| `/login` | Log in to an LLM provider |
| `/thinking` | Toggle thinking level during sessions |
| `/voice` | Toggle real-time speech-to-text (macOS, Linux) |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+G` | Toggle dashboard overlay |
| `Ctrl+Alt+V` | Toggle voice transcription |
| `Ctrl+Alt+B` | Show background shell processes |
| `Ctrl+V` / `Alt+V` | Paste image from clipboard (screenshot → vision input) |
| `Escape` | Pause auto mode (preserves conversation) |

> **Note:** In terminals without Kitty keyboard protocol support (macOS Terminal.app, JetBrains IDEs), slash-command fallbacks are shown instead of `Ctrl+Alt` shortcuts.
>
> **Tip:** If `Ctrl+V` is intercepted by your terminal (e.g. Warp), use `Alt+V` instead for clipboard image paste.

## CLI Flags

| Flag | Description |
|------|-------------|
| `gsd` | Start a new interactive session |
| `gsd --continue` (`-c`) | Resume the most recent session for the current directory |
| `gsd --model <id>` | Override the default model for this session |
| `gsd --print "msg"` (`-p`) | Single-shot prompt mode (no TUI) |
| `gsd --mode <text\|json\|rpc\|mcp>` | Output mode for non-interactive use |
| `gsd --list-models [search]` | List available models and exit |
| `gsd sessions` | Interactive session picker — list all saved sessions for the current directory and choose one to resume |
| `gsd --debug` | Enable structured JSONL diagnostic logging for troubleshooting dispatch and state issues |
| `gsd config` | Set up global API keys for search and docs tools (saved to `~/.gsd/agent/auth.json`, applies to all projects). See [Global API Keys](./configuration.md#global-api-keys-gsd-config). |
| `gsd update` | Update GSD to the latest version |
| `gsd headless new-milestone` | Create a new milestone from a context file (headless — no TUI required) |

## Headless Mode

`gsd headless` runs `/gsd` commands without a TUI — designed for CI, cron jobs, and scripted automation. It spawns a child process in RPC mode, auto-responds to interactive prompts, detects completion, and exits with meaningful exit codes.

```bash
# Run auto mode (default)
gsd headless

# Run a single unit
gsd headless next

# Instant JSON snapshot — no LLM, ~50ms
gsd headless query

# With timeout for CI
gsd headless --timeout 600000 auto

# Force a specific phase
gsd headless dispatch plan

# Create a new milestone from a context file and start auto mode
gsd headless new-milestone --context brief.md --auto

# Create a milestone from inline text
gsd headless new-milestone --context-text "Build a REST API with auth"

# Pipe context from stdin
echo "Build a CLI tool" | gsd headless new-milestone --context -
```

| Flag | Description |
|------|-------------|
| `--timeout N` | Overall timeout in milliseconds (default: 300000 / 5 min) |
| `--max-restarts N` | Auto-restart on crash with exponential backoff (default: 3). Set 0 to disable |
| `--json` | Stream all events as JSONL to stdout |
| `--model ID` | Override the model for the headless session |
| `--context <file>` | Context file for `new-milestone` (use `-` for stdin) |
| `--context-text <text>` | Inline context text for `new-milestone` |
| `--auto` | Chain into auto-mode after milestone creation |

**Exit codes:** `0` = complete, `1` = error or timeout, `2` = blocked.

Any `/gsd` subcommand works as a positional argument — `gsd headless status`, `gsd headless doctor`, `gsd headless dispatch execute`, etc.

### `gsd headless query`

Returns a single JSON object with the full project snapshot — no LLM session, no RPC child, instant response (~50ms). This is the recommended way for orchestrators and scripts to inspect GSD state.

```bash
gsd headless query | jq '.state.phase'
# "executing"

gsd headless query | jq '.next'
# {"action":"dispatch","unitType":"execute-task","unitId":"M001/S01/T03"}

gsd headless query | jq '.cost.total'
# 4.25
```

**Output schema:**

```json
{
  "state": {
    "phase": "executing",
    "activeMilestone": { "id": "M001", "title": "..." },
    "activeSlice": { "id": "S01", "title": "..." },
    "activeTask": { "id": "T01", "title": "..." },
    "registry": [{ "id": "M001", "status": "active" }, ...],
    "progress": { "milestones": { "done": 0, "total": 2 }, "slices": { "done": 1, "total": 3 } },
    "blockers": []
  },
  "next": {
    "action": "dispatch",
    "unitType": "execute-task",
    "unitId": "M001/S01/T01"
  },
  "cost": {
    "workers": [{ "milestoneId": "M001", "cost": 1.50, "state": "running", ... }],
    "total": 1.50
  }
}
```

## MCP Server Mode

`gsd --mode mcp` runs GSD as a [Model Context Protocol](https://modelcontextprotocol.io) server over stdin/stdout. This exposes all GSD tools (read, write, edit, bash, etc.) to external AI clients — Claude Desktop, VS Code Copilot, and any MCP-compatible host.

```bash
# Start GSD as an MCP server
gsd --mode mcp
```

The server registers all tools from the agent session and maps MCP `tools/list` and `tools/call` requests to GSD tool definitions. It runs until the transport closes.

## In-Session Update

`/gsd update` checks npm for a newer version of GSD and installs it without leaving the session.

```bash
/gsd update
# Current version: v2.36.0
# Checking npm registry...
# Updated to v2.37.0. Restart GSD to use the new version.
```

If already up to date, it reports so and takes no action.

## Export

`/gsd export` generates reports of milestone work.

```bash
# Generate HTML report for the active milestone
/gsd export --html

# Generate retrospective reports for ALL milestones at once
/gsd export --html --all
```

Reports are saved to `.gsd/reports/` with a browseable `index.html` that links to all generated snapshots.
