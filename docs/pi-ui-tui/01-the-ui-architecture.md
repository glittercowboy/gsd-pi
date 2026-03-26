# The UI Architecture

Pi's TUI is a custom terminal rendering system. Understanding its architecture prevents most mistakes:

```
┌─────────────────────────────────────────────────────────────┐
│                    Terminal Window                            │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Custom Header (ctx.ui.setHeader)                      │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │                                                        │  │
│  │  Message Area                                          │  │
│  │  - User messages                                       │  │
│  │  - Assistant responses                                 │  │
│  │  - Tool calls and results ◄── renderCall/renderResult  │  │
│  │  - Custom messages ◄── registerMessageRenderer         │  │
│  │  - Notifications                                       │  │
│  │                                                        │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │  Widgets (above editor) ◄── ctx.ui.setWidget           │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │                                                        │  │
│  │  Editor ◄── Can be replaced by:                        │  │
│  │    - ctx.ui.custom() (temporary full replacement)      │  │
│  │    - ctx.ui.setEditorComponent() (permanent replace)   │  │
│  │                                                        │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │  Widgets (below editor) ◄── ctx.ui.setWidget           │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │  Footer ◄── ctx.ui.setFooter / ctx.ui.setStatus        │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────┐                                  │
│  │  Overlay (floating)    │ ◄── ctx.ui.custom({ overlay })   │
│  │  Rendered on top of    │                                  │
│  │  everything            │                                  │
│  └────────────────────────┘                                  │
└─────────────────────────────────────────────────────────────┘
```

**Key principles:**
- Everything renders as **arrays of strings** (one per line)
- Each line **must not exceed the `width` parameter** — this is enforced
- **ANSI escape codes** are used for styling — they don't count toward visible width
- **Styles do NOT carry across lines** — the TUI resets SGR at the end of each line
- All **state changes require explicit invalidation** followed by a render request
- **Theme is always passed via callbacks** — never import it directly

### Packages

| Package | What it provides |
|---------|-----------------|
| `@mariozechner/pi-tui` | Core components (`Text`, `Box`, `Container`, `SelectList`, etc.), keyboard handling, text utilities |
| `@mariozechner/pi-coding-agent` | Higher-level components (`DynamicBorder`, `BorderedLoader`, `CustomEditor`), theming helpers, code highlighting |

---
