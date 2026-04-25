# Mode Behavior


| Mode | UI Methods | Notes |
|------|-----------|-------|
| **Interactive** (default) | Full TUI | Normal operation |
| **RPC** (`--mode rpc`) | JSON protocol | Host handles UI, dialogs work via sub-protocol |
| **JSON** (`--mode json`) | No-op | Event stream to stdout |
| **Print** (`-p`) | No-op | Extensions run but can't prompt users |

**Always check `ctx.hasUI`** before calling dialog methods in extensions that might run in non-interactive modes:

```typescript
if (ctx.hasUI) {
  const ok = await ctx.ui.confirm("Delete?", "Sure?");
} else {
  // Default behavior for non-interactive mode
}
```

---
