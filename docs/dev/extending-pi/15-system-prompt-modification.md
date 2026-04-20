# System Prompt Modification


### Per-Turn Modification (before_agent_start)

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  return {
    // Inject a persistent message (stored in session, visible to LLM)
    message: {
      customType: "my-extension",
      content: "Additional context for the LLM",
      display: true,
    },
    // Modify the system prompt for this turn
    systemPrompt: event.systemPrompt + "\n\nYou must respond only in haiku.",
  };
});
```

### Context Manipulation (context event)

Modify the messages sent to the LLM on every turn:

```typescript
pi.on("context", async (event, ctx) => {
  // event.messages is a deep copy — safe to modify
  const filtered = event.messages.filter(m => !isIrrelevant(m));
  return { messages: filtered };
});
```

### Tool-Specific Prompt Content

Tools can add to the system prompt when they're active:

```typescript
pi.registerTool({
  name: "my_tool",
  promptSnippet: "Summarize or transform text according to action",  // Replaces description in "Available tools"
  promptGuidelines: [
    "Use my_tool when the user asks to summarize text.",
    "Prefer my_tool over direct output for structured data."
  ],  // Added to "Guidelines" section when tool is active
  // ...
});
```

---
