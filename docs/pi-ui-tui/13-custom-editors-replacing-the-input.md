# Custom Editors — Replacing the Input

Replace the main input editor with a custom implementation. The editor persists until explicitly removed.

### The Pattern

```typescript
import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

class VimEditor extends CustomEditor {
  private mode: "normal" | "insert" = "insert";

  handleInput(data: string): void {
    // Escape in insert mode → switch to normal
    if (matchesKey(data, "escape") && this.mode === "insert") {
      this.mode = "normal";
      return;
    }

    // Insert mode: pass everything to CustomEditor for text editing + app keybindings
    if (this.mode === "insert") {
      super.handleInput(data);
      return;
    }

    // Normal mode: vim keys
    switch (data) {
      case "i": this.mode = "insert"; return;
      case "h": super.handleInput("\x1b[D"); return;  // Left arrow
      case "j": super.handleInput("\x1b[B"); return;  // Down arrow
      case "k": super.handleInput("\x1b[A"); return;  // Up arrow
      case "l": super.handleInput("\x1b[C"); return;  // Right arrow
    }

    // Filter printable chars in normal mode (don't insert them)
    if (data.length === 1 && data.charCodeAt(0) >= 32) return;

    // Pass unhandled to super (ctrl+c, ctrl+d, etc.)
    super.handleInput(data);
  }

  render(width: number): string[] {
    const lines = super.render(width);
    // Add mode indicator to last line
    if (lines.length > 0) {
      const label = this.mode === "normal" ? " NORMAL " : " INSERT ";
      const lastLine = lines[lines.length - 1]!;
      lines[lines.length - 1] = truncateToWidth(lastLine, width - label.length, "") + label;
    }
    return lines;
  }
}

// Register it:
export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((_tui, theme, keybindings) =>
      new VimEditor(theme, keybindings)
    );
  });
}
```

### Critical Rules

1. **Extend `CustomEditor`**, not `Editor`. `CustomEditor` provides app keybindings (escape to abort, ctrl+d to exit, model switching) that must not be lost.
2. **Call `super.handleInput(data)`** for any key you don't handle.
3. **Use the factory pattern**: `setEditorComponent` receives a factory `(tui, theme, keybindings) => CustomEditor`.
4. **Pass `undefined` to restore default**: `ctx.ui.setEditorComponent(undefined)`.

---
