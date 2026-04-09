# Changelog

## [0.3.0]

### Added

- **SCM provider** — "GSD Agent" appears in Source Control panel with accept/discard per-file diffs
- **Change tracker** — captures original file content before agent modifications for diff and rollback
- **Checkpoints** — automatic snapshots on each agent turn with restore capability
- **Diagnostic bridge** — "Fix Problems in File" and "Fix All Problems" commands read VS Code diagnostics and send to agent
- **Line-level decorations** — green/yellow highlights on agent-modified lines with gutter indicators
- **Chat context injection** — auto-includes editor selection and file diagnostics when relevant
- **Git integration** — commit agent changes, create branches, show diffs
- **Approval modes** — auto-approve, ask (prompts before writes), plan-only (read-only)
- **UI request handling** — agent questions, confirmations, and selections now show as VS Code dialogs instead of hanging
- **Fix Errors button** — quick access to diagnostic fixing in sidebar Actions
- **5 new settings** — `showProgressNotifications`, `activityFeedMaxItems`, `showContextWarning`, `contextWarningThreshold`, `approvalMode`

### Changed

- **Sidebar redesign** — compact card-based layout with collapsible sections, pill toggles, hidden empty data
- **Workflow buttons** now route through Chat panel so responses are visible
- **Slash completion** filtered to `/gsd` commands only
- **Checkpoint labels** show timestamp + first action (e.g., "10:32 — Edit sidebar.ts")
- **Session tree** supports ISO timestamp filenames (GSD's actual format)
- **Session persistence** enabled (removed `--no-session` flag)
- **Progress notifications** disabled by default (Chat panel provides inline progress)
- **Sidebar reduced** from 6 panels to 3 (GSD Agent, Sessions, Activity)
- **Settings section** starts collapsed by default

## [0.2.0]

### Added

- **Activity feed** — real-time TreeView showing tool executions with status icons, duration, and click-to-open
- **Workflow controls** — sidebar buttons for Auto, Next, Quick Task, Capture
- **Context window indicator** — color-coded usage bar in sidebar with threshold warnings
- **Session forking** — fork from any message via QuickPick
- **Queue mode controls** — toggle steering and follow-up modes from the sidebar
- **Enhanced conversation history** — tool call rendering, collapsible thinking blocks, search/filter, fork-from-here
- **Enhanced code lens** — Refactor, Find Bugs, and Generate Tests alongside Ask GSD
- **8 new commands** (33 total)

## [0.1.0]

Initial release.

- Full RPC client — spawns `gsd --mode rpc`, JSON line framing, all RPC commands
- Sidebar dashboard — connection status, model info, thinking level, token usage, cost, quick actions
- Chat participant — `@gsd` in VS Code Chat with streaming responses
- File decorations — "G" badge on files modified by the agent
- Bash terminal — pseudoterminal routing agent Bash tool output
- Session tree — browse and switch between session files
- Conversation history — webview panel with full chat log
- Slash command completion — auto-complete for `/gsd` commands
- Code lens — "Ask GSD" above functions and classes in TS/JS/Python/Go/Rust
- 25 commands with 6 keyboard shortcuts
- Auto-start, auto-compaction, and code lens configuration
