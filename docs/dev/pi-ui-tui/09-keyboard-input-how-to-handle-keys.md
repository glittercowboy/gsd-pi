# Keyboard Input — How to Handle Keys

### matchesKey — The Key Detection Function

```typescript
import { matchesKey, Key } from "@mariozechner/pi-tui";

handleInput(data: string) {
  // Using Key constants (recommended — gives autocomplete)
  if (matchesKey(data, Key.up)) { /* arrow up */ }
  if (matchesKey(data, Key.down)) { /* arrow down */ }
  if (matchesKey(data, Key.left)) { /* arrow left */ }
  if (matchesKey(data, Key.right)) { /* arrow right */ }
  if (matchesKey(data, Key.enter)) { /* enter */ }
  if (matchesKey(data, Key.escape)) { /* escape */ }
  if (matchesKey(data, Key.tab)) { /* tab */ }
  if (matchesKey(data, Key.space)) { /* space */ }
  if (matchesKey(data, Key.backspace)) { /* backspace */ }
  if (matchesKey(data, Key.delete)) { /* delete */ }
  if (matchesKey(data, Key.home)) { /* home */ }
  if (matchesKey(data, Key.end)) { /* end */ }

  // With modifiers
  if (matchesKey(data, Key.ctrl("c"))) { /* ctrl+c */ }
  if (matchesKey(data, Key.ctrl("x"))) { /* ctrl+x */ }
  if (matchesKey(data, Key.shift("tab"))) { /* shift+tab */ }
  if (matchesKey(data, Key.alt("left"))) { /* alt+left */ }
  if (matchesKey(data, Key.ctrlShift("p"))) { /* ctrl+shift+p */ }

  // String format also works
  if (matchesKey(data, "enter")) { }
  if (matchesKey(data, "ctrl+c")) { }
  if (matchesKey(data, "shift+tab")) { }

  // Printable character detection
  if (data.length === 1 && data.charCodeAt(0) >= 32) {
    // It's a printable character (letter, number, symbol)
  }
}
```

### Key identifiers Reference

| Category | Keys |
|----------|------|
| Basic | `enter`, `escape`, `tab`, `space`, `backspace`, `delete`, `home`, `end` |
| Arrow | `up`, `down`, `left`, `right` |
| Modifiers | `ctrl("x")`, `shift("tab")`, `alt("left")`, `ctrlShift("p")` |

### The handleInput Contract

```typescript
handleInput(data: string): void {
  // 1. Check for your keys
  // 2. Update state
  // 3. Call this.invalidate() if render output changes
  // 4. Call tui.requestRender() to trigger a re-render
  //    (or if you're the top-level custom component, the TUI does this automatically)
}
```

---
