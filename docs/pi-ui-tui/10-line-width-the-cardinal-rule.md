# Line Width — The Cardinal Rule

**Every line from `render()` MUST NOT exceed the `width` parameter in visible characters.** This is the single most common source of rendering bugs.

### Utilities

```typescript
import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

// Get display width (ignores ANSI escape codes)
visibleWidth("\x1b[32mHello\x1b[0m");  // Returns 5, not 14

// Truncate to fit width (preserves ANSI codes)
truncateToWidth("Very long text here", 10);        // "Very lo..."
truncateToWidth("Very long text here", 10, "");     // "Very long " (no ellipsis)
truncateToWidth("Very long text here", 10, "→");    // "Very long→"

// Word wrap preserving ANSI codes
wrapTextWithAnsi("\x1b[32mThis is a long green text\x1b[0m", 15);
// Returns ["This is a long", "green text"] with ANSI codes preserved per line
```

### The Pattern

```typescript
render(width: number): string[] {
  const lines: string[] = [];

  // Always truncate any line that could exceed width
  lines.push(truncateToWidth(`  ${prefix}${content}`, width));

  // For dynamic content, calculate available space
  const labelWidth = visibleWidth(label);
  const available = width - labelWidth - 4;  // Leave room for padding
  const truncated = truncateToWidth(value, available);
  lines.push(`  ${label}: ${truncated}`);

  return lines;
}
```

### Why This Matters

If a line exceeds `width`, the terminal wraps it, causing visual corruption — lines overlap, the cursor mispositions, and the entire TUI can become garbled. The TUI framework **cannot fix this for you** because it doesn't know how you want lines truncated.

---
