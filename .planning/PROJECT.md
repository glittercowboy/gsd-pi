# GSD Mission Control

## What This Is

A locally-run Bun-powered dashboard that gives GSD a visual interface. It reads `.planning/` state files in real time via WebSocket, renders the full project lifecycle across a sidebar + tabbed column layout, provides a context-aware chat layer that spawns Claude Code as a child process with live streaming, supports up to 4 parallel sessions each with git worktree isolation, includes discuss/review interaction modes, and proxies any localhost dev server in a live preview panel. No database, no cloud, no external services — Bun reads the files GSD already writes.

## Core Value

A developer types a natural language message in Mission Control's chat, it routes to Claude Code, code gets written, and the dashboard panels update in real time — the full build loop in one window.

## Requirements

### Validated

<!-- Existing GSD capabilities this project builds on -->

- ✓ `.planning/` file-based state management — existing
- ✓ `gsd-tools.cjs` CLI for all state operations — existing
- ✓ Slash command system with 33 registered commands — existing
- ✓ Phase/milestone lifecycle with roadmap tracking — existing
- ✓ Hook system for Claude Code integration — existing

<!-- v1.0 MVP requirements — all shipped 2026-03-12 -->

- ✓ Bun server with file watcher on `.planning/`, WebSocket push to clients — v1.0
- ✓ Five-panel resizable layout replaced by sidebar + tabbed column layout — v1.0 (Phase 3.1 rewrite)
- ✓ Real-time state derivation from `.planning/` files with diff-only updates — v1.0
- ✓ Chat panel with Claude Code child process spawning and stdout streaming — v1.0
- ✓ Multi-session chat (up to 4 parallel) with git worktree isolation per session — v1.0
- ✓ Hybrid intent classifier (local `/gsd:` detection + Claude API for ambiguous messages) — v1.0
- ✓ Discuss mode with structured question cards, button groups, and decision log — v1.0
- ✓ Review mode with 6-pillar score display and action cards — v1.0
- ✓ Dev server proxy through Bun for live preview iframe — v1.0
- ✓ Viewport switching (Desktop 1440px, Tablet 768px, Mobile 375px, Dual device frames) — v1.0
- ✓ Session start flow with project detection and resume capability — v1.0
- ✓ CSS logo animation (400ms branded build sequence on session start) — v1.0
- ✓ VS Code-style sidebar with project tree, native OS file picker, recent projects — v1.0
- ✓ Live streaming of Claude Code events (tool_use/text/thinking/result) including sub-agents — v1.0
- ✓ Settings panel (two-tier config: global + project) and Project Assets gallery — v1.0
- ✓ Full empty/loading/error state design for every panel — v1.0
- ✓ Keyboard shortcuts and accessibility (44px touch targets, heading hierarchy, command palette) — v1.0

## Current Milestone: v2.0 Native Desktop

**Goal:** Wrap Mission Control in a Tauri 2 native app, migrate all GSD v1 conventions to GSD 2 (`.gsd/`, `gsd` CLI, Pi SDK streaming), add OAuth + keychain, a Builder mode for non-technical users, and ship signed installers for macOS and Windows.

**Target features:**
- GSD 2 compatibility pass (`.gsd/` watcher, new state schema, `gsd` process, command syntax)
- Pi SDK stream parser hardening (structured events, cost tracking, auto mode indicators)
- Slice integration in Milestones view (4 states: Planned / In Progress / Needs Review / Complete)
- Tauri 2 native shell (Bun process management, IPC commands, window state)
- OAuth + OS keychain (Claude Max, GitHub Copilot, OpenRouter, API Key)
- Permission model + trust dialog (replaces raw skip-permissions toggle)
- Builder mode (vocabulary + routing layer for non-technical users)
- Project workspace management (managed workspace, project home screen, multi-session tabs)
- Signed installer + distribution (GitHub Actions CI, auto-update, landing page)

### Active

<!-- v2.0 requirements — see REQUIREMENTS.md -->

### Out of Scope

- D3 force graph for boundary maps — deferred to v3
- Multi-agent lane view — requires GSD 2.0 parallel agent visibility, deferred
- Real-time diff viewer — deferred to v3
- Snapshot/replay timeline — deferred to v3
- Team presence layer — requires shared server or sync protocol design
- Prompt library — V2 community feature
- Visual project analytics — V2 metrics
- Remotion marketing exports (milestone complete, build montage, feature demo) — V2
- GSD 2.0 deterministic tool visibility — requires V2 API coordination with Lex
- Cloud sync, telemetry, or any external data transmission
- Responsive layout with mobile bottom-tab navigation — deprioritized, desktop-first sufficient for v1

## Context

**Shipped v1.0 (2026-03-12):** ~12,744 lines TypeScript/TSX. Bun + React 19 + Tailwind CSS v4 + shadcn/ui. 15 phases (48 plans) over 88 days. 1,163 commits.

**Architecture note:** Original 5-panel resizable layout (Phase 3) was replaced in Phase 3.1 with a sidebar + single-column tabbed view — panels were too narrow for usable content. The sidebar + tabbed column pattern proved extensible through all subsequent phases.

**Multi-session architecture:** Phase 6.3 introduced SessionManager for up to 4 parallel Claude processes. Each session gets its own WebSocket channel, chat history, and optional git worktree. Milestone view splits to show per-session state.

**Streaming pipeline:** Phase 6.2 replaced the simple stdout-capture approach with full event streaming (tool_use, text, thinking, result blocks, sub-agent events) over NDJSON. Server broadcasts these to all connected clients via WebSocket.

**Target audience:** Non-technical and technical GSD builders, solo developers managing multiple milestones, small teams needing shared project visibility. Secondary: Lex Christopherson (TACHES) and GSD Foundation for potential commercial distribution.

## Constraints

- **Runtime**: Bun exclusively for server layer — no Node, no Vite config, single `bun run dev` command
- **Stack**: React 19, TypeScript, Tailwind CSS v4, shadcn/ui — as specified in PRD
- **Performance**: First render under 800ms, file event to panel update under 100ms, chat routing under 200ms
- **Security**: No data leaves local machine. Preview proxy strips credentials. No telemetry without opt-in.
- **Dependencies**: Zero external services in V1. Everything runs locally.
- **Design**: 6-pillar design contract enforced (copywriting, visuals, color, typography, spacing, experience design)
- **Accessibility**: Logical heading hierarchy, accessible names on all interactive elements, 44px touch targets, focus management on panel transitions

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Monorepo workspace structure | Clean separation while sharing repo. GSD core + Mission Control publish independently. | ✓ Good — no conflicts between packages throughout v1.0 |
| Bun as sole runtime | Native file watching, built-in WebSocket, zero-config HTTP server eliminates Node dependency overhead | ✓ Good — single `bun run dev` works, HMR fast |
| Replace 5-panel layout with sidebar + tabs | UAT revealed panels too narrow for content after Phase 3 | ✓ Good — Phase 3.1 replacement scaled cleanly to Phase 6.3 |
| Child process for Claude Code | Full control over stdin/stdout streaming. Direct integration rather than MCP or file-based approach. | ✓ Good — multi-session (Phase 6.3) extended naturally |
| NDJSON streaming over simple stdout capture | Needed to surface sub-agent events and structured tool blocks | ✓ Good — full event visibility in dashboard |
| Hybrid intent classifier | Local `/gsd:` prefix detection handles obvious commands instantly. Claude API only for ambiguous natural language — avoids unnecessary API calls. | ✓ Good — fast routing path confirmed |
| Remotion dropped for CSS animations | Remotion added complexity for Phase 7 logo animation; pure CSS keyframes sufficient | ✓ Good — 400ms CSS animation ships without Remotion dependency |
| SessionManager for multi-session | Phase 6.3 parallelism required a central session registry | ✓ Good — clean abstraction, worktree integration straightforward |
| File-based state only | All state derivable from `.planning/` files. No in-memory state that can drift. Process restart = full reconstruction. | ✓ Good — restarts are clean, no ghost state issues |

---
*Last updated: 2026-03-12 after v2.0 milestone start — ported to GSD 2 fork (gsd-build/gsd-2, branch feat/mission-control-m2)*
