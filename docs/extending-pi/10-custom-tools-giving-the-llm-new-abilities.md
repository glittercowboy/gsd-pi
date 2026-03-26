# Custom Tools — Giving the LLM New Abilities


Tools are the most powerful extension capability. They appear in the LLM's system prompt and the LLM calls them autonomously when appropriate.

### Tool Definition

```typescript
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

pi.registerTool({
  name: "my_tool",                    // Unique identifier
  label: "My Tool",                   // Display name in TUI
  description: "What this does",      // Shown to LLM in system prompt
  
  // Optional: customize the one-liner in the system prompt's "Available tools" section
  promptSnippet: "List or add items to the project todo list",
  
  // Optional: add bullets to the system prompt's "Guidelines" section when tool is active
  promptGuidelines: [
    "Use this tool for todo planning instead of direct file edits."
  ],
  
  // Parameter schema (MUST use TypeBox)
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),  // ⚠️ Use StringEnum, NOT Type.Union/Type.Literal
    text: Type.Optional(Type.String()),
  }),

  // The execution function
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Check for cancellation
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }] };
    }

    // Stream progress updates to the UI
    onUpdate?.({
      content: [{ type: "text", text: "Working..." }],
      details: { progress: 50 },
    });

    // Do the work
    const result = await doSomething(params);

    // Return result
    return {
      content: [{ type: "text", text: "Done" }],  // Sent to LLM as context
      details: { data: result },                   // For rendering & state reconstruction
    };
  },

  // Optional: Custom TUI rendering (see Section 14)
  renderCall(args, theme) { ... },
  renderResult(result, options, theme) { ... },
});
```

### ⚠️ Critical: Use StringEnum

For string enum parameters, you **must** use `StringEnum` from `@mariozechner/pi-ai`. `Type.Union([Type.Literal("a"), Type.Literal("b")])` does NOT work with Google's API.

```typescript
import { StringEnum } from "@mariozechner/pi-ai";

// ✅ Correct
action: StringEnum(["list", "add", "remove"] as const)

// ❌ Broken with Google
action: Type.Union([Type.Literal("list"), Type.Literal("add")])
```

### Dynamic Tool Registration

Tools can be registered at any time — during load, in `session_start`, in command handlers, etc. New tools are available immediately without `/reload`.

```typescript
pi.on("session_start", async (_event, ctx) => {
  pi.registerTool({ name: "dynamic_tool", ... });
});

pi.registerCommand("add-tool", {
  handler: async (args, ctx) => {
    pi.registerTool({ name: "runtime_tool", ... });
    ctx.ui.notify("Tool registered!", "info");
  },
});
```

### Output Truncation

**Tools MUST truncate output** to avoid overwhelming the LLM context. The built-in limit is 50KB / 2000 lines (whichever first).

```typescript
import {
  truncateHead, truncateTail, formatSize,
  DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES,
} from "@mariozechner/pi-coding-agent";

async execute(toolCallId, params, signal, onUpdate, ctx) {
  const output = await runCommand();
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  let result = truncation.content;
  if (truncation.truncated) {
    result += `\n\n[Output truncated: ${truncation.outputLines}/${truncation.totalLines} lines]`;
  }
  return { content: [{ type: "text", text: result }] };
}
```

### Overriding Built-in Tools

Register a tool with the same name as a built-in (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) to override it. Your implementation **must match the exact result shape** including the `details` type.

```bash
# Start with no built-in tools, only your extensions
pi --no-tools -e ./my-extension.ts
```

### Remote Execution via Pluggable Operations

Built-in tools support pluggable operations for SSH, containers, etc.:

```typescript
import { createReadTool, createBashTool } from "@mariozechner/pi-coding-agent";

const remoteBash = createBashTool(cwd, {
  operations: { execute: (cmd) => sshExec(remote, cmd) }
});

// The bash tool also supports a spawnHook:
const bashTool = createBashTool(cwd, {
  spawnHook: ({ command, cwd, env }) => ({
    command: `source ~/.profile\n${command}`,
    cwd: `/mnt/sandbox${cwd}`,
    env: { ...env, CI: "1" },
  }),
});
```

**Operations interfaces:** `ReadOperations`, `WriteOperations`, `EditOperations`, `BashOperations`, `LsOperations`, `GrepOperations`, `FindOperations`

---
