# Architecture & Mental Model


```
┌─────────────────────────────────────────────────────┐
│                    Pi Runtime                        │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │  Session  │  │  Agent   │  │   Tool Executor  │  │
│  │  Manager  │  │  Loop    │  │                  │  │
│  └────┬─────┘  └────┬─────┘  └────────┬─────────┘  │
│       │              │                 │             │
│       └──────────────┼─────────────────┘             │
│                      │                               │
│              ┌───────▼────────┐                      │
│              │  Event System  │ ◄── All events flow  │
│              └───────┬────────┘     through here     │
│                      │                               │
│         ┌────────────┼────────────┐                  │
│         ▼            ▼            ▼                  │
│    Extension A  Extension B  Extension C             │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**Key concepts:**

- **Extensions are loaded once** when pi starts (or on `/reload`). Your default export function runs, and you subscribe to events and register tools/commands during that function call.
- **Events are the communication mechanism.** Pi emits events at every stage of its lifecycle. Your extension listens and reacts.
- **Tools are the LLM's interface to your extension.** The LLM sees tool descriptions in its system prompt and calls them when appropriate.
- **Commands are the user's interface.** Users type `/mycommand` to invoke your extension directly.
- **State lives in tool result `details`** for proper branching/forking support, or in `pi.appendEntry()` for extension-private state.

---
