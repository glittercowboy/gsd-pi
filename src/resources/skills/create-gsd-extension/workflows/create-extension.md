<required_reading>
**Read these reference files before proceeding:**
1. references/extension-lifecycle.md
2. references/custom-tools.md (if building tools)
3. references/custom-commands.md (if building commands)
4. references/events-reference.md (if building event hooks)
5. references/key-rules-gotchas.md (always)
</required_reading>

<process>

## Step 1: Determine Scope and Placement

Ask the user:
- **Global** (`~/.pi/agent/extensions/`) — Available in all GSD sessions
- **Project-local** (`.gsd/extensions/`) — Available only in this project

## Step 2: Determine Extension Capabilities

Identify what the extension needs from the user's description:

| Capability | API | When |
|------------|-----|------|
| Custom tool (LLM-callable) | `pi.registerTool()` | LLM needs to perform new actions |
| Slash command | `pi.registerCommand()` | User needs direct actions |
| Event interception | `pi.on("event", ...)` | Block/modify tool calls, inject context, react to lifecycle |
| Custom UI | `ctx.ui.custom()` | Complex interactive displays |
| System prompt modification | `before_agent_start` event | Add per-turn instructions |
| Context filtering | `context` event | Modify messages sent to LLM |
| State persistence | `details` in tool results or `pi.appendEntry()` | Stateful behavior |
| Custom rendering | `renderCall` / `renderResult` | Control how tools appear in TUI |
| Provider management | `pi.registerProvider()` | Custom model endpoints |
| Keyboard shortcut | `pi.registerShortcut()` | Hotkey triggers |

## Step 3: Choose Extension Structure

**Single file** — for small extensions (1-2 tools/commands, simple hooks):
```
~/.pi/agent/extensions/my-extension.ts
```

**Directory with index.ts** — for multi-file extensions:
```
~/.pi/agent/extensions/my-extension/
├── index.ts
├── tools.ts
└── utils.ts
```

**Package with dependencies** — when npm packages are needed:
```
~/.pi/agent/extensions/my-extension/
├── package.json
├── src/index.ts
└── node_modules/
```

For packages, `package.json` needs:
```json
{
  "name": "my-extension",
  "dependencies": { ... },
  "pi": { "extensions": ["./src/index.ts"] }
}
```

## Step 4: Write the Extension

Start with the skeleton:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Register events, tools, commands here
}
```

Then add capabilities based on Step 2. Reference the appropriate reference files for each capability.

**Tool registration pattern:**
```typescript
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does (shown to LLM)",
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),
    text: Type.Optional(Type.String({ description: "Item text" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };
    return {
      content: [{ type: "text", text: "Result for LLM" }],
      details: { data: "for rendering and state" },
    };
  },
});
```

**Command registration pattern:**
```typescript
pi.registerCommand("mycommand", {
  description: "What this command does",
  handler: async (args, ctx) => {
    ctx.ui.notify(`Running with args: ${args}`, "info");
  },
});
```

**Event hook pattern:**
```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
    return { block: true, reason: "Blocked dangerous command" };
  }
});
```

## Step 5: Test the Extension

```bash
# Quick test without installing
gsd -e ./path/to/my-extension.ts

# Or place in extensions dir and reload
/reload
```

Verify:
- Extension loads without errors (check GSD startup output)
- Tools appear when LLM is asked to use them
- Commands respond to `/mycommand`
- Event hooks trigger at expected points

## Step 6: Iterate

Fix issues, add features, refine. Use `/reload` for hot-reload during development.

</process>

<success_criteria>
Extension creation is complete when:
- [ ] Extension file(s) written to correct location
- [ ] All imports resolve (TypeBox, pi-ai, pi-coding-agent, pi-tui as needed)
- [ ] Tools use `StringEnum` for string enums (not `Type.Union`/`Type.Literal`)
- [ ] Tool output is truncated if variable-length
- [ ] State stored in `details` if extension is stateful
- [ ] `ctx.hasUI` checked before dialog methods
- [ ] Extension loads on `/reload` without errors
- [ ] Tools callable by LLM, commands by user
- [ ] Tested with at least one real invocation
</success_criteria>
