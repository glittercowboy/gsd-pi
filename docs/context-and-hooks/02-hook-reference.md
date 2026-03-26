# Hook Reference

Complete behavioral specification of every hook in pi's extension system. Covers timing, chaining semantics, return shapes, and edge cases not in the extending-pi docs.

---

## Hook Categories

1. **Input hooks** — intercept user input before the agent
2. **Agent lifecycle hooks** — control the agent loop boundary
3. **Per-turn hooks** — fire on every LLM call within an agent run
4. **Tool hooks** — intercept individual tool executions
5. **Session hooks** — respond to session lifecycle changes
6. **Model hooks** — respond to model changes
7. **Resource hooks** — provide dynamic resources at startup

---

## 1. Input Hooks

### `input`

**When:** User submits text (Enter in editor, RPC message, or `pi.sendUserMessage` from an extension with `source: "extension"`).

**Before:** Skill expansion, template expansion, command check (extension commands are checked before `input` fires, but built-in commands are checked after).

**Chaining:** Sequential through all extensions. Each handler sees the text output of the previous handler's `transform`. First `handled` stops the chain and the pipeline.

```typescript
pi.on("input", async (event, ctx) => {
  // event.text: string — current text (possibly transformed by earlier handler)
  // event.images: ImageContent[] | undefined
  // event.source: "interactive" | "rpc" | "extension"
  
  // Option 1: Pass through
  return { action: "continue" };
  // or return nothing (undefined) — same as continue
  
  // Option 2: Transform
  return { action: "transform", text: "rewritten", images: newImages };
  
  // Option 3: Swallow (no LLM call, no further handlers)
  return { action: "handled" };
});
```

**Edge cases:**
- Extension commands (`/mycommand`) are checked **before** `input` fires. If it matches, `input` never fires.
- Built-in commands (`/new`, `/model`, etc.) are checked **after** `input` transforms. So `input` can transform text into a built-in command, or transform a built-in command into something else.
- Images can be replaced via `transform`. Omitting `images` in the transform result preserves the original images.

---

## 2. Agent Lifecycle Hooks

### `before_agent_start`

**When:** After input processing, skill/template expansion, and the user message is constructed — but before `agent.prompt()` is called.

**Fires:** Once per user prompt. Does NOT fire on subsequent turns within the same agent run.

**Chaining:**
- **System prompt:** Chains. Extension A modifies `event.systemPrompt`, Extension B sees that modified version. If no extension returns a `systemPrompt`, the base prompt is used (resetting any previous turn's modifications).
- **Messages:** Accumulate. All `message` results are collected into an array. Each becomes a separate `CustomMessage` with `role: "custom"` injected after the user message.

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // event.prompt: string — expanded user prompt text
  // event.images: ImageContent[] | undefined
  // event.systemPrompt: string — current system prompt (may be chained from earlier extension)
  
  return {
    // Optional: inject a custom message into the session
    message: {
      customType: "my-extension",  // identifies the message type
      content: "Text the LLM sees", // string or (TextContent | ImageContent)[]
      display: true,                // controls UI rendering, NOT LLM visibility
      details: { any: "data" },     // for custom rendering and state reconstruction
    },
    
    // Optional: modify the system prompt for this agent run
    systemPrompt: event.systemPrompt + "\nNew instructions",
  };
});
```

**Critical detail:** The `display` field controls whether the message shows in the TUI chat log. The LLM **always** sees the message content regardless of `display`. All custom messages become `user` role messages in `convertToLlm`.

**Error handling:** If a handler throws, the error is captured and reported via `emitError`. Other handlers still run. The pipeline is not stopped.

### `agent_start`

**When:** The agent loop begins (after `before_agent_start`, after `agent.prompt()` is called).

**Fires:** Once per agent run. Informational only — no return value.

```typescript
pi.on("agent_start", async (event, ctx) => {
  // event: { type: "agent_start" }
  // Useful for: starting timers, resetting per-run state
});
```

### `agent_end`

**When:** The agent loop finishes (all turns complete, no more tool calls, no queued messages).

**Fires:** Once per agent run.

```typescript
pi.on("agent_end", async (event, ctx) => {
  // event.messages: AgentMessage[] — all messages produced during this run
  // Useful for: final summaries, state persistence, triggering follow-up actions
});
```

**Subtlety:** `event.messages` contains only the NEW messages from this agent run, not the full conversation history. Use `ctx.sessionManager.getBranch()` for the full history.

---

## 3. Per-Turn Hooks

### `turn_start`

**When:** Each turn within the agent loop begins (before the LLM call).

```typescript
pi.on("turn_start", async (event, ctx) => {
  // event.turnIndex: number — 0-based index of this turn within the agent run
  // event.timestamp: number — when the turn started
});
```

### `context`

**When:** Before each LLM call, after the turn starts. This is the last chance to modify what the LLM sees.

**Fires:** Every turn. If the LLM calls 3 tools and loops back, `context` fires 4 times (once for initial call + once per loop-back).

**Chaining:** Sequential. Each handler receives the output of the previous. First handler gets a `structuredClone` deep copy of the agent's message array.

```typescript
pi.on("context", async (event, ctx) => {
  // event.messages: AgentMessage[] — deep copy, safe to mutate
  
  // Filter out messages
  const filtered = event.messages.filter(m => !isIrrelevant(m));
  return { messages: filtered };
  
  // Or inject messages
  return { messages: [...event.messages, syntheticMessage] };
  
  // Or return nothing to pass through unchanged
});
```

**What `event.messages` contains:**
- All roles: `user`, `assistant`, `toolResult`, `custom`, `bashExecution`, `compactionSummary`, `branchSummary`
- The user message from the current prompt
- Custom messages injected by `before_agent_start`
- Tool results from earlier turns in this agent run
- Steering/follow-up messages that became turn inputs
- Historical messages from the session (including compaction summaries)

**What it does NOT contain:**
- The system prompt (use `before_agent_start` for that)
- Tool definitions (use `pi.setActiveTools()` for that)

### `turn_end`

**When:** After the LLM responds and all tool calls for this turn complete.

```typescript
pi.on("turn_end", async (event, ctx) => {
  // event.turnIndex: number
  // event.message: AgentMessage — the assistant's response message
  // event.toolResults: ToolResultMessage[] — results from tools called this turn
});
```

### `message_start` / `message_update` / `message_end`

**When:** Message lifecycle events. `update` only fires for assistant messages during streaming (token-by-token).

```typescript
pi.on("message_start", async (event, ctx) => {
  // event.message: AgentMessage — user, assistant, toolResult, or custom
});

pi.on("message_update", async (event, ctx) => {
  // event.message: AgentMessage — partial assistant message (streaming)
  // event.assistantMessageEvent: AssistantMessageEvent — the specific token event
});

pi.on("message_end", async (event, ctx) => {
  // event.message: AgentMessage — final message
  // Messages are persisted to the session file at this point
});
```

---

## 4. Tool Hooks

### `tool_call`

**When:** After the LLM requests a tool call, before it executes.

**Chaining:** Sequential. If any handler returns `{ block: true }`, execution stops immediately. The block reason becomes an Error that is caught and returned as the tool result with `isError: true`.

```typescript
pi.on("tool_call", async (event, ctx) => {
  // event.toolCallId: string
  // event.toolName: string
  // event.input: typed based on tool (use isToolCallEventType for narrowing)
  
  // Block execution
  return { block: true, reason: "Not allowed in read-only mode" };
  
  // Allow execution (return nothing or undefined)
});
```

**Type narrowing:**
```typescript
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

pi.on("tool_call", async (event, ctx) => {
  if (isToolCallEventType("bash", event)) {
    event.input.command; // string — typed!
  }
  if (isToolCallEventType("write", event)) {
    event.input.path;    // string
    event.input.content; // string
  }
  // Custom tools need explicit type params:
  if (isToolCallEventType<"my_tool", { action: string }>("my_tool", event)) {
    event.input.action;  // string
  }
});
```

### `tool_execution_start` / `tool_execution_update` / `tool_execution_end`

Informational events during tool execution. No return values.

```typescript
pi.on("tool_execution_start", async (event) => {
  // event.toolCallId, event.toolName, event.args
});

pi.on("tool_execution_update", async (event) => {
  // event.partialResult — streaming progress from onUpdate callback
});

pi.on("tool_execution_end", async (event) => {
  // event.result, event.isError
});
```

### `tool_result`

**When:** After a tool finishes executing, before the result is returned to the agent loop.

**Chaining:** Sequential. Each handler can modify the result. Modifications accumulate across handlers. All handlers see the evolving `currentEvent` with content/details/isError updated by previous handlers.

```typescript
pi.on("tool_result", async (event, ctx) => {
  // event.toolCallId: string
  // event.toolName: string
  // event.input: Record<string, unknown>
  // event.content: (TextContent | ImageContent)[]
  // event.details: unknown
  // event.isError: boolean
  
  // Modify the result
  return {
    content: [...event.content, { type: "text", text: "\n\nAudit: logged" }],
    isError: false, // can flip error state
  };
  
  // Return nothing to pass through unchanged
});
```

**Also fires for errors:** If tool execution throws, `tool_result` still fires with `isError: true` and the error message as content. Extensions can modify even error results.

---

## 5. Session Hooks

### `session_start`

**When:** Initial session load (startup) and after session switch/fork. Also fires after `/reload`.

**Use for:** State restoration from session entries, initial setup.

```typescript
pi.on("session_start", async (_event, ctx) => {
  // Restore state from session
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === "my-state") {
      myState = entry.data;
    }
  }
});
```

### `session_before_switch` / `session_switch`

**When:** Before/after `/new` or `/resume`.

```typescript
pi.on("session_before_switch", async (event) => {
  // event.reason: "new" | "resume"
  // event.targetSessionFile?: string (only for resume)
  return { cancel: true }; // prevent the switch
});
```

### `session_before_fork` / `session_fork`

**When:** Before/after `/fork`.

```typescript
pi.on("session_before_fork", async (event) => {
  // event.entryId: string — the entry being forked from
  return { cancel: true };
  // or
  return { skipConversationRestore: true }; // fork without restoring messages
});
```

### `session_before_compact` / `session_compact`

**When:** Before/after compaction (manual or auto).

```typescript
pi.on("session_before_compact", async (event) => {
  // event.preparation: CompactionPreparation
  // event.branchEntries: SessionEntry[]
  // event.customInstructions?: string
  // event.signal: AbortSignal
  
  return { cancel: true };
  // or provide custom compaction:
  return {
    compaction: {
      summary: "My custom summary",
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    }
  };
});
```

### `session_before_tree` / `session_tree`

**When:** Before/after `/tree` navigation.

```typescript
pi.on("session_before_tree", async (event) => {
  // event.preparation: TreePreparation
  // event.signal: AbortSignal
  
  return { cancel: true };
  // or provide custom summary:
  return {
    summary: { summary: "Custom branch summary" },
    label: "my-label",
  };
});
```

### `session_shutdown`

**When:** Process exit (Ctrl+C, Ctrl+D, SIGTERM, `ctx.shutdown()`).

```typescript
pi.on("session_shutdown", async (_event, ctx) => {
  // Last chance to persist state
  // Keep it fast — process is exiting
});
```

---

## 6. Model Hooks

### `model_select`

**When:** Model changes via `/model`, Ctrl+P cycling, or session restore.

```typescript
pi.on("model_select", async (event, ctx) => {
  // event.model: Model — the new model
  // event.previousModel: Model | undefined
  // event.source: "set" | "cycle" | "restore"
});
```

---

## 7. Resource Hooks

### `resources_discover`

**When:** At startup and after `/reload`. Lets extensions provide additional skill, prompt template, and theme paths.

**Not documented in extending-pi docs.** This is how extensions ship their own resources.

```typescript
pi.on("resources_discover", async (event, ctx) => {
  // event.cwd: string
  // event.reason: "startup" | "reload"
  
  return {
    skillPaths: [join(__dirname, "skills", "SKILL.md")],
    promptPaths: [join(__dirname, "prompts", "my-template.md")],
    themePaths: [join(__dirname, "themes", "dark.json")],
  };
});
```

**Behavior:** Returned paths are loaded by the resource loader and integrated into the system prompt (skills) and available commands (prompts/themes). The system prompt is rebuilt after resources are extended.

---

## 8. User Bash Hooks

### `user_bash`

**When:** User executes a command via `!` or `!!` prefix in the editor.

```typescript
pi.on("user_bash", async (event, ctx) => {
  // event.command: string
  // event.excludeFromContext: boolean (true if !! prefix)
  // event.cwd: string
  
  // Provide custom execution (e.g., SSH)
  return {
    operations: { execute: (cmd) => sshExec(remote, cmd) },
  };
  
  // Or provide a full replacement result
  return {
    result: { output: "custom output", exitCode: 0, cancelled: false, truncated: false },
  };
});
```

---

## Execution Order Across Extensions

All hooks iterate through extensions in **load order** (project-local first, then global, then explicitly configured via `-e`). Within each extension, handlers for the same event run in registration order.

For hooks that chain (e.g., `context`, `before_agent_start.systemPrompt`, `input`, `tool_result`):
- Extension A's handler runs first, Extension B sees A's output
- Load order determines priority

For hooks that short-circuit (e.g., `tool_call` with `block`, `input` with `handled`, session `cancel`):
- First extension to return the short-circuit value wins
- Remaining handlers are skipped
