# Captures & Triage

*Introduced in v2.19.0*

Captures let you fire-and-forget thoughts during auto-mode execution. Instead of pausing auto-mode to steer, you can capture ideas, bugs, or scope changes and let GSD triage them at natural seams between tasks.

## Quick Start

While auto-mode is running (or any time):

```
/gsd capture "add rate limiting to the API endpoints"
/gsd capture "the auth flow should support OAuth, not just JWT"
```

Captures are appended to `.gsd/CAPTURES.md` and triaged automatically between tasks.

## How It Works

### Pipeline

```
capture → triage → confirm → resolve → resume
```

1. **Capture** — `/gsd capture "thought"` appends to `.gsd/CAPTURES.md` with a timestamp and unique ID
2. **Triage** — at natural seams between tasks (in `handleAgentEnd`), GSD detects pending captures and classifies them
3. **Confirm** — the user is shown the proposed resolution and confirms or adjusts
4. **Resolve** — the resolution is applied (task injection, replan trigger, deferral, etc.)
5. **Resume** — auto-mode continues

### Classification Types

Each capture is classified into one of five types:

| Type | Meaning | Resolution |
|------|---------|------------|
| `quick-task` | Small, self-contained fix | Inline quick task executed immediately |
| `inject` | New task needed in current slice | Task injected into the active slice plan |
| `defer` | Important but not urgent | Deferred to roadmap reassessment |
| `replan` | Changes the current approach | Triggers slice replan with capture context |
| `note` | Informational, no action needed | Acknowledged, no plan changes |

### Automatic Triage

Triage fires automatically between tasks during auto-mode. The triage prompt receives:
- All pending captures
- The current slice plan
- The active roadmap

The LLM classifies each capture and proposes a resolution. Plan-modifying resolutions (inject, replan) require user confirmation.

### Manual Triage

Trigger triage manually at any time:

```
/gsd triage
```

This is useful when you've accumulated several captures and want to process them before the next natural seam.

## Dashboard Integration

The progress widget shows a pending capture count badge when captures are waiting for triage. This is visible in both the `Ctrl+Alt+G` dashboard and the auto-mode progress widget.

## Context Injection

Capture context is automatically injected into:
- **Replan-slice prompts** — so the replan knows what triggered it
- **Reassess-roadmap prompts** — so deferred captures influence roadmap decisions

## Worktree Awareness

Captures always resolve to the **original project root's** `.gsd/CAPTURES.md`, not the worktree's local copy. This ensures captures from a steering terminal are visible to the auto-mode session running in a worktree.

## Commands

| Command | Description |
|---------|-------------|
| `/gsd capture "text"` | Capture a thought (quotes optional for single words) |
| `/gsd triage` | Manually trigger triage of pending captures |
