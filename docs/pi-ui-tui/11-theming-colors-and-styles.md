# Theming — Colors and Styles

### Using Theme Colors

The `theme` object is always passed via callbacks — never import it directly.

```typescript
// Foreground color
theme.fg("accent", "Highlighted text")     // Apply foreground color
theme.fg("success", "✓ Passed")
theme.fg("error", "✗ Failed")
theme.fg("warning", "⚠ Warning")
theme.fg("muted", "Secondary text")
theme.fg("dim", "Tertiary text")

// Background color
theme.bg("selectedBg", "Selected item")
theme.bg("toolSuccessBg", "Success background")

// Text styles
theme.bold("Bold text")
theme.italic("Italic text")
theme.strikethrough("Struck through")

// Combination
theme.fg("accent", theme.bold("Bold and colored"))
theme.bg("selectedBg", theme.fg("text", " Selected "))
```

### All Foreground Colors

| Category | Colors |
|----------|--------|
| **General** | `text`, `accent`, `muted`, `dim` |
| **Status** | `success`, `error`, `warning` |
| **Borders** | `border`, `borderAccent`, `borderMuted` |
| **Messages** | `userMessageText`, `customMessageText`, `customMessageLabel` |
| **Tools** | `toolTitle`, `toolOutput` |
| **Diffs** | `toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext` |
| **Markdown** | `mdHeading`, `mdLink`, `mdLinkUrl`, `mdCode`, `mdCodeBlock`, `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdHr`, `mdListBullet` |
| **Syntax** | `syntaxComment`, `syntaxKeyword`, `syntaxFunction`, `syntaxVariable`, `syntaxString`, `syntaxNumber`, `syntaxType`, `syntaxOperator`, `syntaxPunctuation` |
| **Thinking** | `thinkingOff`, `thinkingMinimal`, `thinkingLow`, `thinkingMedium`, `thinkingHigh`, `thinkingXhigh` |
| **Modes** | `bashMode` |

### All Background Colors

`selectedBg`, `userMessageBg`, `customMessageBg`, `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`

### Syntax Highlighting

```typescript
import { highlightCode, getLanguageFromPath } from "@mariozechner/pi-coding-agent";

// Highlight with explicit language
const highlighted = highlightCode("const x = 1;", "typescript", theme);

// Auto-detect from file path
const lang = getLanguageFromPath("/path/to/file.rs");  // "rust"
const highlighted = highlightCode(code, lang, theme);
```

### Markdown Theme

```typescript
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Markdown } from "@mariozechner/pi-tui";

const mdTheme = getMarkdownTheme();
const md = new Markdown(content, 1, 1, mdTheme);
```

---
