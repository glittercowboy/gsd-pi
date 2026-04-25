# State Management & Persistence


### Pattern: State in Tool Result Details

The recommended approach for stateful tools. State lives in `details` so it works correctly with branching/forking.

```typescript
export default function (pi: ExtensionAPI) {
  let items: string[] = [];

  // Reconstruct from session on load
  pi.on("session_start", async (_event, ctx) => {
    items = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        if (entry.message.toolName === "my_tool") {
          items = entry.message.details?.items ?? [];
        }
      }
    }
  });

  pi.registerTool({
    name: "my_tool",
    // ...
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      items.push(params.text);
      return {
        content: [{ type: "text", text: "Added" }],
        details: { items: [...items] },  // ← Snapshot state here
      };
    },
  });
}
```

### Pattern: Extension-Private State (appendEntry)

For state that doesn't participate in LLM context but needs to survive restarts:

```typescript
pi.appendEntry("my-state", { count: 42, lastRun: Date.now() });

// Restore on reload
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "my-state") {
      const data = entry.data;  // { count: 42, lastRun: ... }
    }
  }
});
```

### Pattern: Complete State Reconstruction

The `session_start` hook alone is not sufficient for full state consistency. Extensions must also handle `session_switch` and `session_tree` to reconstruct state whenever the active conversation changes:

- **`session_start`** — Initial load or reload (app startup, extension reload)
- **`session_switch`** — User switches between sessions (different conversations)
- **`session_tree`** — User navigates to a different conversation branch

Without all three hooks, in-memory state can become stale or inconsistent when the user changes context.

```typescript
// Complete state reconstruction — handles all session lifecycle events
function reconstructState(ctx: ExtensionContext): string[] {
  const items: string[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "toolResult") {
      if (entry.message.toolName === "my_tool") {
        items.length = 0;
        items.push(...(entry.message.details?.items ?? []));
      }
    }
  }
  return items;
}

export default function (pi: ExtensionAPI) {
  let items: string[] = [];

  const rebuild = async (_event: unknown, ctx: ExtensionContext) => {
    items = reconstructState(ctx);
  };

  pi.on("session_start", rebuild);
  pi.on("session_switch", rebuild);  // User switched to a different session
  pi.on("session_tree", rebuild);    // User navigated to a different branch
}
```

---
