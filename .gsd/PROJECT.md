# GSD Agency Upgrade: Evidence-Closed Autonomy

## What This Is

An upgrade to GSD's autonomy layer that converts prompt-suggested quality loops into mechanically enforced, evidence-producing gates. The existing substrate — post-unit hooks, dispatch rules, preferences, recovery gates, browser tools, bg-shell — is strong. The limiting factor is that nothing *forces* verification before marking done. This upgrade closes that gap.

The upgrade is not "give the agent more raw power." It's converting existing powers into mandatory, composable, evidence-producing loops. A unit is done when GSD has machine-readable proof that required checks passed — not because the agent said so.

## Core Value

Every task completion requires structured, machine-queryable proof that verification passed. No prose-only completion. No skipped checks. No "it looks right."

## Current State

GSD v2.24.0 — a mature TypeScript monorepo (npm workspaces: `pi-agent-core`, `pi-coding-agent`, `pi-ai`, `pi-tui`, `native`). The GSD extension lives at `src/resources/extensions/gsd/` with ~100 source files covering auto-mode dispatch, hooks, recovery, supervision, preferences, git service, and file parsing. Browser tools are a separate extension at `src/resources/extensions/browser-tools/`.

Key existing infrastructure:
- `post-unit-hooks.ts` — hook engine with queue, cycles, retry_on, artifacts, pre-dispatch interception
- `auto-dispatch.ts` — declarative phase→unit dispatch rules
- `auto-recovery.ts` — artifact resolution, skip logic, loop remediation
- `auto-supervisor.ts` — SIGTERM handling + working-tree activity detection (minimal)
- `preferences.ts` — typed preference loading with validation
- `observability-validator.ts` — validates summary/plan structure
- `files.ts` — parsers for roadmap, plan, summary, UAT (with UatType union)
- Browser tools — comprehensive primitive set (navigate, click, assert, batch, diff, forms, flow, refs, etc.)

## Architecture / Key Patterns

- TypeScript (ESM, Node ≥20.6), npm workspaces
- Extension-based architecture: GSD extension registers commands, hooks, and dispatch rules
- Post-unit hooks are user-configured via `preferences.md` YAML blocks
- Auto-mode dispatch is a declarative rule table evaluated in order (first match wins)
- Git isolation via worktrees, branches, or none (preference-controlled)
- Builds: `npm run build` (tsc + resource copy), Tests: `npm test` (unit + integration)

## Capability Contract

See `.gsd/REQUIREMENTS.md` for the explicit capability contract, requirement status, and coverage mapping.

## Milestone Sequence

- 🔄 M001: Verification Enforcement — S01 complete (gate fires, commands discovered, 28 tests). S02 complete (evidence JSON + markdown table, validator enforcement, 15 tests). S03 complete (auto-fix retry loop, 2 retries with failure context injection, 8 new tests). S04 complete (runtime error capture, bg-shell crash detection + browser console capture, 20 new tests). S05 remaining.
- [ ] M002: Executable UAT — eliminate human pauses for automatable checks
- [ ] M003: Operational Automation — git push, draft PR, deploy+verify with Vercel
- [ ] M004: Supervisor Upgrade — bounded diagnostic reasoning for failure recovery
