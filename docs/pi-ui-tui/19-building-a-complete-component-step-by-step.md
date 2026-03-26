# Building a Complete Component — Step by Step

Let's build a real component: an interactive todo list displayed via a command.

```typescript
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";

interface TodoItem {
  text: string;
  done: boolean;
}

class TodoListUI {
  private items: TodoItem[];
  private selected = 0;
  private theme: Theme;
  private done: (items: TodoItem[]) => void;
  private tui: { requestRender: () => void };
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    tui: { requestRender: () => void },
    theme: Theme,
    items: TodoItem[],
    done: (items: TodoItem[]) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.items = [...items];  // Clone to avoid mutation
    this.done = done;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up) && this.selected > 0) {
      this.selected--;
    } else if (matchesKey(data, Key.down) && this.selected < this.items.length - 1) {
      this.selected++;
    } else if (matchesKey(data, Key.space)) {
      // Toggle current item
      this.items[this.selected].done = !this.items[this.selected].done;
    } else if (matchesKey(data, Key.enter)) {
      this.done(this.items);
      return;
    } else if (matchesKey(data, Key.escape)) {
      this.done(this.items);
      return;
    } else {
      return;  // Don't invalidate for unhandled keys
    }

    this.invalidate();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const th = this.theme;
    const lines: string[] = [];

    // Border
    lines.push(truncateToWidth(th.fg("accent", "─".repeat(width)), width));

    // Title
    const done = this.items.filter(i => i.done).length;
    lines.push(truncateToWidth(
      ` ${th.fg("accent", th.bold("Todos"))} ${th.fg("muted", `${done}/${this.items.length}`)}`,
      width
    ));
    lines.push("");

    // Items
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      const isSelected = i === this.selected;
      const prefix = isSelected ? th.fg("accent", "> ") : "  ";
      const check = item.done ? th.fg("success", "✓ ") : th.fg("dim", "○ ");
      const text = item.done
        ? th.fg("muted", th.strikethrough(item.text))
        : th.fg("text", item.text);

      lines.push(truncateToWidth(`${prefix}${check}${text}`, width));
    }

    if (this.items.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg("dim", "No items")}`, width));
    }

    // Help
    lines.push("");
    lines.push(truncateToWidth(
      ` ${th.fg("dim", "↑↓ navigate • Space toggle • Enter/Esc close")}`,
      width
    ));
    lines.push(truncateToWidth(th.fg("accent", "─".repeat(width)), width));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// Usage in an extension:
export default function (pi: ExtensionAPI) {
  let items: TodoItem[] = [
    { text: "First task", done: false },
    { text: "Second task", done: true },
    { text: "Third task", done: false },
  ];

  pi.registerCommand("todos", {
    description: "Interactive todo list",
    handler: async (_args, ctx) => {
      const result = await ctx.ui.custom<TodoItem[]>((tui, theme, _kb, done) => {
        return new TodoListUI(tui, theme, items, done);
      });
      items = result;  // Save updated state
    },
  });
}
```

---
