# Web Interface

> Added in v2.41.0

GSD includes a browser-based web interface for project management, real-time progress monitoring, and multi-project support.

## Quick Start

```bash
pi --web
```

This starts a local web server and opens the GSD dashboard in your default browser.

## Features

- **Project management** — view milestones, slices, and tasks in a visual dashboard
- **Real-time progress** — server-sent events push status updates as auto-mode executes
- **Multi-project support** — manage multiple projects from a single browser tab via `?project=` URL parameter
- **Onboarding flow** — API key setup and provider configuration through the browser
- **Model selection** — switch models and providers from the web UI

## Architecture

The web interface is built with Next.js and communicates with the GSD backend via a bridge service. Each project gets its own bridge instance, providing isolation for concurrent sessions.

Key components:
- `ProjectBridgeService` — per-project command routing and SSE subscription
- `getProjectBridgeServiceForCwd()` — registry returning distinct instances per project path
- `resolveProjectCwd()` — reads `?project=` from request URL or falls back to `GSD_WEB_PROJECT_CWD`

## Configuration

The web server binds to `localhost` by default. No additional configuration is required.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `GSD_WEB_PROJECT_CWD` | Default project path when `?project=` is not specified |

## Platform Notes

- **Windows**: The web build is skipped on Windows due to Next.js webpack EPERM issues with system directories. The CLI remains fully functional.
- **macOS/Linux**: Full support.
