<overview>
Non-negotiable rules and common gotchas when building GSD extensions.
</overview>

<must_follow>
1. **Use `StringEnum` for string enums** — `Type.Union`/`Type.Literal` breaks Google's API.
2. **Truncate tool output** — Large output causes context overflow, compaction failures, degraded performance. Limit: 50KB / 2000 lines.
3. **Use theme from callback** — Don't import theme directly. Use the `theme` parameter from `ctx.ui.custom()` or render functions.
4. **`DynamicBorder` color param** — Type as `(s: string) => theme.fg("accent", s)`.
5. **Call `tui.requestRender()` after state changes** in `handleInput`.
6. **Return `{ render, invalidate, handleInput }`** from custom components.
7. **Lines must not exceed `width`** in `render()` — use `truncateToWidth()`.
8. **Session control methods ONLY in commands** — `waitForIdle()`, `newSession()`, `fork()`, `navigateTree()`, `reload()` will **deadlock** in event handlers.
9. **Strip leading `@` from path arguments** — some models add it.
10. **Store state in tool result `details`** for proper branching support.
</must_follow>

<common_patterns>
- Rebuild component on `invalidate()` when pre-baking theme colors
- Check `signal?.aborted` in long-running tool executions
- Use `pi.exec()` instead of `child_process` for shell commands
- Overlay components are **disposed when closed** — create fresh instances each time
- Treat `ctx.reload()` as terminal — code after runs from pre-reload version
- Check `ctx.hasUI` before dialog methods (false in print/JSON mode)
- Extension errors are logged but don't crash GSD — tool_call handler errors fail-safe (block the tool)
</common_patterns>

<gsd_paths>
**GSD extension paths (community/user-installed extensions):**
- Global: `~/.pi/agent/extensions/*.ts`
- Global (subdir): `~/.pi/agent/extensions/*/index.ts`
- Project-local: `.gsd/extensions/*.ts`
- Project-local (subdir): `.gsd/extensions/*/index.ts`

Note: `~/.gsd/agent/extensions/` is reserved for bundled extensions synced from the gsd-pi package.
Community extensions placed there are silently ignored by the loader.
</gsd_paths>
