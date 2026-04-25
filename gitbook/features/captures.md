# Captures & Triage

Captures let you fire-and-forget thoughts during auto-mode execution. Instead of pausing auto mode to steer, capture ideas, bugs, or scope changes and let GSD triage them at natural seams between tasks.

## Quick Start

While auto mode is running (or any time):

```
/gsd capture "add rate limiting to the API endpoints"
/gsd capture "the auth flow should support OAuth, not just JWT"
```

Captures are appended to `.gsd/CAPTURES.md` and triaged automatically between tasks.

## How It Works

```
Capture → Triage → Confirm → Resolve → Resume
```

1. **Capture** — your thought is saved with a timestamp
2. **Triage** — between tasks, GSD classifies each capture
3. **Confirm** — you see the proposed resolution and approve or adjust
4. **Resolve** — the resolution is applied
5. **Resume** — auto mode continues

## Classification Types

Each capture is classified into one of five types:

| Type | Meaning | What Happens |
|------|---------|-------------|
| `quick-task` | Small, self-contained fix | Executed immediately |
| `inject` | New task needed in current slice | Task added to active slice |
| `defer` | Important but not urgent | Deferred to roadmap reassessment |
| `replan` | Changes the current approach | Triggers slice replan |
| `note` | Informational, no action needed | Acknowledged, no changes |

Plan-modifying resolutions (inject, replan) require your confirmation.

## Manual Triage

Trigger triage manually at any time:

```
/gsd triage
```

Useful when you've accumulated several captures and want to process them before the next natural seam.

## Dashboard Integration

The progress widget shows a pending capture count badge when captures are waiting for triage.
