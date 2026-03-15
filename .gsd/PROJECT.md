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
- The workspace store now drives real dashboard, roadmap, files, activity, terminal, focused-panel prompt handling, workflow controls, continuity, and recovery surfaces instead of mock data.
- M001 is complete: assembled route/runtime/browser proof is green, the preserved skin is wired to live state/actions, and the milestone-close live browser acceptance bar has been cleared.
- `launchWebMode` now keeps the parent launcher thin by skipping in-memory extension reload in the short-lived parent process, which materially reduced `gsd --web` startup time.
- M002 is in progress, and S01-S03 are complete: browser slash commands now dispatch safely in web mode, current-project session browse/resume/rename flows have a dedicated browser contract, live dashboard/sidebar/roadmap/status surfaces refresh from targeted browser state instead of broad `/api/boot` polling, and the browser now exposes an on-demand recovery diagnostics surface with authoritative retry/resume/auth controls.
- The next slice is S04: run the final assembled `gsd --web` hardening proof for refresh/reopen/interrupted-run scenarios and re-validate the daily-use browser workflow end to end.

## Architecture / Key Patterns

- Node/TypeScript CLI entry in `src/cli.ts`
- Pi coding agent session creation and run modes in `packages/pi-coding-agent`
- Existing RPC transport and extension UI request/response surface
- Existing onboarding/auth flows in `src/onboarding.ts`
- Web mode stays current-project scoped and browser-first
- M001 preserves the existing Next.js skin and proves it live before reconsidering framework/runtime changes
- Thin parent launcher → packaged same-origin host → one project-scoped bridge singleton → shared browser workspace store

## Capability Contract

See `.gsd/REQUIREMENTS.md` for the explicit capability contract, requirement status, and coverage mapping.

## Milestone Sequence

- [x] M001: Web mode foundation — Browser-first `gsd --web` is real, integrated, and verified end-to-end.
- [ ] M002: Web parity and hardening — Close remaining TUI parity gaps, harden continuity/recovery/observability, and finish the browser-first flow for reliable daily use. (S01-S03 complete; S04 next)
