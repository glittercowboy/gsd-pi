# Compaction & Session Control


### Custom Compaction

Override the default compaction behavior:

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, signal } = event;

  // Option 1: Cancel compaction
  return { cancel: true };

  // Option 2: Provide custom summary
  return {
    compaction: {
      summary: "Custom summary of conversation so far...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    }
  };
});
```

### Triggering Compaction

```typescript
ctx.compact({
  customInstructions: "Focus on the authentication changes",
  onComplete: (result) => ctx.ui.notify("Compacted!", "info"),
});
```

### Session Control (Commands Only)

```typescript
pi.registerCommand("handoff", {
  handler: async (args, ctx) => {
    // Create a new session with initial context
    await ctx.newSession({
      setup: async (sm) => {
        sm.appendMessage({
          role: "user",
          content: [{ type: "text", text: "Context: " + args }],
          timestamp: Date.now(),
        });
      },
    });
  },
});
```

---
