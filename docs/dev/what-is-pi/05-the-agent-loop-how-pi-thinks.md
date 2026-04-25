# The Agent Loop — How Pi Thinks

The agent loop is the heartbeat of pi. It's what happens between you sending a prompt and getting a response:

```
User sends prompt
    │
    ▼
┌─ TURN START ──────────────────────────────────────┐
│                                                    │
│  1. Assemble context                               │
│     - System prompt (+ modifications from hooks)   │
│     - Previous messages (or compaction summary)     │
│     - The new user message                         │
│                                                    │
│  2. Send to LLM                                    │
│     - Stream response tokens                       │
│     - Parse any tool calls in the response         │
│                                                    │
│  3. If tool calls present:                         │
│     - For each tool call:                          │
│       a. Fire tool_call event (can be blocked)     │
│       b. Execute the tool                          │
│       c. Fire tool_result event (can be modified)  │
│       d. Append result to messages                 │
│     - Go back to step 1 (new turn with results)    │
│                                                    │
│  4. If no tool calls (LLM just responded):         │
│     - Save messages to session                     │
│     - Done                                         │
│                                                    │
└───────────────────────────────────────────────────┘
```

**Key insight:** The loop keeps going until the LLM decides to stop calling tools. A single user prompt might trigger 1 turn or 50 turns depending on the task complexity. Each turn is a complete LLM call → response → tool execution cycle.

**Stop reasons the LLM can produce:**
- `stop` — Normal completion, the LLM is done
- `toolUse` — The LLM wants to call tools (triggers another turn)
- `length` — Hit the output token limit
- `error` — Something went wrong
- `aborted` — User cancelled (Escape)

---
