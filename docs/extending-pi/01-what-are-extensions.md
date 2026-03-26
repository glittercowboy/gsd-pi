# What Are Extensions?


Extensions are TypeScript modules that hook into pi's runtime to extend its behavior. They can:

- **Register custom tools** the LLM can call (via `pi.registerTool()`)
- **Intercept and modify events** — block dangerous tool calls, transform user input, inject context
- **Register slash commands** (`/mycommand`) for the user
- **Render custom UI** — dialogs, selectors, games, overlays, custom editors
- **Persist state** across session restarts
- **Control how tool calls and messages appear** in the TUI
- **Modify the system prompt** dynamically per-turn
- **Manage models and providers** — register custom providers, switch models
- **Override built-in tools** — wrap `read`, `bash`, `edit`, `write` with custom logic

**Why this matters:** Extensions are the primary mechanism for customizing pi. They turn pi from a generic coding agent into *your* coding agent — with your guardrails, your tools, your workflow.

---
