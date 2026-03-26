# Advanced Patterns from Source

Production patterns extracted from the pi codebase, built-in extensions, and real extension examples. Each pattern shows the mechanism, the source of truth, and when to use it.

---

## Pattern 1: Mode-Aware Tool Sets with Context Injection

**Source:** `plan-mode/index.ts` — the built-in plan mode extension.

This pattern combines tool set management, tool call blocking, context event filtering, and before_agent_start injection into a cohesive mode system.

### The Architecture

```
/plan toggle → sets planModeEnabled
  ├─► setActiveTools(PLAN_MODE_TOOLS)     # restrict available tools
  ├─► tool_call guard                      # block unsafe bash even if tool is active
  ├─► before_agent_start                   # inject mode-specific instructions
  ├─► context                              # filter stale mode messages on mode exit
  └─► agent_end                            # check plan output, offer execution
```

### Key Insight: Defense in Depth

The plan mode uses THREE layers of tool control:

1. **`setActiveTools`** — removes write tools from the active set entirely. The LLM doesn't even know they exist.
2. **`tool_call` guard** — even for allowed tools like `bash`, blocks destructive commands via an allowlist.
3. **`context` filter** — when exiting plan mode, removes stale plan mode context messages so they don't confuse the LLM in normal mode.

```typescript
// Layer 1: Tool set
if (planModeEnabled) {
  pi.setActiveTools(["read", "bash", "grep", "find", "ls"]);
}

// Layer 2: Bash guard  
pi.on("tool_call", async (event) => {
  if (!planModeEnabled || event.toolName !== "bash") return;
  if (!isSafeCommand(event.input.command)) {
    return { block: true, reason: "Plan mode: command blocked" };
  }
});

// Layer 3: Context cleanup on mode exit
pi.on("context", async (event) => {
  if (planModeEnabled) return; // keep plan context when in plan mode
  return {
    messages: event.messages.filter(m => {
      // Remove plan mode markers from context
      if (m.customType === "plan-mode-context") return false;
      return true;
    }),
  };
});
```

### Why This Matters

A naive implementation would just change the tool set. But:
- `bash` with `rm -rf` is technically a "read-only" tool by name
- Stale context messages from a previous mode can confuse the LLM
- The LLM might try to work around restrictions if it sees the mode instructions but has the tools available

---

## Pattern 2: Preset System with Dynamic Model + Tool + Prompt Configuration

**Source:** `preset.ts` — the built-in preset extension.

This pattern shows how to build a full configuration management system that coordinates model, thinking level, tools, and system prompt from a single config file.

### The Architecture

```
presets.json → load on session_start
  │
  ├─► /preset command      → applyPreset(name)
  ├─► Ctrl+Shift+U         → cyclePreset()
  ├─► --preset flag         → applyPreset on startup
  │
  applyPreset:
  ├─► pi.setModel()         → switch model
  ├─► pi.setThinkingLevel() → adjust thinking
  ├─► pi.setActiveTools()   → reconfigure tools
  └─► store activePreset    → before_agent_start reads it
  
  before_agent_start:
  └─► append preset.instructions to system prompt
```

### Key Insight: Deferred System Prompt Application

The preset doesn't modify the system prompt during `applyPreset`. It stores `activePreset` and lets `before_agent_start` read it:

```typescript
// On apply — just store
activePresetName = name;
activePreset = preset;

// On each prompt — inject
pi.on("before_agent_start", async (event) => {
  if (activePreset?.instructions) {
    return {
      systemPrompt: `${event.systemPrompt}\n\n${activePreset.instructions}`,
    };
  }
});
```

This is better than calling `agent.setSystemPrompt()` directly because:
- `before_agent_start` fires on every prompt, keeping the system prompt current
- The base system prompt is rebuilt by pi when tools change — a direct set would be overwritten
- Other extensions can see and further modify the prompt in the chain

---

## Pattern 3: Progress Tracking with Widget + State Persistence

**Source:** `plan-mode/index.ts` — todo item tracking during plan execution.

### The Architecture

```
Plan created (assistant message with "Plan:" section)
  → extractTodoItems() parses numbered steps
  → todoItems stored in memory
  → ui.setWidget() shows progress
  → appendEntry() persists state
  
Each turn:
  → turn_end checks for [DONE:n] markers
  → markCompletedSteps() updates todoItems
  → updateStatus() refreshes widget
  
Session resume:
  → session_start restores from appendEntry
  → Re-scans messages after last execute marker for [DONE:n]
  → Rebuilds completion state
```

### Key Insight: Dual State Reconstruction

On session resume, the extension does TWO things:

1. **Reads the persisted state** from `appendEntry`:
   ```typescript
   const planModeEntry = entries
     .filter(e => e.type === "custom" && e.customType === "plan-mode")
     .pop();
   ```

2. **Re-scans assistant messages** for completion markers:
   ```typescript
   // Only scan messages AFTER the last plan-mode-execute marker
   const allText = messages.map(getTextContent).join("\n");
   markCompletedSteps(allText, todoItems);
   ```

This handles the case where the extension crashed or was reloaded mid-execution — the persisted state might be stale, but the messages are the source of truth.

---

## Pattern 4: Dynamic Resource Injection

**Source:** `dynamic-resources/index.ts` — extension that ships its own skills and themes.

```typescript
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const baseDir = dirname(fileURLToPath(import.meta.url));

export default function (pi: ExtensionAPI) {
  pi.on("resources_discover", () => {
    return {
      skillPaths: [join(baseDir, "SKILL.md")],
      promptPaths: [join(baseDir, "dynamic.md")],
      themePaths: [join(baseDir, "dynamic.json")],
    };
  });
}
```

### How It Works Internally

After `session_start`, the runner calls `emitResourcesDiscover()`. The returned paths are processed through the `ResourceLoader`:

1. Skills → loaded, added to system prompt's skill listing
2. Prompts → loaded as prompt templates, available via `/templatename`
3. Themes → loaded, available via `/theme` or `ctx.ui.setTheme()`

The system prompt is rebuilt after resources are extended, so new skills appear in the same prompt turn.

### When to Use

- Extension packages that need custom skills (e.g., a deployment extension with a "deploy checklist" skill)
- Theme packs distributed as extensions
- Dynamic prompt templates that depend on the project context

---

## Pattern 5: Claude Rules Integration

**Source:** `claude-rules.ts` — scanning `.claude/rules/` for per-project rules.

### The Architecture

```
session_start:
  → Scan .claude/rules/ for .md files (recursive)
  → Store file list

before_agent_start:
  → Append file list to system prompt
  → Agent uses read tool to load specific rules on demand
```

### Key Insight: Listing, Not Loading

The extension does NOT load rule file contents into the system prompt. It lists the files:

```typescript
pi.on("before_agent_start", async (event) => {
  if (ruleFiles.length === 0) return;
  
  const rulesList = ruleFiles.map(f => `- .claude/rules/${f}`).join("\n");
  
  return {
    systemPrompt: event.systemPrompt + `

## Project Rules
The following project rules are available in .claude/rules/:
${rulesList}
When working on tasks related to these rules, use the read tool to load the relevant rule files.`,
  };
});
```

This is context-efficient: the system prompt grows by one line per rule file, not by the full contents of every rule. The LLM loads specific rules via `read` only when relevant.

---

## Pattern 6: Remote Execution via Tool Wrapping

**Source:** The SSH extension pattern and `createBashTool` with pluggable operations.

### The Architecture

Tools support pluggable `operations` that replace the underlying I/O:

```typescript
import { createBashTool } from "@mariozechner/pi-coding-agent";

// Create a bash tool that executes via SSH
const remoteBash = createBashTool(cwd, {
  operations: {
    execute: async (command, options) => {
      return sshExec(remoteHost, command, options);
    },
  },
});

// Register it as the bash tool (overrides built-in)
pi.registerTool({
  ...remoteBash,
  name: "bash", // same name = overrides built-in
});
```

### The spawnHook Alternative

For lighter customization (e.g., environment setup):

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: ({ command, cwd, env }) => ({
    command: `source ~/.profile\n${command}`,
    cwd: `/mnt/sandbox${cwd}`,
    env: { ...env, CI: "1" },
  }),
});
```

### User Bash Hook for `!` Commands

The `user_bash` event lets you intercept user-typed bash commands (not LLM-initiated ones):

```typescript
pi.on("user_bash", async (event) => {
  // Route user bash commands through SSH too
  return {
    operations: {
      execute: (cmd, opts) => sshExec(remoteHost, cmd, opts),
    },
  };
});
```

---

## Pattern 7: Extension-Aware Compaction

**Source:** `session_before_compact` in agent-session.ts.

### Custom Compaction Summary

Override the default LLM-generated summary:

```typescript
pi.on("session_before_compact", async (event) => {
  // Build a domain-specific summary
  const summary = buildCustomSummary(event.branchEntries);
  
  return {
    compaction: {
      summary,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    },
  };
});
```

### Compaction-Aware State

If your extension stores state in messages that might get compacted away, you need a reconstruction strategy:

```typescript
pi.on("session_start", async (_event, ctx) => {
  // Check if there's been a compaction
  const entries = ctx.sessionManager.getBranch();
  const hasCompaction = entries.some(e => e.type === "compaction");
  
  if (hasCompaction) {
    // State before compaction is gone from messages
    // Fall back to appendEntry data or re-derive from remaining messages
    restoreFromAppendEntries(entries);
  } else {
    // Full message history available
    restoreFromToolResults(entries);
  }
});
```

---

## Pattern 8: The Complete Extension Initialization Sequence

From the source code, the full initialization order is:

```
1. Extension factory function runs
   ├─► pi.on() — register event handlers
   ├─► pi.registerTool() — register tools
   ├─► pi.registerCommand() — register commands
   ├─► pi.registerShortcut() — register shortcuts
   ├─► pi.registerFlag() — register CLI flags
   └─► pi.registerProvider() — queued (not yet applied)

2. ExtensionRunner created with all extensions

3. bindCore() — action methods become live
   ├─► pi.sendMessage, pi.setActiveTools, etc. now work
   └─► Queued provider registrations flushed to ModelRegistry

4. bindExtensions() — UI context and command context connected
   └─► setUIContext(), bindCommandContext()

5. session_start event fires
   └─► Extensions restore state from session

6. resources_discover event fires
   └─► Extensions provide additional skill/prompt/theme paths

7. System prompt rebuilt with new resources

8. Ready for first user prompt
```

**Important timing:** During step 1, action methods (`sendMessage`, `setActiveTools`, etc.) will throw. You can only register handlers and tools during the factory function. Use `session_start` for anything that needs runtime access.
