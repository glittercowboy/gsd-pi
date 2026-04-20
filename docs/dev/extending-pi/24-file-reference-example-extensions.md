# File Reference — Example Extensions


All paths relative to:
```
/Users/lexchristopherson/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/examples/extensions/
```

### Lifecycle & Safety
| File | What It Demonstrates |
|------|---------------------|
| `protected-paths.ts` | Blocking writes to `.env`, `.git/`, `node_modules/` via `tool_call` |
| `dirty-repo-guard.ts` | Preventing session changes with uncommitted git changes |

### Custom Tools
| File | What It Demonstrates |
|------|---------------------|
| `todo.ts` | **Best example** — Stateful tool with persistence, custom rendering, command |
| `hello.ts` | Minimal tool registration |
| `question.ts` | Tool with `ctx.ui.select()` for user interaction |
| `questionnaire.ts` | Multi-question wizard with tab navigation |
| `tool-override.ts` | Overriding built-in `read` with logging/access control |
| `dynamic-tools.ts` | Registering tools after startup and at runtime |
| `truncated-tool.ts` | Output truncation with `truncateHead` |
| `built-in-tool-renderer.ts` | Custom compact rendering for built-in tools |
| `antigravity-image-gen.ts` | Image generation tool |
| `ssh.ts` | Full SSH remote execution with pluggable operations |

### Commands & UI
| File | What It Demonstrates |
|------|---------------------|
| `commands.ts` | Basic command registration |
| `preset.ts` | Named presets (model, thinking, tools) with flag and command |
| `plan-mode/` | Full plan mode — commands, shortcuts, flags, widgets, status, tool management |
| `qna.ts` | Extract questions + `BorderedLoader` + `setEditorText` |
| `send-user-message.ts` | `pi.sendUserMessage()` for injecting user messages |
| `modal-editor.ts` | Vim-like modal editor via `CustomEditor` |
| `snake.ts` | Full game with custom UI, keyboard handling, persistence |
| `space-invaders.ts` | Full game with custom UI |
| `doom-overlay/` | DOOM running as an overlay at 35 FPS |
| `timed-confirm.ts` | Dialogs with `timeout` and `AbortSignal` |
| `overlay-test.ts` | Overlay compositing with inline inputs |
| `overlay-qa-tests.ts` | Comprehensive overlay tests: anchors, margins, stacking |

### System Prompt & Context
| File | What It Demonstrates |
|------|---------------------|
| `pirate.ts` | `before_agent_start` system prompt modification |
| `claude-rules.ts` | Loading rules from `.claude/rules/` into system prompt |
| `system-prompt-header.ts` | Displaying system prompt info |
| `input-transform.ts` | Transforming user input via `input` event |
| `inline-bash.ts` | Expanding `!{command}` patterns in prompts |

### Compaction & Sessions
| File | What It Demonstrates |
|------|---------------------|
| `custom-compaction.ts` | Custom compaction summary via `session_before_compact` |
| `trigger-compact.ts` | Triggering compaction at 100k tokens |
| `git-checkpoint.ts` | Git stash on turns, restore on fork |
| `bookmark.ts` | Labeling entries for `/tree` navigation |
| `session-name.ts` | Naming sessions for selector display |

### UI Components
| File | What It Demonstrates |
|------|---------------------|
| `custom-footer.ts` | `setFooter` with git branch and token stats |
| `custom-header.ts` | `setHeader` for custom startup header |
| `status-line.ts` | `setStatus` for footer indicators |
| `widget-placement.ts` | `setWidget` above and below editor |
| `notify.ts` | Desktop notifications via OSC 777 |
| `titlebar-spinner.ts` | Braille spinner in terminal title |
| `message-renderer.ts` | Custom message rendering with `registerMessageRenderer` |
| `model-status.ts` | `model_select` event for status bar |
| `mac-system-theme.ts` | Auto-sync theme with macOS dark/light mode |

### Providers
| File | What It Demonstrates |
|------|---------------------|
| `custom-provider-anthropic/` | Custom Anthropic provider with OAuth |
| `custom-provider-gitlab-duo/` | GitLab Duo via proxy |
| `custom-provider-qwen-cli/` | Qwen CLI with OAuth device flow |

### Communication
| File | What It Demonstrates |
|------|---------------------|
| `event-bus.ts` | Inter-extension communication via `pi.events` |
| `rpc-demo.ts` | All RPC-supported extension UI methods |
| `reload-runtime.ts` | Safe reload flow: command + LLM tool handoff |
| `shutdown-command.ts` | `ctx.shutdown()` for graceful exit |
| `file-trigger.ts` | File watcher injecting messages via `sendMessage` |

### Misc
| File | What It Demonstrates |
|------|---------------------|
| `with-deps/` | Extension with its own `package.json` and npm dependencies |
| `minimal-mode.ts` | Override built-in tool rendering for minimal display |

---

## Quick Reference: "I want to..."

| Goal | Approach | Key API | Example File |
|------|----------|---------|-------------|
| Block dangerous commands | Listen to `tool_call`, return `{ block: true }` | `pi.on("tool_call", ...)` | `protected-paths.ts` |
| Add a tool the LLM can use | Register a tool with schema and execute | `pi.registerTool({...})` | `todo.ts` |
| Add a slash command | Register a command with handler | `pi.registerCommand(...)` | `commands.ts` |
| Ask the user a question | Use dialog methods | `ctx.ui.select()`, `ctx.ui.confirm()` | `question.ts` |
| Show persistent status | Set footer status | `ctx.ui.setStatus(id, text)` | `status-line.ts` |
| Modify the system prompt | Hook `before_agent_start` | Return `{ systemPrompt: "..." }` | `pirate.ts` |
| Filter messages sent to LLM | Hook `context` event | Return `{ messages: [...] }` | — |
| Save state across restarts | Store in tool details or appendEntry | `details: {...}` / `pi.appendEntry(...)` | `todo.ts` |
| Custom compaction | Hook `session_before_compact` | Return `{ compaction: {...} }` | `custom-compaction.ts` |
| Build a full-screen UI | Use `ctx.ui.custom()` | Component with render/handleInput | `snake.ts` |
| Show a floating dialog | Use overlay mode | `ctx.ui.custom(..., { overlay: true })` | `overlay-test.ts` |
| Replace the input editor | Extend `CustomEditor` | `ctx.ui.setEditorComponent(...)` | `modal-editor.ts` |
| Override a built-in tool | Register tool with same name | `pi.registerTool({ name: "read" })` | `tool-override.ts` |
| Run tools via SSH | Use pluggable operations | `createBashTool(cwd, { operations })` | `ssh.ts` |
| Switch models programmatically | Find and set model | `pi.setModel(model)` | `preset.ts` |
| Register a custom provider | Provide config with models | `pi.registerProvider(...)` | `custom-provider-anthropic/` |
| Transform user input | Hook `input` event | Return `{ action: "transform", text }` | `input-transform.ts` |
| Inject messages | Send custom or user messages | `pi.sendMessage()` / `pi.sendUserMessage()` | `send-user-message.ts` |
| React to model changes | Hook `model_select` | `pi.on("model_select", ...)` | `model-status.ts` |
| Add a keyboard shortcut | Register a shortcut | `pi.registerShortcut("ctrl+x", ...)` | `plan-mode/` |
| Package for distribution | Add `pi` key to package.json | `"pi": { "extensions": [...] }` | See packages.md |

---

*This document was generated from the Pi extension documentation and examples. Source docs are at:*
```
/Users/lexchristopherson/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/
/Users/lexchristopherson/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/examples/extensions/
```
