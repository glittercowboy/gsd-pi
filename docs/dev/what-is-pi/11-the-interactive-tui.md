# The Interactive TUI

Pi's terminal interface is built with a custom TUI framework (`@mariozechner/pi-tui`).

### Layout (top to bottom)

```
┌─────────────────────────────────────────────────────────────┐
│  Startup Header                                              │
│  Shows: shortcuts, loaded AGENTS.md files, prompts,          │
│  skills, extensions                                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Messages Area                                               │
│  User messages, assistant responses, tool calls/results,     │
│  notifications, errors, extension UI                         │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│  [Widgets above editor - from extensions]                    │
├─────────────────────────────────────────────────────────────┤
│  Editor (input area)                                         │
│  Border color = thinking level                               │
├─────────────────────────────────────────────────────────────┤
│  [Widgets below editor - from extensions]                    │
├─────────────────────────────────────────────────────────────┤
│  Footer: cwd │ session name │ tokens │ cost │ context │ model│
│  [Extension status indicators]                               │
└─────────────────────────────────────────────────────────────┘
```

### Editor Features

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Tab to complete paths |
| Multi-line | Shift+Enter |
| Images | Ctrl+V to paste, or drag onto terminal |
| Bash commands | `!command` (sends output to LLM), `!!command` (runs without sending) |
| External editor | Ctrl+G opens `$VISUAL` or `$EDITOR` |

### Tool Output Display

Tool calls and results are rendered inline with collapsible output:
- `Ctrl+O` — Toggle expand/collapse all tool output
- `Ctrl+T` — Toggle expand/collapse thinking blocks

Extensions can provide custom renderers for their tools, controlling exactly how tool calls and results appear.

---
