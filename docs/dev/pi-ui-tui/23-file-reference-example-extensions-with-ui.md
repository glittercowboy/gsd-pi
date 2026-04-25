# File Reference — Example Extensions with UI

All paths relative to:
```
/Users/lexchristopherson/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/examples/extensions/
```

### Full Custom Components
| File | What It Demonstrates |
|------|---------------------|
| `snake.ts` | **Game** — Timer loop, keyboard handling, WASD + arrows, render caching, session persistence, pause/resume |
| `space-invaders.ts` | **Game** — Similar patterns to snake with more complex rendering |
| `doom-overlay/` | **Game as overlay** — DOOM running at 35 FPS in a floating overlay, real-time rendering |
| `questionnaire.ts` | **Multi-tab wizard** — Tab navigation, embedded `Editor` for free-text, option selection, submission flow |
| `modal-editor.ts` | **Custom editor** — Vim-like modal editing with mode indicator |
| `rainbow-editor.ts` | **Custom editor** — Animated text effects |

### Dialogs and Selection
| File | What It Demonstrates |
|------|---------------------|
| `preset.ts` | `SelectList` with `DynamicBorder`, complex multi-value presets |
| `tools.ts` | `SettingsList` for toggling tools on/off |
| `question.ts` | `ctx.ui.select()` inside a tool |
| `timed-confirm.ts` | Dialogs with `timeout` and `AbortSignal` |

### Overlays
| File | What It Demonstrates |
|------|---------------------|
| `overlay-test.ts` | Basic overlay compositing with inline inputs |
| `overlay-qa-tests.ts` | **Comprehensive** — All 9 anchors, margins, offsets, stacking, responsive visibility, animation at ~30 FPS, percentage sizing, max-height |

### Persistent UI
| File | What It Demonstrates |
|------|---------------------|
| `plan-mode/` | `setStatus` + `setWidget` for progress tracking, reactive updates |
| `status-line.ts` | `setStatus` with themed colors |
| `widget-placement.ts` | `setWidget` above and below editor |
| `custom-footer.ts` | `setFooter` with git branch, token stats, reactive branch changes |
| `custom-header.ts` | `setHeader` for custom startup header |

### Tool Rendering
| File | What It Demonstrates |
|------|---------------------|
| `todo.ts` | **Complete example** — `renderCall` and `renderResult` with expanded/collapsed views, state in details |
| `built-in-tool-renderer.ts` | Custom compact rendering for built-in tools |
| `minimal-mode.ts` | Override rendering for minimal display |

### Message Rendering
| File | What It Demonstrates |
|------|---------------------|
| `message-renderer.ts` | `registerMessageRenderer` with colors and expandable details |

### Async Operations
| File | What It Demonstrates |
|------|---------------------|
| `qna.ts` | `BorderedLoader` for async LLM calls with cancel |
| `summarize.ts` | Summarize conversation with transient UI |

### Notifications and Status
| File | What It Demonstrates |
|------|---------------------|
| `notify.ts` | Desktop notifications via OSC 777 (Ghostty, iTerm2, WezTerm) |
| `titlebar-spinner.ts` | Braille spinner animation in terminal title |
| `model-status.ts` | React to model changes with `setStatus` |

### Documentation References
| File | What It Covers |
|------|---------------|
| `docs/tui.md` | Full TUI component API, all patterns, performance, theming |
| `docs/extensions.md` | Custom UI section, custom components, overlays, rendering |
| `docs/themes.md` | Creating custom themes, full color palette |
| `docs/keybindings.md` | Keyboard shortcut format, customization |

### Debug Logging

```bash
PI_TUI_WRITE_LOG=/tmp/tui-ansi.log pi
```

Captures the raw ANSI stream for debugging rendering issues.

---

*This document was generated from Pi's TUI and extension documentation. Source files:*
```
/Users/lexchristopherson/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/tui.md
/Users/lexchristopherson/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md
/Users/lexchristopherson/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/examples/extensions/
```

*Companion documents on Desktop:*
- **Pi-What-It-Is-And-How-It-Works.md** — What Pi is and how it works
- **Pi-Extensions-Complete-Guide.md** — Full extensions API reference
