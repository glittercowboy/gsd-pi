# Custom Rendering — Controlling What the User Sees


### Tool Rendering

Tools can provide `renderCall` (how the tool call looks) and `renderResult` (how the result looks):

```typescript
import { Text } from "@mariozechner/pi-tui";
import { keyHint } from "@mariozechner/pi-coding-agent";

pi.registerTool({
  name: "my_tool",
  // ...
  
  renderCall(args, theme) {
    let text = theme.fg("toolTitle", theme.bold("my_tool "));
    text += theme.fg("muted", args.action);
    return new Text(text, 0, 0);  // 0,0 padding — Box handles it
  },

  renderResult(result, { expanded, isPartial }, theme) {
    if (isPartial) {
      return new Text(theme.fg("warning", "Processing..."), 0, 0);
    }
    
    let text = theme.fg("success", "✓ Done");
    if (!expanded) {
      text += ` (${keyHint("expandTools", "to expand")})`;
    }
    if (expanded && result.details?.items) {
      for (const item of result.details.items) {
        text += "\n  " + theme.fg("dim", item);
      }
    }
    return new Text(text, 0, 0);
  },
});
```

### Message Rendering

Register a renderer for custom message types:

```typescript
import { Text } from "@mariozechner/pi-tui";

pi.registerMessageRenderer("my-extension", (message, options, theme) => {
  const { expanded } = options;
  let text = theme.fg("accent", `[${message.customType}] `) + message.content;
  if (expanded && message.details) {
    text += "\n" + theme.fg("dim", JSON.stringify(message.details, null, 2));
  }
  return new Text(text, 0, 0);
});

// Send messages that use this renderer:
pi.sendMessage({
  customType: "my-extension",  // Matches the renderer
  content: "Status update",
  display: true,
  details: { foo: "bar" },
});
```

### Theme Colors Reference

```typescript
// Foreground: theme.fg(color, text)
"text" | "accent" | "muted" | "dim"           // General
"success" | "error" | "warning"                 // Status
"border" | "borderAccent" | "borderMuted"       // Borders
"toolTitle" | "toolOutput"                      // Tools
"toolDiffAdded" | "toolDiffRemoved"             // Diffs
"mdHeading" | "mdLink" | "mdCode"              // Markdown
"syntaxKeyword" | "syntaxFunction" | "syntaxString"  // Syntax

// Background: theme.bg(color, text)
"selectedBg" | "userMessageBg" | "customMessageBg"
"toolPendingBg" | "toolSuccessBg" | "toolErrorBg"

// Text styles
theme.bold(text)
theme.italic(text)
theme.strikethrough(text)
```

### Syntax Highlighting in Renderers

```typescript
import { highlightCode, getLanguageFromPath } from "@mariozechner/pi-coding-agent";

const lang = getLanguageFromPath("/path/to/file.rs");  // "rust"
const highlighted = highlightCode(code, lang, theme);
```

---
