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
- S07 is complete: route-level assembled lifecycle coverage proves boot → onboard → prompt → streaming text → tool execution → blocking UI request → UI response → turn boundary through the real web routes, and full web-mode regression is green (`web-state-surfaces-contract`, 59-test contract regression, 5-test integration regression, `npm run build:web-host`).
- `launchWebMode` now keeps the parent launcher thin by skipping in-memory extension reload in the short-lived parent process, which materially reduced `gsd --web` startup time during regression work.
- M001 implementation is complete in automation. The remaining milestone-close step is the live manual browser UAT in `.gsd/milestones/M001/slices/S07/S07-UAT.md`.

## Architecture / Key Patterns

- Node/TypeScript CLI entry in `src/cli.ts`
- Pi coding agent session creation and run modes in `packages/pi-coding-agent`
- Existing RPC transport and extension UI request/response surface
- Existing onboarding/auth flows in `src/onboarding.ts`
- Web mode stays current-project scoped and browser-first
- M001 preserves the existing Next.js skin and proves it live before reconsidering framework/runtime changes

## Capability Contract

See `.gsd/REQUIREMENTS.md` for the explicit capability contract, requirement status, and coverage mapping.

## Milestone Sequence

- [ ] M001: Web mode foundation — All slices S01-S07 are complete and automated assembly proof is green; final live browser UAT remains before milestone close.
- [ ] M002: Web parity and hardening — Close remaining TUI parity gaps, harden continuity/recovery/observability, and finish the browser-first flow for reliable daily use.
