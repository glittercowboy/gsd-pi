# Performance — Caching and Invalidation

### The Caching Pattern

Always cache `render()` output and recompute only when state changes:

```typescript
class CachedComponent {
  private cachedWidth?: number;
  private cachedLines?: string[];

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    // Expensive computation here
    const lines = this.computeLines(width);

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
```

### The Update Cycle

```
State changes → invalidate() → tui.requestRender() → render(width) called
```

1. Something changes your component's state (user input, timer, async result)
2. Call `this.invalidate()` to clear caches
3. Call `tui.requestRender()` to schedule a re-render
4. The TUI calls `render(width)` on the next frame
5. Your component recomputes its output (since cache was cleared)

### Game Loop Pattern (Real-Time Updates)

```typescript
class GameComponent {
  private interval: ReturnType<typeof setInterval> | null = null;
  private version = 0;
  private cachedVersion = -1;

  constructor(private tui: { requestRender: () => void }) {
    this.interval = setInterval(() => {
      this.tick();
      this.version++;
      this.tui.requestRender();
    }, 100);  // 10 FPS
  }

  render(width: number): string[] {
    if (this.cachedVersion === this.version && /* width unchanged */) {
      return this.cachedLines;
    }
    // ... render ...
    this.cachedVersion = this.version;
    return lines;
  }

  dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
```

---
