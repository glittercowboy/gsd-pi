# Tool Rendering — Custom Tool Display

Tools can control how their calls and results appear in the message area.

### renderCall — How the Tool Call Looks

```typescript
import { Text } from "@mariozechner/pi-tui";

pi.registerTool({
  name: "my_tool",
  // ...

  renderCall(args, theme) {
    // args = the tool call arguments
    let text = theme.fg("toolTitle", theme.bold("my_tool "));
    text += theme.fg("muted", args.action);
    if (args.text) text += " " + theme.fg("dim", `"${args.text}"`);
    return new Text(text, 0, 0);  // 0,0 padding — the wrapping Box handles padding
  },
});
```

### renderResult — How the Tool Result Looks

```typescript
import { Text } from "@mariozechner/pi-tui";
import { keyHint } from "@mariozechner/pi-coding-agent";

pi.registerTool({
  name: "my_tool",
  // ...

  renderResult(result, { expanded, isPartial }, theme) {
    // result.content — the content array sent to the LLM
    // result.details — your custom details object
    // expanded — whether user toggled expand (Ctrl+O)
    // isPartial — streaming in progress (onUpdate was called)

    // Handle streaming state
    if (isPartial) {
      return new Text(theme.fg("warning", "Processing..."), 0, 0);
    }

    // Handle errors
    if (result.details?.error) {
      return new Text(theme.fg("error", `Error: ${result.details.error}`), 0, 0);
    }

    // Default view (collapsed)
    let text = theme.fg("success", "✓ Done");
    if (!expanded) {
      text += ` (${keyHint("expandTools", "to expand")})`;
    }

    // Expanded view — show details
    if (expanded && result.details?.items) {
      for (const item of result.details.items) {
        text += "\n  " + theme.fg("dim", item);
      }
    }

    return new Text(text, 0, 0);
  },
});
```

### Key Hints for Keybindings

```typescript
import { keyHint, appKeyHint, editorKey, rawKeyHint } from "@mariozechner/pi-coding-agent";

// Editor action hint (respects user's keybinding config)
keyHint("expandTools", "to expand")    // e.g., "Ctrl+O to expand"
keyHint("selectConfirm", "to select")  // e.g., "Enter to select"

// Raw key hint
rawKeyHint("Ctrl+O", "to expand")      // Always shows "Ctrl+O to expand"
```

### Fallback Behavior

If `renderCall` or `renderResult` is not defined or throws:
- `renderCall` → shows tool name
- `renderResult` → shows raw text from `content`

### Best Practices

- Return `Text` with padding `(0, 0)` — the wrapping `Box` handles padding
- Support `expanded` for detail on demand
- Handle `isPartial` for streaming progress
- Keep the default (collapsed) view compact
- Use `\n` for multi-line content within a single `Text`

---
