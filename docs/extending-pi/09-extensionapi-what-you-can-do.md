# ExtensionAPI — What You Can Do


The `pi` object (received in your default export function) is your registration interface. It persists for the lifetime of the extension.

### Core Registration

| Method | Purpose |
|--------|---------|
| `pi.on(event, handler)` | Subscribe to events |
| `pi.registerTool(definition)` | Register a tool the LLM can call |
| `pi.registerCommand(name, options)` | Register a `/command` |
| `pi.registerShortcut(key, options)` | Register a keyboard shortcut |
| `pi.registerFlag(name, options)` | Register a CLI flag |
| `pi.registerMessageRenderer(customType, renderer)` | Custom message rendering |
| `pi.registerProvider(name, config)` | Register/override a model provider |
| `pi.unregisterProvider(name)` | Remove a provider |

### Messaging

| Method | Purpose |
|--------|---------|
| `pi.sendMessage(message, options?)` | Inject a custom message into the session |
| `pi.sendUserMessage(content, options?)` | Send a user message (triggers a turn) |

**`sendMessage` delivery modes:**
- `"steer"` (default) — Interrupts streaming. Delivered after current tool finishes, remaining tools skipped.
- `"followUp"` — Waits for agent to finish. Delivered when agent has no more tool calls.
- `"nextTurn"` — Queued for next user prompt. Does not interrupt.

### State & Session

| Method | Purpose |
|--------|---------|
| `pi.appendEntry(customType, data?)` | Persist extension state (NOT sent to LLM) |
| `pi.setSessionName(name)` | Set display name for session selector |
| `pi.getSessionName()` | Get current session name |
| `pi.setLabel(entryId, label)` | Bookmark an entry for `/tree` navigation |

### Tool Management

| Method | Purpose |
|--------|---------|
| `pi.getActiveTools()` | Get currently active tool names |
| `pi.getAllTools()` | Get all registered tools (name + description) |
| `pi.setActiveTools(names)` | Enable/disable tools at runtime |

### Model Management

| Method | Purpose |
|--------|---------|
| `pi.setModel(model)` | Switch model. Returns `false` if no API key. |
| `pi.getThinkingLevel()` | Get current thinking level |
| `pi.setThinkingLevel(level)` | Set thinking level (`"off"` through `"xhigh"`) |

### Utilities

| Method | Purpose |
|--------|---------|
| `pi.exec(command, args, options?)` | Execute a shell command |
| `pi.events` | Shared event bus for inter-extension communication |
| `pi.getFlag(name)` | Get value of a registered CLI flag |
| `pi.getCommands()` | Get all available slash commands |

### ExtensionCommandContext (commands only)

Command handlers receive `ExtensionCommandContext`, which adds session control methods not available in regular event handlers (they would deadlock there):

| Method | Purpose |
|--------|---------|
| `ctx.waitForIdle()` | Wait for agent to finish streaming |
| `ctx.newSession(options?)` | Create a new session |
| `ctx.fork(entryId)` | Fork from an entry |
| `ctx.navigateTree(targetId, options?)` | Navigate the session tree |
| `ctx.reload()` | Hot-reload extensions, skills, prompts, themes |

---
