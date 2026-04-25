<required_reading>
1. references/key-rules-gotchas.md
2. references/extension-lifecycle.md
</required_reading>

<process>

## Step 1: Identify the Symptom

| Symptom | Likely Cause |
|---------|--------------|
| Extension not loading | File not in discovery path, syntax error, missing export default |
| Tool not appearing for LLM | Tool not registered, `pi.setActiveTools()` excluding it, tool name conflict |
| Command not responding | Command not registered, name collision with built-in |
| Event not firing | Wrong event name, handler returning too early, handler error (logged but swallowed) |
| UI not rendering | `ctx.hasUI` is false (print mode), render lines exceed width, component not returning lines |
| State lost on restart | State not stored in `details` or `appendEntry`, not reconstructing on `session_start` |
| Google API errors | Using `Type.Union`/`Type.Literal` instead of `StringEnum` |
| Context overflow | Tool output not truncated |
| Deadlock/hang | Session control methods called from event handler (must be in command handler only) |
| Render garbage | Theme imported directly instead of from callback, missing `truncateToWidth()` |

## Step 2: Check Extension Loading

```bash
# Test in isolation
gsd -e ./path/to/extension.ts

# Check GSD startup output for errors
# Extension errors are logged but don't crash GSD
```

## Step 3: Verify File Location

Community extensions must be in auto-discovery paths:
- `~/.pi/agent/extensions/*.ts`
- `~/.pi/agent/extensions/*/index.ts`
- `.gsd/extensions/*.ts`
- `.gsd/extensions/*/index.ts`

Note: `~/.gsd/agent/extensions/` is reserved for bundled extensions synced from the gsd-pi package.

The file must `export default function(pi: ExtensionAPI) { ... }`.

## Step 4: Check for Common Mistakes

Read `../references/key-rules-gotchas.md` and verify each rule against the extension code.

## Step 5: Add Debugging

```typescript
// Temporary: log to stderr (visible in GSD output)
console.error("[my-ext] Loading...");

pi.on("session_start", async (_event, ctx) => {
  console.error("[my-ext] Session started");
  ctx.ui.notify("Extension loaded", "info");
});
```

## Step 6: Fix and Reload

Apply the fix and test:
```
/reload
```

</process>

<success_criteria>
Debugging is complete when:
- [ ] Root cause identified
- [ ] Fix applied
- [ ] Extension loads and functions correctly after `/reload`
- [ ] No regression in existing functionality
</success_criteria>
