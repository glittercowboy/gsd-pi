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
| `stop` | Agent has truly stopped (no follow-up, no steering) | — |
| `notification` | Agent needs user attention (blocked, input_needed, milestone_ready, idle, error) | — |
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

### 7.7 Git Lifecycle Events

| Event | When | Can Return |
|-------|------|------------|
| `before_commit` | Before a commit is created | `{ cancel: true, reason: "..." }` or `{ message: "..." }` (rewrite) |
| `commit` | After a commit lands | — |
| `before_push` | Before a git push | `{ cancel: true, reason: "..." }` |
| `push` | After a push | — |
| `before_pr` | Before a PR is opened | `{ cancel: true, reason: "..." }` or `{ title, body }` (rewrite) |
| `pr_opened` | After a PR is opened | — |

### 7.8 Verification Events

| Event | When | Can Return |
|-------|------|------------|
| `before_verify` | Before verification runs | `{ cancel: true, reason: "..." }` |
| `verify_result` | After verification completes | — (payload includes `failures[]`) |

### 7.9 Budget Events

| Event | When | Can Return |
|-------|------|------------|
| `budget_threshold` | Cost crossed a fraction of the budget | `{ action: "pause" \| "downgrade" \| "continue" }` |

### 7.10 Orchestrator Events

| Event | When | Can Return |
|-------|------|------------|
| `milestone_start` | Autonomous milestone starts | — |
| `milestone_end` | Autonomous milestone ends | — |
| `unit_start` | Sub-task (unit) within a milestone starts | — |
| `unit_end` | Unit ends (completed / failed / cancelled / blocked) | — |
| `session_end` | In-process session ends (distinct from `session_shutdown`) | — |

### Emitting events from an extension

Extensions can emit any of the post-plan events above via the
`emitExtensionEvent` method on `ExtensionAPI`:

```typescript
await pi.emitExtensionEvent({
  type: "before_commit",
  message: "feat: add thing",
  files: ["src/thing.ts"],
  cwd: process.cwd(),
});
// Returns { cancel: true, reason } | { message: "..." } | undefined
```

The GSD extension provides typed wrapper helpers in
`src/resources/extensions/gsd/hook-emitter.ts` (`emitBeforeCommit`,
`emitVerifyResult`, `emitBudgetThreshold`, etc.) for call sites that don't
have direct access to the `pi` API.

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
