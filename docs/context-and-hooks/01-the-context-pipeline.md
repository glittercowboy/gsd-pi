# The Context Pipeline

The full journey of a user prompt from keypress to LLM input, through every transformation stage. Understanding this pipeline is the foundation of all context engineering in pi.

---

## The Pipeline at a Glance

```
User types prompt and hits Enter
│
├─► Extension command check (/command)
│   If match → run handler, skip everything below
│
├─► input event
│   Extensions can: transform text/images, intercept entirely, or pass through
│
├─► Skill expansion (/skill:name)
│   Skill file content injected into prompt text
│
├─► Prompt template expansion (/template)
│   Template file content merged into prompt text
│
├─► before_agent_start event [ONCE per user prompt]
│   Extensions can:
│     • Inject custom messages (appended after user message)
│     • Modify the system prompt (chained across extensions)
│
├─► Agent.prompt(messages)
│   Messages array: [user message, ...nextTurn messages, ...extension messages]
│
│   ┌── Turn loop (repeats while LLM calls tools) ──────────────┐
│   │                                                            │
│   │  transformContext (= context event) [EVERY turn]           │
│   │    Extensions receive AgentMessage[] deep copy             │
│   │    Can filter, reorder, inject, or replace messages        │
│   │    Multiple handlers chain: each sees previous output      │
│   │                                                            │
│   │  convertToLlm [EVERY turn, AFTER context event]           │
│   │    AgentMessage[] → Message[]                              │
│   │    Custom types mapped to user role                        │
│   │    bashExecution (!! prefix) filtered out                  │
│   │    Not extensible — hardcoded in messages.ts               │
│   │                                                            │
│   │  LLM call                                                  │
│   │    System prompt + converted messages + tool definitions   │
│   │                                                            │
│   │  Tool execution (if LLM calls tools)                       │
│   │    tool_call event → can block                             │
│   │    execute runs                                            │
│   │    tool_result event → can modify result                   │
│   │    Steering check → may skip remaining tools               │
│   │                                                            │
│   │  Follow-up check (if no more tool calls)                   │
│   │    Queued follow-up messages become next turn input         │
│   │                                                            │
│   └────────────────────────────────────────────────────────────┘
│
└─► agent_end event
```

---

## Stage-by-Stage Detail

### Stage 1: Extension Command Check

The first thing that happens. If the text starts with `/` and matches a registered extension command, the command handler runs and **the prompt never reaches the agent**. No events fire. No LLM call happens.

This means extension commands are fully synchronous escape hatches — they execute even during streaming (they're checked before any queuing logic).

### Stage 2: Input Event

```typescript
pi.on("input", async (event, ctx) => {
  // event.text — the raw user input
  // event.images — attached images, if any
  // event.source — "interactive" | "rpc" | "extension"
  
  // Three possible return values:
  return { action: "continue" };                    // pass through unchanged
  return { action: "transform", text: "new text" }; // rewrite the input
  return { action: "handled" };                      // swallow entirely
});
```

**Chaining:** Multiple `input` handlers chain. If handler A returns `transform`, handler B sees the transformed text. If any handler returns `handled`, the pipeline stops — no LLM call.

**Timing:** Fires before skill/template expansion. Your handler sees the raw `/skill:name args` text, not the expanded content.

### Stage 3: Skill and Template Expansion

Deterministic text substitution. `/skill:name args` becomes the skill file content wrapped in `<skill>` tags. `/template args` becomes the template file content. These are string replacements — no events fire.

### Stage 4: before_agent_start

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // event.prompt — the expanded user prompt text
  // event.images — attached images
  // event.systemPrompt — current system prompt (may be modified by earlier extensions)
  
  return {
    message: {
      customType: "my-context",
      content: "Context the LLM should see",
      display: false,  // UI rendering only — LLM ALWAYS sees it
    },
    systemPrompt: event.systemPrompt + "\nExtra instructions",
  };
});
```

**Critical facts:**
- Fires **once** per user prompt, not per turn
- System prompts **chain**: Extension A modifies it, Extension B sees the modified version in `event.systemPrompt`
- Messages **accumulate**: All extensions' messages are collected and injected as separate entries
- If no extension returns a `systemPrompt`, the base system prompt is restored (previous turn's modifications don't persist)

**Message injection order in the final array:**
```
[user message] → [nextTurn messages] → [extension messages from before_agent_start]
```

### Stage 5: The Turn Loop

This is where the LLM is actually called. The turn loop repeats for each LLM response that includes tool calls.

#### 5a: transformContext / context event

The `context` event is wired as the `transformContext` callback on the Agent. It fires on **every turn** within the agent loop.

```typescript
// Inside the agent loop (agent-loop.ts):
let messages = context.messages;
if (config.transformContext) {
  messages = await config.transformContext(messages, signal);
}
const llmMessages = await config.convertToLlm(messages);
```

The `context` event handler in the runner creates a `structuredClone` deep copy:

```typescript
// runner.ts emitContext():
let currentMessages = structuredClone(messages);
// ...each handler receives and can modify currentMessages
```

**This means:**
- You get a deep copy — safe to mutate, splice, filter, or replace
- You work at the `AgentMessage[]` level (includes custom types)
- Multiple handlers chain: each sees the output of the previous
- **You cannot modify the system prompt here** — only `before_agent_start` can do that
- The messages include everything: user messages, assistant responses, tool results, custom messages, bash executions, compaction summaries, branch summaries

#### 5b: convertToLlm

After `context` event processing, `convertToLlm` maps `AgentMessage[]` to `Message[]`:

| AgentMessage role | Converted to | Notes |
|---|---|---|
| `user` | `user` | Pass through |
| `assistant` | `assistant` | Pass through |
| `toolResult` | `toolResult` | Pass through |
| `custom` | `user` | Content preserved, `display` field ignored |
| `bashExecution` | `user` | Unless `excludeFromContext` (`!!` prefix) → filtered out |
| `compactionSummary` | `user` | Wrapped in `<summary>` tags |
| `branchSummary` | `user` | Wrapped in `<summary>` tags |

**`convertToLlm` is not extensible.** It's a hardcoded function in `messages.ts`. If you need to change how messages appear to the LLM, do it in the `context` event handler before this stage.

#### 5c: LLM Call

The converted messages plus system prompt plus tool definitions go to the LLM provider. The system prompt used is whatever was set by `before_agent_start` (or the base prompt if no extension modified it).

#### 5d: Tool Execution and Interception

When the LLM responds with tool calls, they execute sequentially:

```
For each tool call:
  tool_call event → can { block: true, reason: "..." }
    If blocked → Error("reason") becomes the tool result
  tool_execution_start event (informational)
  tool.execute() runs
  tool_execution_end event (informational)
  tool_result event → can modify { content, details, isError }
  
  Steering check → if steering messages queued:
    Remaining tools get "Skipped due to queued user message"
    Steering messages become input for next turn
```

### Stage 6: Follow-up and Continuation

When the LLM finishes and has no more tool calls:
1. Check for steering messages → if any, start new turn with them
2. Check for follow-up messages → if any, start new turn with them  
3. If neither → `agent_end` fires, agent goes idle

---

## What the LLM Actually Sees

For any given turn, the LLM receives:

```
System prompt (base + before_agent_start modifications)
  +
Messages (after context event filtering, after convertToLlm mapping)
  +
Tool definitions (active tools with names, descriptions, parameter schemas)
```

The system prompt includes:
- Base prompt (tool descriptions, guidelines, pi docs reference, date/time, cwd)
- `promptSnippet` overrides from active tools (replaces tool description in "Available tools")
- `promptGuidelines` from active tools (appended to "Guidelines" section)
- `appendSystemPrompt` from settings/config
- Project context files (AGENTS.md, CLAUDE.md from cwd ancestors)
- Skills listing (names + descriptions, agent uses `read` to load them)
- Any `before_agent_start` modifications

---

## Key Timing Distinctions

| Hook | When | How often | Can modify |
|------|------|-----------|-----------|
| `input` | Before expansion | Once per user input | Input text |
| `before_agent_start` | After expansion, before agent loop | Once per user prompt | System prompt + inject messages |
| `context` | Before each LLM call | Every turn in agent loop | Message array |
| `tool_call` | Before each tool execution | Per tool call | Block execution |
| `tool_result` | After each tool execution | Per tool call | Result content/details |

---

## The Deep Copy Question

When do you get a safe-to-mutate copy vs a reference?

| Hook | What you receive | Safe to mutate? |
|------|-----------------|-----------------|
| `context` | `structuredClone` deep copy | Yes |
| `before_agent_start` | `event.systemPrompt` is a string (immutable) | Return new string |
| `tool_call` | `event.input` is the raw args object | Do not mutate — return `block` |
| `tool_result` | `{ ...event }` shallow spread | Return new values, don't mutate |
| `input` | `event.text` is a string (immutable) | Return new text via `transform` |
