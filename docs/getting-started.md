# Getting Started

## Install

```bash
npm install -g gsd-pi
```

Requires Node.js ≥ 20.6.0 (22+ recommended) and Git.

## First Launch

Run `gsd` in any directory:

```bash
gsd
```

On first launch, GSD runs a setup wizard:

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

## Next Steps

- [Auto Mode](./auto-mode.md) — deep dive into autonomous execution
- [Configuration](./configuration.md) — model selection, timeouts, budgets
- [Commands Reference](./commands.md) — all commands and shortcuts
