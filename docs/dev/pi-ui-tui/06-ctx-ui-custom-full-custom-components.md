# ctx.ui.custom() — Full Custom Components

This is the most powerful UI mechanism. It **temporarily replaces the editor** with your component. Returns a value when `done()` is called.

### Basic Pattern

```typescript
const result = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
  // tui        — TUI instance (requestRender, screen dimensions)
  // theme      — Current theme for styling
  // keybindings — App keybinding manager
  // done(value) — Call to close component and return value

  return {
    render(width: number): string[] {
      return [
        theme.fg("accent", "─".repeat(width)),
        " Press Enter to confirm, Escape to cancel",
        theme.fg("accent", "─".repeat(width)),
      ];
    },
    handleInput(data: string) {
      if (matchesKey(data, Key.enter)) done("confirmed");
      if (matchesKey(data, Key.escape)) done(null);
    },
    invalidate() {},
  };
});

if (result === "confirmed") {
  ctx.ui.notify("Confirmed!", "info");
}
```

### The Factory Callback

The factory function receives four arguments:

| Argument | Type | Purpose |
|----------|------|---------|
| `tui` | `TUI` | Screen info and render control. `tui.requestRender()` triggers re-render after state changes. |
| `theme` | `Theme` | Current theme. Use `theme.fg()`, `theme.bg()`, `theme.bold()`, etc. |
| `keybindings` | `KeybindingsManager` | App keybinding config. For checking what keys do what. |
| `done` | `(value: T) => void` | Call this to close the component and return a value to the awaiting code. |

### Using Existing Components as Children

```typescript
const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
  const container = new Container();
  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
  container.addChild(new Text(theme.fg("accent", theme.bold("Title")), 1, 0));

  const selectList = new SelectList(items, 10, {
    selectedPrefix: (t) => theme.fg("accent", t),
    selectedText: (t) => theme.fg("accent", t),
    description: (t) => theme.fg("muted", t),
    scrollInfo: (t) => theme.fg("dim", t),
    noMatch: (t) => theme.fg("warning", t),
  });
  selectList.onSelect = (item) => done(item.value);
  selectList.onCancel = () => done(null);
  container.addChild(selectList);

  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

  return {
    render: (w) => container.render(w),
    invalidate: () => container.invalidate(),
    handleInput: (data) => { selectList.handleInput(data); tui.requestRender(); },
  };
});
```

### Using a Class

```typescript
class MyComponent {
  private selected = 0;
  private items: string[];
  private done: (value: string | null) => void;
  private tui: { requestRender: () => void };
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(tui: TUI, items: string[], done: (value: string | null) => void) {
    this.tui = tui;
    this.items = items;
    this.done = done;
  }

  handleInput(data: string) {
    if (matchesKey(data, Key.up) && this.selected > 0) {
      this.selected--;
      this.invalidate();
      this.tui.requestRender();
    } else if (matchesKey(data, Key.down) && this.selected < this.items.length - 1) {
      this.selected++;
      this.invalidate();
      this.tui.requestRender();
    } else if (matchesKey(data, Key.enter)) {
      this.done(this.items[this.selected]);
    } else if (matchesKey(data, Key.escape)) {
      this.done(null);
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    this.cachedLines = this.items.map((item, i) => {
      const prefix = i === this.selected ? "> " : "  ";
      return truncateToWidth(prefix + item, width);
    });
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate() {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// Usage:
const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
  return new MyComponent(tui, ["Option A", "Option B", "Option C"], done);
});
```

---
