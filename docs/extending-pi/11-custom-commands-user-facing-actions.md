# Custom Commands — User-Facing Actions


Commands let users invoke your extension directly via `/mycommand`.

```typescript
pi.registerCommand("deploy", {
  description: "Deploy to an environment",
  
  // Optional: argument auto-completion
  getArgumentCompletions: (prefix: string) => {
    const envs = ["dev", "staging", "prod"];
    return envs
      .filter(e => e.startsWith(prefix))
      .map(e => ({ value: e, label: e }));
  },
  
  handler: async (args, ctx) => {
    // args = everything after "/deploy "
    // ctx = ExtensionCommandContext (has extra session control methods)
    
    await ctx.waitForIdle();  // Wait for agent to finish
    ctx.ui.notify(`Deploying to ${args}`, "info");
  },
});
```

### Command Context Extras

Command handlers get `ExtensionCommandContext` which extends `ExtensionContext` with:

- `ctx.waitForIdle()` — Wait for agent to finish
- `ctx.newSession(options?)` — Create a new session
- `ctx.fork(entryId)` — Fork from an entry
- `ctx.navigateTree(targetId, options?)` — Navigate the session tree
- `ctx.reload()` — Hot-reload everything

> **Important:** These methods are only available in commands, not in event handlers, because they would deadlock there.

---
