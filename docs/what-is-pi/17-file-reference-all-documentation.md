# File Reference — All Documentation

All paths relative to:
```
/Users/lexchristopherson/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/
```

### Core Documentation

| File | What It Covers |
|------|---------------|
| `README.md` | Main documentation — quick start, all features, CLI reference, philosophy |
| `docs/extensions.md` | Extensions API — events, tools, commands, UI, state, rendering (1,972 lines) |
| `docs/tui.md` | TUI component system — Component interface, built-in components, keyboard, theming, overlays |
| `docs/session.md` | Session format — JSONL tree structure, entry types, message types, SessionManager API |
| `docs/compaction.md` | Compaction & branch summarization — triggers, algorithm, summary format, extension hooks |
| `docs/packages.md` | Pi packages — creating, installing, distributing via npm/git |
| `docs/skills.md` | Skills — structure, frontmatter, locations, invocation |
| `docs/prompt-templates.md` | Prompt templates — format, arguments, locations |
| `docs/themes.md` | Themes — creating custom themes, color palette |
| `docs/settings.md` | Settings — all configuration options |
| `docs/keybindings.md` | Keyboard shortcuts — format, built-in bindings, customization |
| `docs/providers.md` | Provider setup — detailed instructions for each provider |
| `docs/models.md` | Custom models — models.json format |
| `docs/custom-provider.md` | Custom providers — advanced: OAuth, custom streaming, model definitions |
| `docs/sdk.md` | SDK — AgentSession, events, embedding pi in applications |
| `docs/rpc.md` | RPC mode — JSON protocol, commands, events |
| `docs/json.md` | JSON mode — event stream format |
| `docs/what-is-pi/19-building-branded-apps-on-top-of-pi.md` | Branded app architecture — shipping your own CLI, app-owned storage, SDK vs RPC, bundling resources |
| `docs/development.md` | Contributing — development setup, forking, debugging |
| `docs/windows.md` | Windows platform notes |
| `docs/termux.md` | Termux (Android) setup |
| `docs/terminal-setup.md` | Terminal configuration recommendations |
| `docs/shell-aliases.md` | Shell alias patterns |

### Example Extensions

See the companion doc **Pi-Extensions-Complete-Guide.md** for a categorized reference of all 50+ example extensions.

```
examples/extensions/          # All example extensions
examples/sdk/                 # SDK usage examples
```

### Source Code (on GitHub)

| Package | Purpose |
|---------|---------|
| `packages/coding-agent` | The main pi package — agent, tools, extensions, session, compaction |
| `packages/tui` | Terminal UI component library |
| `packages/ai` | Core LLM toolkit — providers, streaming, message types |
| `packages/agent` | Agent loop framework |

---
