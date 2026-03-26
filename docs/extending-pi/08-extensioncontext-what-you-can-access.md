# ExtensionContext — What You Can Access


Every event handler receives `ctx: ExtensionContext`. This is your window into pi's runtime state.

### ctx.ui — User Interaction

The primary way to interact with the user. See [Section 12: Custom UI](#12-custom-ui--visual-components) for full details.

```typescript
// Dialogs (blocking, wait for user response)
const choice = await ctx.ui.select("Pick one:", ["A", "B", "C"]);
const ok = await ctx.ui.confirm("Delete?", "This cannot be undone");
const name = await ctx.ui.input("Name:", "placeholder");
const text = await ctx.ui.editor("Edit:", "prefilled text");

// Non-blocking UI
ctx.ui.notify("Done!", "info");           // Toast notification
ctx.ui.setStatus("my-ext", "Active");     // Footer status
ctx.ui.setWidget("my-id", ["Line 1"]);    // Widget above/below editor
ctx.ui.setTitle("pi - my project");       // Terminal title
ctx.ui.setEditorText("Prefill text");     // Set editor content
ctx.ui.setWorkingMessage("Thinking...");  // Working message during streaming
```

### ctx.hasUI

`false` in print mode (`-p`) and JSON mode. `true` in interactive and RPC mode. Always check before calling dialog methods in non-interactive contexts.

### ctx.cwd

Current working directory (string).

### ctx.sessionManager — Session State

Read-only access to the session:

```typescript
ctx.sessionManager.getEntries()       // All entries in session
ctx.sessionManager.getBranch()        // Current branch entries
ctx.sessionManager.getLeafId()        // Current leaf entry ID
ctx.sessionManager.getSessionFile()   // Path to session JSONL file
ctx.sessionManager.getLabel(entryId)  // Get label on entry
```

### ctx.modelRegistry / ctx.model

Access to available models and the current model.

### ctx.isIdle() / ctx.abort() / ctx.hasPendingMessages()

Control flow helpers for checking agent state.

### ctx.shutdown()

Request graceful shutdown. Deferred until agent is idle. Emits `session_shutdown` before exiting.

### ctx.getContextUsage()

Returns current context token usage. Useful for triggering compaction or showing stats.

```typescript
const usage = ctx.getContextUsage();
if (usage && usage.tokens > 100_000) {
  // Context is getting large
}
```

### ctx.compact(options?)

Trigger compaction programmatically:

```typescript
ctx.compact({
  customInstructions: "Focus on recent changes",
  onComplete: (result) => ctx.ui.notify("Compacted!", "info"),
  onError: (error) => ctx.ui.notify(`Failed: ${error.message}`, "error"),
});
```

### ctx.getSystemPrompt()

Returns the current effective system prompt (including any `before_agent_start` modifications).

---
