# What is GSD?

GSD is an AI-powered development agent that turns project ideas into working software. Describe what you want to build, and GSD researches, plans, codes, tests, and commits — with clean git history and full cost tracking.

## How It Works

GSD breaks your project into manageable pieces and works through them systematically:

```
You describe your project
    ↓
GSD creates a milestone with slices (features)
    ↓
Each slice is decomposed into tasks
    ↓
Tasks are executed one at a time in fresh AI sessions
    ↓
Code is committed, verified, and the next task begins
```

You can stay hands-on with **step mode** (reviewing each step) or let GSD run autonomously with **auto mode** while you grab coffee.

## Key Features

- **Autonomous execution** — `/gsd auto` runs research, planning, coding, testing, and committing without intervention
- **20+ LLM providers** — Anthropic, OpenAI, Google, OpenRouter, GitHub Copilot, Amazon Bedrock, local models, and more
- **Git isolation** — Each milestone works in its own worktree branch, merged cleanly when done
- **Cost tracking** — Real-time token usage, budget ceilings, and automatic model downgrading
- **Crash recovery** — Sessions resume automatically after interruptions
- **Skills system** — Domain-specific instruction sets for frameworks, languages, and tools
- **Parallel milestones** — Run multiple milestones simultaneously in isolated worktrees
- **Remote questions** — Get Discord, Slack, or Telegram notifications when GSD needs input
- **Web interface** — Browser-based dashboard with real-time progress
- **VS Code extension** — Chat participant, sidebar dashboard, and full command palette
- **Headless mode** — Run in CI pipelines, cron jobs, and scripted automation

## Quick Start

```bash
# Install
npm install -g gsd-pi

# Launch
gsd

# Start autonomous mode
/gsd auto
```

See [Installation](getting-started/installation.md) for detailed setup instructions.

## Two Ways to Work

| Mode | Command | Best For |
|------|---------|----------|
| **Step** | `/gsd` | Staying in the loop, reviewing each step |
| **Auto** | `/gsd auto` | Walking away, overnight builds, batch work |

The recommended workflow: run auto mode in one terminal, steer from another. See [Step Mode](core-concepts/step-mode.md) and [Auto Mode](core-concepts/auto-mode.md).

## Requirements

- **Node.js** 22.0.0 or later (24 LTS recommended)
- **Git** installed and configured
- An API key for at least one LLM provider (or use browser sign-in for Anthropic/GitHub Copilot)
