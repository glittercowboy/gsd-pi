# Context Injection Patterns

Practical recipes for injecting, filtering, transforming, and managing context through pi's hook system. Each pattern includes when to use it, which hook to use, and the exact implementation.

---

## Pattern 1: Per-Prompt System Prompt Modification

**Use when:** You want to change the LLM's behavior for the entire agent run based on some condition.

**Hook:** `before_agent_start`

```typescript
let debugMode = false;

pi.registerCommand("debug", {
  handler: async (_args, ctx) => {
    debugMode = !debugMode;
    ctx.ui.notify(debugMode ? "Debug mode ON" : "Debug mode OFF");
  },
});

pi.on("before_agent_start", async (event) => {
  if (debugMode) {
    return {
      systemPrompt: event.systemPrompt + `

## Debug Mode
- Show your reasoning for each decision
- Before executing any tool, explain what you expect to happen
- After each tool result, explain what you learned
- If something unexpected happens, stop and explain before continuing`,
    };
  }
});
```

**Why `before_agent_start` and not `context`:** The system prompt is separate from the message array. `context` can only modify messages, not the system prompt.

---

## Pattern 2: Invisible Context Injection

**Use when:** You need the LLM to know something without the user seeing it in the chat.

**Hook:** `before_agent_start` with `display: false`

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  const gitBranch = await getBranch();
  const recentCommits = await getRecentCommits(5);
  
  return {
    message: {
      customType: "git-context",
      content: `[Git Context] Branch: ${gitBranch}\nRecent commits:\n${recentCommits}`,
      display: false,  // User doesn't see this in chat
      // But the LLM DOES see it — display only controls UI rendering
    },
  };
});
```

**Important:** `display: false` hides from UI only. The LLM always receives custom messages as `user` role content. There is no way to inject LLM-invisible metadata through `sendMessage` or `before_agent_start`.

---

## Pattern 3: Conditional Context Filtering

**Use when:** Some messages in the history are no longer relevant and waste context tokens.

**Hook:** `context`

```typescript
pi.on("context", async (event) => {
  return {
    messages: event.messages.filter(m => {
      // Remove custom messages from a previous mode
      if (m.role === "custom" && m.customType === "plan-mode-context") {
        return currentMode === "plan"; // only keep if still in plan mode
      }
      
      // Remove old bash executions beyond the last 10
      if (m.role === "bashExecution") {
        return bashCount++ >= totalBash - 10;
      }
      
      return true;
    }),
  };
});
```

**Why `context` and not `before_agent_start`:** `context` fires every turn and can see the full message array including tool results from earlier turns. `before_agent_start` fires once and can only inject — it can't filter existing messages.

---

## Pattern 4: Dynamic Context Injection Per Turn

**Use when:** You want to add context that changes between turns (e.g., current file state, running process output).

**Hook:** `context`

```typescript
pi.on("context", async (event, ctx) => {
  // Inject a synthetic message at the end of the conversation
  const liveStatus = await getProcessStatus();
  
  const contextMessage = {
    role: "user" as const,
    content: [{ type: "text" as const, text: `[Live Status] ${liveStatus}` }],
    timestamp: Date.now(),
  };
  
  return {
    messages: [...event.messages, contextMessage],
  };
});
```

**Caution:** Messages injected in `context` are NOT persisted to the session. They exist only for the LLM call. Next turn, you'll need to inject again. This is actually useful — it means the context is always fresh.

---

## Pattern 5: Deferred Context (Next Turn)

**Use when:** You want to attach context to the user's next prompt without interrupting the current conversation.

**Mechanism:** `pi.sendMessage` with `deliverAs: "nextTurn"`

```typescript
// Queue context for the next user prompt
pi.sendMessage(
  {
    customType: "deferred-context",
    content: "The test suite passed with 47/47 tests",
    display: false,
  },
  { deliverAs: "nextTurn" }
);
```

**How it works internally:** The message is stored in `_pendingNextTurnMessages` and injected into the `messages` array when the next `agent.prompt()` is called, after the user message. Unlike `context` hook injection, these messages ARE persisted to the session.

---

## Pattern 6: Context Window Management

**Use when:** You're approaching the context limit and need to intelligently prune.

**Hook:** `context`

```typescript
pi.on("context", async (event, ctx) => {
  const usage = ctx.getContextUsage();
  if (!usage || usage.percent === null || usage.percent < 70) {
    return; // plenty of room
  }
  
  // Aggressive pruning: remove tool results beyond the last 20
  let toolResultCount = 0;
  const total = event.messages.filter(m => m.role === "toolResult").length;
  
  return {
    messages: event.messages.filter(m => {
      if (m.role === "toolResult") {
        toolResultCount++;
        // Keep last 20 tool results
        return toolResultCount > total - 20;
      }
      return true;
    }),
  };
});
```

---

## Pattern 7: Steering with Context

**Use when:** You want to redirect the agent mid-run with additional context.

**Mechanism:** `pi.sendMessage` with `deliverAs: "steer"`

```typescript
// During an agent run, inject a steering message
pi.sendMessage(
  {
    customType: "user-feedback",
    content: "IMPORTANT: The user just updated the config file. Re-read config.json before continuing.",
    display: true,
  },
  { deliverAs: "steer" }
);
```

**What happens:** The current tool call finishes, remaining queued tool calls are skipped (they get error results saying "Skipped due to queued user message"), and the steering message becomes input for the next turn.

---

## Pattern 8: Follow-Up Context After Completion

**Use when:** You want to trigger another LLM turn after the agent finishes, with additional context.

**Mechanism:** `pi.sendMessage` with `deliverAs: "followUp"`

```typescript
pi.on("agent_end", async (event, ctx) => {
  // Check if the agent made changes that need verification
  const hasEdits = event.messages.some(m => 
    m.role === "toolResult" && m.toolName === "edit"
  );
  
  if (hasEdits) {
    pi.sendMessage(
      {
        customType: "auto-verify",
        content: "You just made edits. Please verify them by running the test suite.",
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: true }
    );
  }
});
```

---

## Pattern 9: Tool-Scoped Context via promptGuidelines

**Use when:** You want context that only appears when specific tools are active.

**Mechanism:** `promptGuidelines` on tool registration

```typescript
pi.registerTool({
  name: "deploy",
  label: "Deploy",
  description: "Deploy the application",
  promptSnippet: "Deploy the application to staging or production",
  promptGuidelines: [
    "Always run tests before deploying",
    "Never deploy to production without explicit user confirmation",
    "After deploying, verify the health check endpoint",
  ],
  parameters: Type.Object({ /* ... */ }),
  async execute(toolCallId, params, signal, onUpdate, ctx) { /* ... */ },
});
```

**Behavior:** The `promptGuidelines` are added to the "Guidelines" section of the system prompt ONLY when the `deploy` tool is in the active tool set. If the tool is disabled via `pi.setActiveTools(...)`, the guidelines disappear.

---

## Pattern 10: Persistent State as Context

**Use when:** You need state that survives session resume AND is visible to the LLM.

**Mechanism:** Tool result `details` + `session_start` reconstruction + `before_agent_start` injection

```typescript
let projectFacts: string[] = [];

pi.on("session_start", async (_event, ctx) => {
  // Reconstruct from session
  projectFacts = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "toolResult") {
      if (entry.message.toolName === "learn_fact") {
        projectFacts = entry.message.details?.facts ?? [];
      }
    }
  }
});

pi.registerTool({
  name: "learn_fact",
  label: "Learn Fact",
  description: "Record a fact about the project",
  parameters: Type.Object({ fact: Type.String() }),
  async execute(toolCallId, params) {
    projectFacts.push(params.fact);
    return {
      content: [{ type: "text", text: `Learned: ${params.fact}` }],
      details: { facts: [...projectFacts] }, // snapshot in details for branching
    };
  },
});

pi.on("before_agent_start", async (event) => {
  if (projectFacts.length > 0) {
    return {
      message: {
        customType: "project-facts",
        content: `Known project facts:\n${projectFacts.map(f => `- ${f}`).join("\n")}`,
        display: false,
      },
    };
  }
});
```

**Why this works for branching:** State lives in tool result `details`, so when the user forks from an earlier point, `session_start` reconstructs from `getBranch()` (the current path), not the full history. Old branches' facts don't leak into new branches.

---

## Pattern 11: Input Preprocessing / Macros

**Use when:** You want custom syntax that expands before the LLM sees it.

**Hook:** `input`

```typescript
pi.on("input", async (event) => {
  // Expand @file references to file contents
  const expanded = event.text.replace(/@(\S+)/g, (match, filePath) => {
    try {
      const content = readFileSync(filePath, "utf-8");
      return `\`\`\`${filePath}\n${content}\n\`\`\``;
    } catch {
      return match; // leave unchanged if can't read
    }
  });
  
  if (expanded !== event.text) {
    return { action: "transform", text: expanded };
  }
  return { action: "continue" };
});
```

---

## Pattern 12: Context-Aware Tool Blocking

**Use when:** You want to prevent certain tool usage based on conversation context.

**Hook:** `tool_call` with `context` awareness

```typescript
let inPlanMode = false;

pi.on("tool_call", async (event, ctx) => {
  if (!inPlanMode) return;
  
  const destructiveTools = ["edit", "write", "bash"];
  
  if (event.toolName === "bash" && isToolCallEventType("bash", event)) {
    // Allow read-only bash commands
    if (isSafeCommand(event.input.command)) return;
  }
  
  if (destructiveTools.includes(event.toolName)) {
    return {
      block: true,
      reason: `Plan mode active: ${event.toolName} is not allowed. Use /plan to exit plan mode.`,
    };
  }
});
```

---

## Anti-Patterns

### ❌ Don't: Modify system prompt in `context`

```typescript
// WRONG — context event can only modify messages, not the system prompt
pi.on("context", async (event, ctx) => {
  // This does nothing to the system prompt
  return { systemPrompt: "new prompt" }; // ← not a valid return field
});
```

### ❌ Don't: Rely on `display: false` for security

```typescript
// WRONG — display: false only hides from UI, LLM still sees it
pi.on("before_agent_start", async () => ({
  message: {
    customType: "secret",
    content: "API_KEY=sk-1234", // LLM receives this as a user message!
    display: false,
  },
}));
```

### ❌ Don't: Use `context` for one-time injection

```typescript
// WRONG — context fires every turn, so this injects repeatedly
let injected = false;
pi.on("context", async (event) => {
  if (!injected) {
    injected = true;
    return { messages: [...event.messages, myMessage] };
  }
});
// Problem: after compaction or session restore, injected resets to false
```

Use `before_agent_start` with `message` for one-time per-prompt injection instead.

### ❌ Don't: Use `getEntries()` for branch-aware state

```typescript
// WRONG — getEntries() returns ALL entries including dead branches
for (const entry of ctx.sessionManager.getEntries()) { /* ... */ }

// CORRECT — getBranch() returns only entries on the current branch path
for (const entry of ctx.sessionManager.getBranch()) { /* ... */ }
```
