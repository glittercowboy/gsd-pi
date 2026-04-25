# Custom UI — Visual Components


Pi's extension UI has multiple layers, from simple notifications to full custom components.

### 12.1 Dialogs (Blocking)

```typescript
// Selection
const choice = await ctx.ui.select("Pick one:", ["A", "B", "C"]);

// Confirmation
const ok = await ctx.ui.confirm("Delete?", "This cannot be undone");

// Text input
const name = await ctx.ui.input("Name:", "placeholder");

// Multi-line editor
const text = await ctx.ui.editor("Edit:", "prefilled text");
```

#### Timed Dialogs

```typescript
// Auto-dismiss after 5s with countdown: "Title (5s)" → "Title (4s)" → ...
const ok = await ctx.ui.confirm("Auto-confirm?", "Proceeds in 5s", { timeout: 5000 });
// Returns false on timeout
```

### 12.2 Persistent UI Elements

```typescript
// Footer status (persistent until cleared)
ctx.ui.setStatus("my-ext", "● Active");
ctx.ui.setStatus("my-ext", undefined);   // Clear

// Widget above editor (default placement)
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"]);

// Widget below editor
ctx.ui.setWidget("my-widget", ["Below!"], { placement: "belowEditor" });

// Widget with theme callback
ctx.ui.setWidget("my-widget", (_tui, theme) => ({
  render: () => [theme.fg("accent", "Styled widget")],
  invalidate: () => {},
}));

// Working message during streaming
ctx.ui.setWorkingMessage("Analyzing code...");
ctx.ui.setWorkingMessage();  // Restore default

// Custom footer (replaces built-in entirely)
ctx.ui.setFooter((tui, theme, footerData) => ({
  render(width) { return [theme.fg("dim", `branch: ${footerData.getGitBranch()}`)]; },
  invalidate() {},
  dispose: footerData.onBranchChange(() => tui.requestRender()),
}));

// Editor control
ctx.ui.setEditorText("Prefill");
const current = ctx.ui.getEditorText();
ctx.ui.pasteToEditor("pasted content");

// Tool expansion
ctx.ui.setToolsExpanded(true);
ctx.ui.setToolsExpanded(false);

// Theme management
const themes = ctx.ui.getAllThemes();
ctx.ui.setTheme("light");
```

### 12.3 Custom Components (ctx.ui.custom)

For complex UI, `ctx.ui.custom()` temporarily replaces the editor with your component:

```typescript
const result = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
  // Return a component object
  return {
    render(width: number): string[] {
      return ["Press Enter to confirm, Escape to cancel"];
    },
    handleInput(data: string) {
      if (matchesKey(data, Key.enter)) done("confirmed");
      if (matchesKey(data, Key.escape)) done(null);
    },
    invalidate() {},
  };
});
```

### 12.4 Overlays (Floating Modals)

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new MyDialog({ onClose: done }),
  {
    overlay: true,
    overlayOptions: {
      anchor: "center",         // 9 positions: center, top-left, top-right, etc.
      width: "50%",
      maxHeight: "80%",
      margin: 2,
      visible: (w, h) => w >= 80,  // Hide on narrow terminals
    },
    onHandle: (handle) => {
      // handle.setHidden(true/false)
    },
  }
);
```

### 12.5 Custom Editor (Replace Main Input)

```typescript
import { CustomEditor } from "@gsd/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@gsd/pi-tui";

class VimEditor extends CustomEditor {
  private mode: "normal" | "insert" = "insert";

  handleInput(data: string): void {
    if (matchesKey(data, "escape") && this.mode === "insert") {
      this.mode = "normal";
      return;
    }
    if (this.mode === "insert") {
      super.handleInput(data);  // Normal text editing + app keybindings
      return;
    }
    // Vim normal mode keys...
    if (data === "i") { this.mode = "insert"; return; }
    super.handleInput(data);  // Pass unhandled to parent
  }
}

// Register:
ctx.ui.setEditorComponent((_tui, theme, keybindings) => new VimEditor(theme, keybindings));
ctx.ui.setEditorComponent(undefined);  // Restore default
```

> **Key point:** Extend `CustomEditor` (not `Editor`) to get app keybindings (escape to abort, ctrl+d, model switching).

### 12.6 Built-in TUI Components

Import from `@gsd/pi-tui`:

| Component | Purpose |
|-----------|---------|
| `Text` | Multi-line text with word wrapping |
| `Box` | Container with padding and background |
| `Container` | Groups children vertically |
| `Spacer` | Empty vertical space |
| `Markdown` | Rendered markdown with syntax highlighting |
| `Image` | Image rendering (Kitty, iTerm2, etc.) |
| `SelectList` | Interactive selection from list |
| `SettingsList` | Toggle settings UI |
| `Input` | Text input field |

Import from `@gsd/pi-coding-agent`:

| Component | Purpose |
|-----------|---------|
| `DynamicBorder` | Border line with theming |
| `BorderedLoader` | Spinner with cancel support |

### 12.7 Keyboard Input

```typescript
import { matchesKey, Key } from "@gsd/pi-tui";

handleInput(data: string) {
  if (matchesKey(data, Key.up)) { /* arrow up */ }
  if (matchesKey(data, Key.enter)) { /* enter */ }
  if (matchesKey(data, Key.escape)) { /* escape */ }
  if (matchesKey(data, Key.ctrl("c"))) { /* ctrl+c */ }
  if (matchesKey(data, Key.shift("tab"))) { /* shift+tab */ }
}
```

### 12.8 Line Width Rules

**Critical:** Each line from `render()` must not exceed the `width` parameter.

```typescript
import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@gsd/pi-tui";

render(width: number): string[] {
  return [truncateToWidth(this.text, width)];
}
```

---
