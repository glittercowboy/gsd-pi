# Quick Reference — All UI APIs

### ctx.ui Dialog Methods (Blocking)

| Method | Returns | Description |
|--------|---------|-------------|
| `select(title, options)` | `string \| undefined` | Selection dialog |
| `confirm(title, message, opts?)` | `boolean` | Yes/No confirmation |
| `input(label, placeholder?, opts?)` | `string \| undefined` | Single-line text input |
| `editor(label, prefill?, opts?)` | `string \| undefined` | Multi-line text editor |

### ctx.ui Persistent Methods (Non-Blocking)

| Method | Description |
|--------|-------------|
| `notify(message, level)` | Toast notification (`"info"`, `"warning"`, `"error"`) |
| `setStatus(id, text?)` | Footer status (clear with `undefined`) |
| `setWidget(id, content?, opts?)` | Widget above/below editor |
| `setWorkingMessage(text?)` | Working message during streaming |
| `setFooter(factory?)` | Replace footer (restore with `undefined`) |
| `setHeader(factory?)` | Replace header (restore with `undefined`) |
| `setTitle(title)` | Terminal title |
| `setEditorText(text)` | Set editor content |
| `getEditorText()` | Get editor content |
| `pasteToEditor(text)` | Paste into editor |
| `setToolsExpanded(bool)` | Expand/collapse tool output |
| `getToolsExpanded()` | Get expansion state |
| `setEditorComponent(factory?)` | Replace editor (restore with `undefined`) |
| `custom(factory, opts?)` | Full custom component / overlay |
| `setTheme(name \| Theme)` | Switch theme |
| `getTheme(name)` | Load theme without switching |
| `getAllThemes()` | List available themes |
| `theme` | Current theme object |

### Component Interface

| Method | Required | Description |
|--------|----------|-------------|
| `render(width): string[]` | Yes | Render to lines (each ≤ width) |
| `handleInput(data): void` | No | Receive keyboard input |
| `invalidate(): void` | Yes | Clear caches |
| `wantsKeyRelease?: boolean` | No | Receive key release events |

### Key Imports

```typescript
// From @mariozechner/pi-tui
import {
  Text, Box, Container, Spacer, Markdown, Image,
  SelectList, SettingsList, Input, Editor,
  matchesKey, Key,
  visibleWidth, truncateToWidth, wrapTextWithAnsi,
  CURSOR_MARKER,
  type Component, type Focusable, type SelectItem, type SettingItem,
  type EditorTheme, type OverlayAnchor, type OverlayOptions, type OverlayHandle,
} from "@mariozechner/pi-tui";

// From @mariozechner/pi-coding-agent
import {
  DynamicBorder, BorderedLoader, CustomEditor,
  getMarkdownTheme, getSettingsListTheme,
  highlightCode, getLanguageFromPath,
  keyHint, appKeyHint, editorKey, rawKeyHint,
  type ExtensionAPI, type ExtensionContext, type Theme,
} from "@mariozechner/pi-coding-agent";
```

---
