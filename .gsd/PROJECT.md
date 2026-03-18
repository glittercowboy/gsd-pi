# Project

## What This Is

GSD is a Node/TypeScript CLI coding agent that currently launches a Pi/GSD TUI. This project adds a browser-first web mode for GSD using the in-repo web skin at `web/`, turning that skin into a real current-project workspace driven by live GSD state and agent execution.

## Core Value

A user can run `gsd --web`, complete setup, and do the full GSD workflow in a snappy browser workspace without ever touching the TUI.

## Current State

- Core GSD CLI, TUI, onboarding, and RPC mode already exist in this repo.
- `src/cli.ts` has a real `--web` launch path that starts browser mode for the current cwd without opening the TUI.
- `src/web/bridge-service.ts` plus `web/app/api/boot|session/command|session/events` expose a live same-origin browser bridge backed by real GSD session state.
- Browser onboarding is live: required setup blocks the workspace, credentials validate through the browser, and bridge auth refresh keeps the first prompt on the current auth view.
- The workspace store drives real dashboard, roadmap, files, activity, terminal, focused-panel prompt handling, workflow controls, continuity, and recovery surfaces.
- M001 is complete: assembled route/runtime/browser proof is green, the preserved skin is wired to live state/actions.
- M002 is complete: browser slash commands dispatch safely, current-project session browse/resume/rename/fork plus settings/auth/Git/shell controls are browser-native, dashboard/sidebar/roadmap/status/recovery surfaces stay fresh through targeted invalidation-driven updates.
- M003 is complete: all 415 upstream commits (v2.12→v2.22.0) merged, 50 file conflicts resolved, all 30 /gsd subcommands dispatch correctly from the browser (20 surface with real content, 9 passthrough, 1 local help). Dedicated visualizer page with 7 tabs, three diagnostic panels (forensics, doctor, skill-health), combined knowledge/captures page, extended settings surface (model routing, budget, preferences), and 10 remaining command panels — all backed by 14 new API routes using child-process services. Systematic parity audit found 12 gaps (9 intentional scope boundaries, 3 deferred minor items). Test suite green: 1197 unit tests, 27 integration tests, 118 parity contract tests.
- M007 is complete: Chat Mode — consumer-grade chat interface over GSD PTY sessions for non-technical users. PtyChatParser + ANSI stripping, ChatPane/ChatBubble with react-markdown+shiki, TUI select/text/password prompt intercept UI, ActionPanel with animated lifecycle, secondary PTY session management, completion auto-close, session DELETE cleanup.
- M008 is in progress: Web polish — projects page redesign (S01 done), browser update UI (S02 done), theme defaults and color audit (S03 done), remote questions settings (S04 done), remaining: progress bar dynamics + terminal text size (S05).

## Architecture / Key Patterns

- Node/TypeScript CLI entry in `src/cli.ts`
- Pi coding agent session creation and run modes in `packages/pi-coding-agent`
- Existing RPC transport and extension UI request/response surface
- Existing onboarding/auth flows in `src/onboarding.ts`
- Web mode stays current-project scoped and browser-first
- Next.js skin in `web/` wired to live GSD data via same-origin API routes
- Thin parent launcher → packaged same-origin host → one project-scoped bridge singleton → shared browser workspace store
- Browser freshness and recovery use typed invalidation events plus narrow same-origin routes instead of broad `/api/boot` polling
- Upstream decomposed `auto.ts` into focused modules (auto-dispatch, auto-recovery, auto-dashboard, auto-prompts, auto-supervisor, auto-worktree)
- Upstream moved git operations to Rust via git2 crate (`native-git-bridge.ts`)
- Upstream added SQLite-backed context store and metrics ledger
- Child-process pattern (execFile + resolve-ts.mjs) for calling upstream extension modules from Next.js — Turbopack cannot resolve .js→.ts extension imports
- Web code only imports from native-git-bridge.ts — never from GSD extension core modules
- 14 new API routes for upstream feature surfaces (visualizer, forensics, doctor, skill-health, knowledge, captures, settings-data, history, inspect, hooks, export-data, undo, cleanup, steer)
- Theme system via next-themes with CSS custom properties in oklch color space (globals.css `:root` and `.dark` blocks)
- Multi-project workspace with ProjectStoreManager maintaining per-project bridge/store instances

## Capability Contract

See `.gsd/REQUIREMENTS.md` for the explicit capability contract, requirement status, and coverage mapping.

## Milestone Sequence

- [x] M001: Web mode foundation — Browser-first `gsd --web` is real, integrated, and verified end-to-end.
- [x] M002: Web parity and hardening — Browser daily-use parity, live freshness, recovery diagnostics, and packaged-host hardening proof are complete.
- [x] M003: Upstream sync and full web feature parity — All 415 upstream commits merged, all /gsd subcommands surfaced in browser, 1:1 TUI-web parity audited, test suite green.
- [ ] M004: Web mode documentation and CI/CD integration — Dedicated web mode guide, existing doc updates, and a separate CI job for web host build/tests on Linux and macOS.
- [ ] M005: Light theme with system-aware toggle — Monochrome light theme, OS preference default, NavRail toggle, persistent choice.
- [ ] M006: Multi-project workspace — Dev root selection in onboarding, smart project discovery, Projects NavRail tab, multi-bridge registry with background sessions, context-aware launch.
- [x] M007: Chat Mode — Consumer-grade chat interface over GSD PTY sessions for non-technical users.
- [ ] M008: Web Polish — S01 (projects page), S02 (browser update UI), S03 (theme defaults & color audit) complete; remaining: S04 remote questions settings, S05 progress bar & terminal text size.
