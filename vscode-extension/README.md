# GSD-2 — VS Code Extension

Control the [GSD-2 coding agent](https://github.com/gsd-build/gsd-2) directly from VS Code. Run autonomous coding sessions, chat with `@gsd`, monitor agent activity in real-time, review and accept/reject changes, and manage your workflow — all without leaving the editor.

![GSD Extension Overview](docs/images/overview.png)

## Requirements

- **GSD-2** installed globally: `npm install -g gsd-pi`
- **Node.js** >= 22.0.0
- **Git** installed and on PATH
- **VS Code** >= 1.95.0

## Quick Start

1. Install GSD: `npm install -g gsd-pi`
2. Install this extension
3. Open a project folder in VS Code
4. Click the **GSD icon** in the Activity Bar (left sidebar)
5. Click **Start Agent** or run `Ctrl+Shift+P` > **GSD: Start Agent**
6. Start chatting with `@gsd` in Chat or click **Auto** in the sidebar

---

## Features

### Sidebar Dashboard

Click the **GSD icon** in the Activity Bar. The compact header shows connection status, model, session, message count, thinking level, context usage bar, and cost — all in two lines. Sections (Workflow, Stats, Actions, Settings) are collapsible and remember their state.

### Workflow Controls

One-click buttons for GSD's core commands. All route through the Chat panel so you see the full response:

| Button | What it does |
|--------|-------------|
| **Auto** | Start autonomous mode — research, plan, execute |
| **Next** | Execute one unit of work, then pause |
| **Quick** | Quick task without planning (opens input) |
| **Capture** | Capture a thought for later triage |

### Chat Integration (`@gsd`)

Use `@gsd` in VS Code Chat (`Cmd+Shift+I`) to talk to the agent:

```
@gsd refactor the auth module to use JWT
@gsd /gsd auto
@gsd fix the errors in this file
```

- **Auto-starts** the agent if not running
- **File context** via `#file` references
- **Selection context** — automatically includes selected code
- **Diagnostic context** — auto-includes errors/warnings when you mention "fix" or "error"
- **Streaming** progress, file anchors, token usage footer

### Source Control Integration

Agent-modified files appear in a dedicated **"GSD Agent"** section of the Source Control panel:

- **Click any file** to see a before/after diff in VS Code's native diff editor
- **Accept** or **Discard** changes per-file via inline buttons
- **Accept All** / **Discard All** via the SCM title bar
- Gutter diff indicators (green/red bars) show exactly what changed

### Line-Level Decorations

When the agent modifies a file, you'll see:
- **Green background** on newly added lines
- **Yellow background** on modified lines
- **Left border gutter indicator** on all agent-touched lines
- **Hover** any decorated line to see "Modified by GSD Agent"

### Checkpoints & Rollback

Automatic checkpoints are created at the start of each agent turn. Use **Discard All** in the SCM panel to revert all agent changes to their original state, or discard individual files.

### Activity Feed

The **Activity** panel shows a real-time log of every tool the agent executes — Read, Write, Edit, Bash, Grep, Glob — with status icons (running/success/error), duration, and click-to-open for file operations.

### Sessions

The **Sessions** panel lists all past sessions for the current workspace. Click any session to switch to it. The current session is highlighted green. Sessions persist to disk automatically.

### Diagnostic Integration

- **Fix Errors** button in the sidebar reads the active file's diagnostics from the Problems panel and sends them to the agent
- **Fix All Problems** (`Cmd+Shift+P` > GSD: Fix All Problems) collects errors/warnings across the workspace
- Works automatically in chat — mention "fix" or "error" and diagnostics are included

### Code Lens

Four inline actions above every function and class (TS/JS/Python/Go/Rust):

| Action | What it does |
|--------|-------------|
| **Ask GSD** | Explain the function/class |
| **Refactor** | Improve clarity, performance, or structure |
| **Find Bugs** | Review for bugs and edge cases |
| **Tests** | Generate test coverage |

### Git Integration

- **Commit Agent Changes** — stages and commits modified files with your message
- **Create Branch** — create a new branch for agent work
- **Show Diff** — view git diff of agent changes

### Approval Modes

Control how much autonomy the agent has:

| Mode | Behavior |
|------|----------|
| **Auto-approve** | Agent runs freely (default) |
| **Ask** | Prompts before file writes and commands |
| **Plan-only** | Read-only — agent can analyze but not modify |

Change via Settings section or `Cmd+Shift+P` > **GSD: Select Approval Mode**.

### Agent UI Requests

When the agent needs input (questions, confirmations, selections), VS Code dialogs appear automatically — no more hanging on `ask_user_questions`.

### Additional Features

- **Conversation History** — full message viewer with tool calls, thinking blocks, search, and fork-from-here
- **Slash Command Completion** — type `/` for auto-complete of `/gsd` commands
- **File Decorations** — "G" badge on agent-modified files in the Explorer
- **Bash Terminal** — dedicated terminal for agent shell output
- **Context Window Warning** — notification when context exceeds threshold
- **Progress Notifications** — optional notification with cancel button (off by default)

---

## All Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| **GSD: Start Agent** | | Connect to the GSD agent |
| **GSD: Stop Agent** | | Disconnect the agent |
| **GSD: New Session** | `Cmd+Shift+G` `Cmd+Shift+N` | Start a fresh conversation |
| **GSD: Send Message** | `Cmd+Shift+G` `Cmd+Shift+P` | Send a message to the agent |
| **GSD: Abort** | `Cmd+Shift+G` `Cmd+Shift+A` | Interrupt the current operation |
| **GSD: Steer Agent** | `Cmd+Shift+G` `Cmd+Shift+I` | Steering message mid-operation |
| **GSD: Switch Model** | | Pick a model from QuickPick |
| **GSD: Cycle Model** | `Cmd+Shift+G` `Cmd+Shift+M` | Rotate to the next model |
| **GSD: Set Thinking Level** | | Choose off / low / medium / high |
| **GSD: Cycle Thinking** | `Cmd+Shift+G` `Cmd+Shift+T` | Rotate through thinking levels |
| **GSD: Compact Context** | | Trigger context compaction |
| **GSD: Export HTML** | | Save session as HTML |
| **GSD: Session Stats** | | Display token usage and cost |
| **GSD: Run Bash** | | Execute a shell command |
| **GSD: List Commands** | | Browse slash commands |
| **GSD: Set Session Name** | | Rename current session |
| **GSD: Copy Last Response** | | Copy to clipboard |
| **GSD: Switch Session** | | Load a different session |
| **GSD: Show History** | | Open conversation viewer |
| **GSD: Fork Session** | | Fork from a previous message |
| **GSD: Fix Problems in File** | | Send file diagnostics to agent |
| **GSD: Fix All Problems** | | Send workspace errors to agent |
| **GSD: Commit Agent Changes** | | Git commit modified files |
| **GSD: Create Branch** | | Create branch for agent work |
| **GSD: Show Agent Diff** | | View git diff |
| **GSD: Accept All Changes** | | Accept all SCM changes |
| **GSD: Discard All Changes** | | Revert all agent modifications |
| **GSD: Select Approval Mode** | | Choose auto-approve/ask/plan-only |
| **GSD: Cycle Approval Mode** | | Rotate through approval modes |
| **GSD: Code Lens** actions | | Ask, Refactor, Find Bugs, Tests |

> On Windows/Linux, replace `Cmd` with `Ctrl`.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `gsd.binaryPath` | `"gsd"` | Path to the GSD binary |
| `gsd.autoStart` | `false` | Start agent on extension activation |
| `gsd.autoCompaction` | `true` | Automatic context compaction |
| `gsd.codeLens` | `true` | Code lens above functions/classes |
| `gsd.showProgressNotifications` | `false` | Progress notification (off — Chat shows progress) |
| `gsd.activityFeedMaxItems` | `100` | Max items in Activity feed |
| `gsd.showContextWarning` | `true` | Warn when context exceeds threshold |
| `gsd.contextWarningThreshold` | `80` | Context % that triggers warning |
| `gsd.approvalMode` | `"auto-approve"` | Agent permission mode |

## How It Works

The extension spawns `gsd --mode rpc` and communicates over JSON-RPC via stdin/stdout. Agent events stream in real-time. The change tracker captures file state before modifications for SCM diffs and rollback. UI requests from the agent (questions, confirmations) are handled via VS Code dialogs.

## Links

- [GSD Documentation](https://github.com/gsd-build/gsd-2/tree/main/docs)
- [Getting Started](https://github.com/gsd-build/gsd-2/blob/main/docs/getting-started.md)
- [Issue Tracker](https://github.com/gsd-build/gsd-2/issues)
