# Theme Changes and Invalidation

When the user switches themes, the TUI calls `invalidate()` on all components. If your component pre-bakes theme colors, you must rebuild them.

### ❌ Wrong — Theme Colors Won't Update

```typescript
class BadComponent extends Container {
  constructor(message: string, theme: Theme) {
    super();
    // Pre-baked theme colors — stuck with old theme forever!
    this.addChild(new Text(theme.fg("accent", message), 1, 0));
  }
}
```

### ✅ Correct — Rebuild on Invalidate

```typescript
class GoodComponent extends Container {
  private message: string;
  private theme: Theme;

  constructor(message: string, theme: Theme) {
    super();
    this.message = message;
    this.theme = theme;
    this.rebuild();
  }

  private rebuild(): void {
    this.clear();  // Remove all children
    this.addChild(new Text(this.theme.fg("accent", this.message), 1, 0));
  }

  override invalidate(): void {
    super.invalidate();
    this.rebuild();  // Rebuild with current theme
  }
}
```

### When You Need This Pattern

**NEED to rebuild:** Pre-baked `theme.fg()`/`theme.bg()` strings, `highlightCode()` results, complex child trees with embedded colors.

**DON'T need to rebuild:** Theme callbacks `(text) => theme.fg("accent", text)`, stateless renders that compute fresh each time, simple containers without themed content.

---
