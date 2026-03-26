# Getting Started

## Install

```bash
npm install -g gsd-pi
```

Requires Node.js ≥ 22.0.0 (24 LTS recommended) and Git.

> **`command not found: gsd`?** Your shell may not have npm's global bin directory in `$PATH`. Run `npm prefix -g` to find it, then add `$(npm prefix -g)/bin` to your PATH. See [Troubleshooting](./troubleshooting.md#command-not-found-gsd-after-install) for details.

GSD checks for updates once every 24 hours. When a new version is available, you'll see an interactive prompt at startup with the option to update immediately or skip. You can also update from within a session with `/gsd update`.

### Set up API keys

If you use a non-Anthropic model, you'll need a search API key for web search. Run `/gsd config` to set keys globally — they're saved to `~/.gsd/agent/auth.json` and apply to all projects:

```bash
# Inside any GSD session:
/gsd config
```

See [Global API Keys](./configuration.md#global-api-keys-gsd-config) for details on supported keys.

### Set up custom MCP servers

If you want GSD to call local or external MCP servers, add project-local config in `.mcp.json` or `.gsd/mcp.json`.

See [Configuration → MCP Servers](./configuration.md#mcp-servers) for examples and verification steps.

### VS Code Extension

GSD is also available as a VS Code extension. Install from the marketplace (publisher: FluxLabs) or search for "GSD" in VS Code extensions. The extension provides:

- **`@gsd` chat participant** — talk to the agent in VS Code Chat
- **Sidebar dashboard** — connection status, model info, token usage, quick actions
- **Full command palette** — start/stop agent, switch models, export sessions

The CLI (`gsd-pi`) must be installed first — the extension connects to it via RPC.

## First Launch

Run `gsd` in any directory:

```bash
gsd
```

GSD displays a welcome screen showing your version, active model, and available tool keys. Then on first launch, it runs a setup wizard:

1. **LLM Provider** — select from 20+ providers (Anthropic, OpenAI, Google, OpenRouter, GitHub Copilot, Amazon Bedrock, Azure, and more). OAuth flows handle Claude Max and Copilot subscriptions automatically; otherwise paste an API key.
2. **Tool API Keys** (optional) — Brave Search, Context7, Jina, Slack, Discord. Press Enter to skip any.

If you have an existing Pi installation, provider credentials are imported automatically.

Re-run the wizard anytime with:

```bash
gsd config
```

## Choose a Model

GSD auto-selects a default model after login. Switch later with:

```
/model
```

Or configure per-phase models in preferences — see [Configuration](./configuration.md).

## Two Ways to Work

### Step Mode — `/gsd`

Type `/gsd` inside a session. GSD executes one unit of work at a time, pausing between each with a wizard showing what completed and what's next.

- **No `.gsd/` directory** → starts a discussion flow to capture your project vision
- **Milestone exists, no roadmap** → discuss or research the milestone
- **Roadmap exists, slices pending** → plan the next slice or execute a task
- **Mid-task** → resume where you left off

Step mode is the on-ramp. You stay in the loop, reviewing output between each step.

### Auto Mode — `/gsd auto`

Type `/gsd auto` and walk away. GSD autonomously researches, plans, executes, verifies, commits, and advances through every slice until the milestone is complete.

```
/gsd auto
```

See [Auto Mode](./auto-mode.md) for full details.

## Two Terminals, One Project

The recommended workflow: auto mode in one terminal, steering from another.

**Terminal 1 — let it build:**

```bash
gsd
/gsd auto
```

**Terminal 2 — steer while it works:**

```bash
gsd
/gsd discuss    # talk through architecture decisions
/gsd status     # check progress
/gsd queue      # queue the next milestone
```

Both terminals read and write the same `.gsd/` files. Decisions in terminal 2 are picked up at the next phase boundary automatically.

## Project Structure

GSD organizes work into a hierarchy:

```
Milestone  →  a shippable version (4-10 slices)
  Slice    →  one demoable vertical capability (1-7 tasks)
    Task   →  one context-window-sized unit of work
```

The iron rule: **a task must fit in one context window.** If it can't, it's two tasks.

All state lives on disk in `.gsd/`:

```
.gsd/
  PROJECT.md          — what the project is right now
  REQUIREMENTS.md     — requirement contract (active/validated/deferred)
  DECISIONS.md        — append-only architectural decisions
  KNOWLEDGE.md        — cross-session rules, patterns, and lessons
  RUNTIME.md          — runtime context: API endpoints, env vars, services (v2.39)
  STATE.md            — quick-glance status
  milestones/
    M001/
      M001-ROADMAP.md — slice plan with risk levels and dependencies
      M001-CONTEXT.md — scope and goals from discussion
      slices/
        S01/
          S01-PLAN.md     — task decomposition
          S01-SUMMARY.md  — what happened
          S01-UAT.md      — human test script
          tasks/
            T01-PLAN.md
            T01-SUMMARY.md
```

## Resume a Session

```bash
gsd --continue    # or gsd -c
```

Resumes the most recent session for the current directory.

To browse and pick from all saved sessions:

```bash
gsd sessions
```

Shows each session's date, message count, and first-message preview so you can choose which one to resume.

## Next Steps

- [Auto Mode](./auto-mode.md) — deep dive into autonomous execution
- [Configuration](./configuration.md) — model selection, timeouts, budgets
- [Commands Reference](./commands.md) — all commands and shortcuts

## Troubleshooting

### `gsd` command runs `git svn dcommit` instead of GSD

The [oh-my-zsh git plugin](https://github.com/ohmyzsh/ohmyzsh/tree/master/plugins/git) defines `alias gsd='git svn dcommit'`, which shadows the GSD binary.

**Option 1** — Remove the alias in your `~/.zshrc` (add after the `source $ZSH/oh-my-zsh.sh` line):

```bash
unalias gsd 2>/dev/null
```

**Option 2** — Use the alternative binary name:

```bash
gsd-cli
```

Both `gsd` and `gsd-cli` point to the same binary.
