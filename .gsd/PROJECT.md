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
- M003/S01 complete: all 415 upstream commits (v2.12→v2.22.0) merged, all 50 file conflicts resolved, both `npm run build` and `npm run build:web-host` pass. Upstream's new features (workflow visualizer, forensics, capture/triage, dynamic model routing, SQLite context store, branchless worktree architecture, 15+ new /gsd subcommands) are now available in the codebase. Web code has zero import dependencies on GSD extension core modules — only imports from native-git-bridge.ts.
- M003/S02 complete: every `/gsd` subcommand (30 total) dispatches to a defined outcome — 20 open browser surfaces via `gsd-`-prefixed union members, 9 pass through to the bridge, 1 renders inline help. `IMPLEMENTED_BROWSER_COMMAND_SURFACES` expanded from 12 to 32. Contract types, store entries, and placeholder component stubs wired for all surfaces. 118 parity contract tests pass. S03-S07 will replace placeholder content with real surfaces.
- M003/S03 complete: dedicated visualizer page with 7 tabbed sections (Progress, Deps, Metrics, Timeline, Agent, Changes, Export) backed by `/api/visualizer` GET endpoint. VisualizerView component (~700 lines) fetches live data via child-process service layer with Map→Record serialization. Sidebar NavRail "Visualize" entry and `/gsd visualize` dispatch wired via new view-navigate kind and gsd:navigate-view CustomEvent pattern. Both builds pass.
- M003/S04 complete: three diagnostic panels (forensics, doctor, skill-health) with real data via child-process services and API routes. `/api/forensics` GET, `/api/doctor` GET+POST, `/api/skill-health` GET all return structured JSON. ForensicsPanel shows anomalies/units/crash lock, DoctorPanel shows issues with fix actions, SkillHealthPanel shows pass rates/trends/suggestions. Generic `CommandSurfaceDiagnosticsPhaseState<T>` for panel loading state. 28 contract tests pass.
- M003/S05 complete: combined knowledge/captures browser panel with two-tab UI. `/api/knowledge` GET returns parsed KNOWLEDGE.md entries (freeform headings + table rows). `/api/captures` GET returns capture entries with counts; POST validates and resolves captures with field-level errors. KnowledgeCapturesPanel renders Knowledge tab (type badges: rule/pattern/lesson/freeform) and Captures tab (status badges, classification labels, triage action buttons). `/gsd knowledge`, `/gsd capture`, `/gsd triage` all dispatch to real panel. Both builds pass.
- M003/S06 complete: settings command surface shows real model routing config, budget allocation visibility, and effective preferences. `/api/settings-data` GET aggregates 5 upstream modules (preferences, model-router, context-budget, routing-history, metrics) via child-process service. Three panel components: PrefsPanel (mode, token profile, skills, toggles), ModelRoutingPanel (tier assignments, routing flags, history patterns), BudgetPanel (ceiling, enforcement, context budgets, project cost totals with token breakdown). `gsd-prefs` renders all three, `gsd-mode` focuses routing, `gsd-config` focuses budget. Both builds pass.
- M003/S08 complete: systematic parity audit covering all 30 `/gsd` subcommands, dashboard overlay (11 features), 7 visualizer tabs, and 8 interactive flows. S08-PARITY-AUDIT.md documents 12 gaps — 9 intentional scope boundaries (interactive wizards accessible via passthrough), 3 deferred (minor data-visibility items). Test contract aligned: `view-navigate` dispatch kind modeled as first-class, 118/118 parity contract tests pass. Zero stub surfaces remain across all 20 dispatched commands. Both builds pass.

- M003/S09 complete: test suite hardened — unit tests 1197/0, both builds green. dist-redirect.mjs resolver handles /dist/ paths, .tsx transpilation, and extensionless web/ imports. Integration tests fixed: slash-command assertion aligned with S02 dispatch, waitForHttpOk added for runtime host readiness, Terminal component restored to app-shell bottom panel.

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

## Capability Contract

See `.gsd/REQUIREMENTS.md` for the explicit capability contract, requirement status, and coverage mapping.

## Milestone Sequence

- [x] M001: Web mode foundation — Browser-first `gsd --web` is real, integrated, and verified end-to-end.
- [x] M002: Web parity and hardening — Browser daily-use parity, live freshness, recovery diagnostics, and packaged-host hardening proof are complete.
- [x] M003: Upstream sync and full web feature parity — All 415 upstream commits merged, all /gsd subcommands surfaced in browser, 1:1 TUI-web parity audited, test suite green.
- [ ] M004: Web mode documentation and CI/CD integration — Dedicated web mode guide, existing doc updates, and a separate CI job for web host build/tests on Linux and macOS.
- [ ] M005: Light theme with system-aware toggle — Monochrome light theme, OS preference default, NavRail toggle, persistent choice.
