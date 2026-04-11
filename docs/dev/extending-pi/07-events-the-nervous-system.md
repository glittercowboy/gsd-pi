# Events — The Nervous System


Events are the core of the extension system. They fall into five categories:

### 7.1 Session Events

| Event | When | Can Return |
|-------|------|------------|
| `session_start` | Session loads | — |
| `session_before_switch` | Before `/new` or `/resume` | `{ cancel: true }` |
| `session_switch` | After session switch | — |
| `session_before_fork` | Before `/fork` | `{ cancel: true }` or `{ skipConversationRestore: true }` |
| `session_fork` | After fork | — |
| `session_before_compact` | Before compaction | `{ cancel: true }` or `{ compaction: {...} }` (custom summary) |
| `session_compact` | After compaction | — |
| `session_before_tree` | Before `/tree` navigation | `{ cancel: true }` or `{ summary: {...} }` |
| `session_tree` | After tree navigation | — |
| `session_shutdown` | On exit (Ctrl+C, Ctrl+D, SIGTERM) | — |

### 7.2 Agent Events

| Event | When | Can Return |
|-------|------|------------|
| `before_agent_start` | After user prompt, before agent loop | `{ message: {...}, systemPrompt: "..." }` |
| `agent_start` | Agent loop begins | — |
| `agent_end` | Agent loop ends | — |
| `turn_start` | Each LLM turn begins | — |
| `turn_end` | Each LLM turn ends | — |
| `context` | Before each LLM call | `{ messages: [...] }` (modified copy) |
| `message_start/update/end` | Message lifecycle | — |

### 7.3 Tool Events

| Event | When | Can Return |
|-------|------|------------|
| `tool_call` | Before tool executes | `{ block: true, reason: "..." }` |
| `tool_execution_start` | Tool begins executing | — |
| `tool_execution_update` | Tool sends progress | — |
| `tool_execution_end` | Tool finishes | — |
| `tool_result` | After tool executes | `{ content: [...], details: {...}, isError: bool }` (modify result) |

### 7.4 Input Events

| Event | When | Can Return |
|-------|------|------------|
| `input` | User input received (before skill/template expansion) | `{ action: "transform", text: "..." }` or `{ action: "handled" }` or `{ action: "continue" }` |

### 7.5 Model Events

| Event | When | Can Return |
|-------|------|------------|
| `model_select` | Model changes (`/model`, Ctrl+P, restore) | — |

### 7.6 User Bash Events

| Event | When | Can Return |
|-------|------|------------|
| `user_bash` | User runs `!` or `!!` commands | `{ operations: ... }` or `{ result: {...} }` |

### Event Handler Signature

```typescript
pi.on("event_name", async (event, ctx: ExtensionContext) => {
  // event — typed payload for this event
  // ctx — access to UI, session, model, and control flow
  
  // Return undefined for no action, or a typed response object
});
```

### Type Narrowing for Tool Events

```typescript
import { isToolCallEventType, isToolResultEventType } from "@mariozechner/pi-coding-agent";

pi.on("tool_call", async (event, ctx) => {
  if (isToolCallEventType("bash", event)) {
    // event.input is typed as { command: string; timeout?: number }
  }
  if (isToolCallEventType("write", event)) {
    // event.input is typed as { path: string; content: string }
  }
});

pi.on("tool_result", async (event, ctx) => {
  if (isToolResultEventType("bash", event)) {
    // event.details is typed as BashToolDetails
  }
});
```

---
