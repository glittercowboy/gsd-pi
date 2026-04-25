---
name: create-gsd-extension
description: Create, debug, and iterate on GSD extensions (TypeScript modules that add tools, commands, event hooks, custom UI, and providers to GSD). Use when asked to build an extension, add a tool the LLM can call, register a slash command, hook into GSD events, create custom TUI components, or modify GSD behavior. Triggers on "create extension", "build extension", "add a tool", "register command", "hook into gsd", "custom tool", "gsd plugin", "gsd extension".
---

<essential_principles>

**Extensions are TypeScript modules** that hook into GSD's runtime (built on pi). They export a default function receiving `ExtensionAPI` and use it to subscribe to events, register tools/commands/shortcuts, and interact with the session.

**GSD extension paths (community/user-installed extensions):**
- Global: `~/.pi/agent/extensions/*.ts` or `~/.pi/agent/extensions/*/index.ts`
- Project-local: `.gsd/extensions/*.ts` or `.gsd/extensions/*/index.ts`

Note: `~/.gsd/agent/extensions/` is reserved for bundled extensions synced from the gsd-pi package. Community extensions placed there are silently ignored by the loader.

**The three primitives:**
1. **Events** — Listen and react (`pi.on("event", handler)`). Can block tool calls, modify messages, inject context.
2. **Tools** — Give the LLM new abilities (`pi.registerTool()`). LLM calls them autonomously.
3. **Commands** — Give users slash commands (`pi.registerCommand()`). Users type `/mycommand`.

**Non-negotiable rules:**
- Use `StringEnum` from `@gsd/pi-ai` for string enum params (NOT `Type.Union`/`Type.Literal` — breaks Google's API)
- Truncate tool output to 50KB / 2000 lines max (use `truncateHead`/`truncateTail` from `@gsd/pi-coding-agent`)
- Store stateful tool state in `details` for branching support
- Check `signal?.aborted` in long-running tool executions
- Use `pi.exec()` not `child_process` for shell commands
- Check `ctx.hasUI` before dialog methods (non-interactive modes exist)
- Session control methods (`waitForIdle`, `newSession`, `fork`, `navigateTree`, `reload`) are ONLY available in command handlers — they deadlock in event handlers
- Lines from `render()` must not exceed `width` — use `truncateToWidth()`
- Use theme from callback params, never import directly
- Strip leading `@` from path params in custom tools (some models add it)

**Available imports:**

| Package | Purpose |
|---------|---------|
| `@gsd/pi-coding-agent` | `ExtensionAPI`, `ExtensionContext`, `Theme`, event types, tool utilities, `DynamicBorder`, `BorderedLoader`, `CustomEditor`, `highlightCode` |
| `@sinclair/typebox` | `Type.Object`, `Type.String`, `Type.Number`, `Type.Optional`, `Type.Boolean`, `Type.Array` |
| `@gsd/pi-ai` | `StringEnum` (required for string enums), `Type` re-export |
| `@gsd/pi-tui` | `Text`, `Box`, `Container`, `Spacer`, `Markdown`, `SelectList`, `Input`, `matchesKey`, `Key`, `truncateToWidth`, `visibleWidth` |
| Node.js built-ins | `node:fs`, `node:path`, `node:child_process`, etc. |

</essential_principles>

<routing>
Based on user intent, route to the appropriate workflow:

**Building a new extension:**
- "Create an extension", "build a tool", "I want to add a command" → `workflows/create-extension.md`

**Adding capabilities to an existing extension:**
- "Add a tool to my extension", "add event hook", "add custom rendering" → `workflows/add-capability.md`

**Debugging an extension:**
- "My extension doesn't work", "tool not showing up", "event not firing" → `workflows/debug-extension.md`

**If user intent is clear from context, skip the question and go directly to the workflow.**
</routing>

<reference_index>
All domain knowledge in `references/`:

**Core architecture:** extension-lifecycle.md, events-reference.md
**API surface:** extensionapi-reference.md, extensioncontext-reference.md
**Capabilities:** custom-tools.md, custom-commands.md, custom-ui.md, custom-rendering.md
**Patterns:** state-management.md, system-prompt-modification.md, compaction-session-control.md
**Infrastructure:** model-provider-management.md, remote-execution-overrides.md, packaging-distribution.md, mode-behavior.md
**Spec:** `docs/extension-sdk/manifest-spec.md` — manifest format, tiers, validation
**Testing:** `docs/extension-sdk/testing.md` — mock patterns, test conventions
**SDK:** `docs/extension-sdk/` — the authoritative GSD-2 extension guide
**Gotchas:** key-rules-gotchas.md
</reference_index>

<workflows_index>
| Workflow | Purpose |
|----------|---------|
| create-extension.md | Build a new extension from scratch |
| add-capability.md | Add tools, commands, hooks, UI to an existing extension |
| debug-extension.md | Diagnose and fix extension issues |
</workflows_index>

<success_criteria>
Extension is complete when:
- `extension-manifest.json` exists with accurate `provides` listing all registered tools/commands/hooks/shortcuts
- TypeScript compiles without errors (jiti handles this at runtime)
- Extension loads on GSD startup or `/reload` without errors
- Tools appear in the LLM's system prompt and are callable
- Commands respond to `/command` input
- Event hooks fire at the expected lifecycle points
- Custom UI renders correctly within terminal width
- State persists correctly across session restarts (if stateful)
- Output is truncated to safe limits (if tools produce variable output)
</success_criteria>
