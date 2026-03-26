# Inter-Extension Communication

How extensions communicate with each other, share state, and coordinate behavior.

---

## pi.events — The Shared Event Bus

Every extension receives the same `pi.events` instance. It's a simple typed pub/sub bus.

### API

```typescript
// Emit an event on a channel
pi.events.emit("my-channel", { action: "started", id: 123 });

// Subscribe to a channel — returns an unsubscribe function
const unsub = pi.events.on("my-channel", (data) => {
  // data is typed as `unknown` — you must cast
  const payload = data as { action: string; id: number };
  console.log(payload.action); // "started"
});

// Later: stop listening
unsub();
```

### Characteristics

| Property | Behavior |
|---|---|
| **Typing** | `data` is `unknown`. No generics. Cast at the consumer. |
| **Error handling** | Handlers are wrapped in async try/catch. Errors log to `console.error` but don't propagate to emitter or crash the session. |
| **Ordering** | Handlers fire in subscription order (order of `pi.events.on` calls). |
| **Persistence** | No replay, no persistence. If you emit before anyone subscribes, the event is lost. |
| **Scope** | Shared across ALL extensions in the session. The bus is created once and passed to every extension's `createExtensionAPI`. |
| **Lifecycle** | The bus is cleared on extension reload (`/reload`). Subscriptions from the old extension instances are gone. |

### Example: Extension A Signals Extension B

```typescript
// Extension A: plan-mode.ts
export default function (pi: ExtensionAPI) {
  pi.registerCommand("plan", {
    handler: async (_args, ctx) => {
      planEnabled = !planEnabled;
      pi.events.emit("mode-change", { mode: planEnabled ? "plan" : "normal" });
    },
  });
}

// Extension B: status-display.ts
export default function (pi: ExtensionAPI) {
  pi.events.on("mode-change", (data) => {
    const { mode } = data as { mode: string };
    // React to mode change
  });
}
```

### Limitations

- **No request/response** — emit is fire-and-forget. If you need a response, use shared state or a callback pattern.
- **No guaranteed delivery** — if the subscriber hasn't loaded yet (load order matters), the event is missed.
- **No channel namespacing** — use descriptive channel names to avoid collisions (e.g., `"myext:event"` rather than `"update"`).

---

## Shared State Patterns

### Pattern 1: Shared Module State

If two extensions are loaded from the same package (via `package.json` `pi.extensions` array), they can share state through module-level variables in a shared file.

```
my-extension/
├── package.json    # pi.extensions: ["./a.ts", "./b.ts"]
├── a.ts            # import { state } from "./shared.ts"
├── b.ts            # import { state } from "./shared.ts"
└── shared.ts       # export const state = { count: 0 }
```

**Caveat:** jiti module caching means the shared module is loaded once. But on `/reload`, everything is re-imported from scratch — shared state resets.

### Pattern 2: Event Bus as State Channel

Use `pi.events` to broadcast state changes. Each extension maintains its own copy.

```typescript
// Extension A: authoritative state owner
let items: string[] = [];

function addItem(item: string) {
  items.push(item);
  pi.events.emit("items:updated", { items: [...items] });
}

// Extension B: state consumer
let mirroredItems: string[] = [];

pi.events.on("items:updated", (data) => {
  mirroredItems = (data as { items: string[] }).items;
});
```

### Pattern 3: Session Entries as Coordination Points

Extensions can read each other's `appendEntry` data from the session:

```typescript
// Extension A writes:
pi.appendEntry("ext-a-config", { theme: "dark", verbose: true });

// Extension B reads during session_start:
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "ext-a-config") {
      const config = entry.data as { theme: string; verbose: boolean };
      // Use config from Extension A
    }
  }
});
```

**Downside:** This only works after `session_start`. Not suitable for real-time coordination during a turn.

---

## Multi-Extension Coordination Patterns

### Pattern: Mode Manager

One extension acts as the mode authority, others react:

```typescript
// mode-manager.ts — the authority
export default function (pi: ExtensionAPI) {
  let currentMode: "plan" | "execute" | "review" = "execute";
  
  pi.registerCommand("mode", {
    handler: async (args, ctx) => {
      const newMode = args.trim() as typeof currentMode;
      if (!["plan", "execute", "review"].includes(newMode)) {
        ctx.ui.notify(`Invalid mode: ${newMode}`, "error");
        return;
      }
      currentMode = newMode;
      pi.events.emit("mode:changed", { mode: currentMode });
      ctx.ui.notify(`Mode: ${currentMode}`);
    },
  });
  
  // Other extensions can query current mode via event
  pi.events.on("mode:query", () => {
    pi.events.emit("mode:current", { mode: currentMode });
  });
}

// tool-guard.ts — reacts to mode changes
export default function (pi: ExtensionAPI) {
  let currentMode = "execute";
  
  pi.events.on("mode:changed", (data) => {
    currentMode = (data as { mode: string }).mode;
  });
  
  pi.on("tool_call", async (event) => {
    if (currentMode === "plan" && ["edit", "write"].includes(event.toolName)) {
      return { block: true, reason: "Plan mode: write operations disabled" };
    }
    if (currentMode === "review" && event.toolName === "bash") {
      return { block: true, reason: "Review mode: bash disabled" };
    }
  });
}
```

### Pattern: Extension Priority Chain

When multiple extensions handle the same hook, load order determines priority. Project-local extensions load before global ones. Within a directory, files are discovered in filesystem order.

If you need explicit priority control:

```typescript
// priority-extension.ts
export default function (pi: ExtensionAPI) {
  // Register with a known channel so other extensions can defer
  pi.events.emit("priority:registered", { name: "security-guard" });
  
  pi.on("tool_call", async (event) => {
    // This runs first if loaded first
    if (isUnsafe(event)) {
      return { block: true, reason: "Security policy violation" };
    }
  });
}
```

---

## The ExtensionContext in Tools

Tools registered by extensions receive `ExtensionContext` as their 5th `execute` parameter. This is the same context event handlers get:

```typescript
pi.registerTool({
  name: "my_tool",
  // ...
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // ctx.ui — dialog methods, notifications, widgets
    // ctx.sessionManager — read session state
    // ctx.model — current model
    // ctx.cwd — working directory
    // ctx.hasUI — false in print/json mode
    // ctx.isIdle() — agent state
    // ctx.abort() — abort current operation
    // ctx.getContextUsage() — token usage
    // ctx.compact() — trigger compaction
    // ctx.getSystemPrompt() — current system prompt
    
    if (ctx.hasUI) {
      const confirmed = await ctx.ui.confirm("Proceed?", "This will modify files");
      if (!confirmed) {
        return { content: [{ type: "text", text: "Cancelled by user" }] };
      }
    }
    
    // ... do work
  },
});
```

**Important:** The `ctx` is freshly created via `runner.createContext()` for each tool execution. It reflects the current state at call time (current model, current session, etc.), not the state when the tool was registered.
