# Key Rules & Gotchas


### Must-Follow Rules

1. **Use `StringEnum` for string enums** — `Type.Union`/`Type.Literal` breaks Google's API.
2. **Truncate tool output** — Large output causes context overflow, compaction failures, degraded performance.
3. **Use theme from callback** — Don't import theme directly. Use the `theme` parameter from `ctx.ui.custom()` or render functions.
4. **Type the DynamicBorder color param** — Write `(s: string) => theme.fg("accent", s)`.
5. **Call `tui.requestRender()` after state changes** in `handleInput`.
6. **Return `{ render, invalidate, handleInput }`** from custom components.
7. **Lines must not exceed `width`** in `render()` — use `truncateToWidth()`.
8. **Session control methods only in commands** — `waitForIdle()`, `newSession()`, `fork()`, `navigateTree()`, `reload()` will deadlock in event handlers.
9. **Strip leading `@` from path arguments** in custom tools — some models add it.
10. **Store state in tool result `details`** for proper branching support.

### Common Patterns

- **Rebuild on `invalidate()`** when your component pre-bakes theme colors
- **Check `signal?.aborted`** in long-running tool executions
- **Use `pi.exec()` instead of `child_process`** for shell commands
- **Overlay components are disposed when closed** — create fresh instances each time
- **Treat `ctx.reload()` as terminal** — code after it runs from the pre-reload version

---
