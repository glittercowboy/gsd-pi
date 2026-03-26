# Quick Reference — Commands & Shortcuts

### Commands

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | OAuth authentication |
| `/model` | Switch models |
| `/scoped-models` | Configure Ctrl+P model cycling |
| `/settings` | Thinking level, theme, delivery mode, transport |
| `/resume` | Browse previous sessions |
| `/new` | New session |
| `/name <name>` | Name current session |
| `/session` | Session info (path, tokens, cost) |
| `/tree` | Navigate session tree |
| `/fork` | Fork to new session |
| `/compact [instructions]` | Manual compaction |
| `/copy` | Copy last response to clipboard |
| `/export [file]` | Export to HTML |
| `/share` | Upload as private GitHub gist |
| `/reload` | Reload extensions, skills, prompts, context files |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Version history |
| `/quit`, `/exit` | Exit pi |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Ctrl+C | Clear editor / quit (twice) |
| Escape | Cancel/abort / open `/tree` (twice) |
| Ctrl+L | Model selector |
| Ctrl+P / Shift+Ctrl+P | Cycle scoped models |
| Shift+Tab | Cycle thinking level |
| Ctrl+O | Toggle tool output expand/collapse |
| Ctrl+T | Toggle thinking block expand/collapse |
| Ctrl+G | Open external editor |
| Ctrl+V | Paste (including images) |
| Enter (during streaming) | Queue steering message |
| Alt+Enter (during streaming) | Queue follow-up message |
| Alt+Up | Retrieve queued messages |

### CLI

```bash
pi                                    # Interactive mode
pi "prompt"                           # Interactive with initial prompt
pi -p "prompt"                        # Print mode (non-interactive)
pi -c                                 # Continue last session
pi -r                                 # Resume (browse sessions)
pi --model provider/model:thinking    # Specify model
pi --tools read,bash                  # Specify tools
pi -e ./extension.ts                  # Load extension
pi --mode rpc                         # RPC mode
pi --mode json                        # JSON mode
pi @file.ts "Review this"            # Include file in prompt
pi install npm:package               # Install package
pi list                               # List packages
```

---

*This document was generated from the Pi documentation. Source files are at:*
```
/Users/lexchristopherson/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/
```

*Companion document: **Pi-Extensions-Complete-Guide.md** (on Desktop)*
