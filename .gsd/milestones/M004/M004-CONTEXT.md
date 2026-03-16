# M004: SQLite Context Store — Surgical Prompt Injection

**Gathered:** 2026-03-15
**Status:** Ready for planning

## Project Description

Port the completed memory-db worktree's SQLite-backed context store into the current GSD codebase. The memory-db work (7 slices, 21 requirements validated, 293 tests) was built against a pre-v2.12.0 codebase that has since diverged significantly — 145 commits on main including auto.ts decomposition, worktree architecture overhaul, and extensive refactoring. This is a port, not a merge.

## Why This Milestone

The current prompt assembly dumps entire files (DECISIONS.md, REQUIREMENTS.md, PROJECT.md) into every dispatch prompt regardless of relevance. On a mature project with 40+ decisions and 30+ requirements, most of that context is irrelevant to the active slice. A SQLite query layer enables surgical injection — only the decisions scoped to this milestone, only the requirements owned by this slice. The user's emphasis: "super fast context ingestion" — the DB is the mechanism for being "very, very surgically" selective about what context each task sees.

## User-Visible Outcome

### When this milestone is complete, the user can:

- Run auto-mode and see ≥30% smaller prompts with only relevant context injected
- Use `gsd_save_decision`, `gsd_update_requirement`, `gsd_save_summary` tool calls that bypass markdown parsing
- Run `/gsd inspect` to see DB state for diagnostics
- Start auto-mode on an existing project and have gsd.db appear silently with all artifacts imported

### Entry point / environment

- Entry point: `/gsd auto` CLI command, structured LLM tools during dispatch, `/gsd inspect` slash command
- Environment: local dev (Node 22.5+, runs in pi agent process)
- Live dependencies involved: none (SQLite is embedded, no external services)

## Completion Class

- Contract complete means: DB opens, queries return scoped data, prompt builders use DB queries, tests pass
- Integration complete means: full auto-mode cycle runs with DB-backed context injection, dual-write keeps markdown in sync, worktree lifecycle copies/reconciles DB
- Operational complete means: existing projects migrate transparently, graceful fallback when SQLite unavailable, token savings measured and ≥30%

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- A full auto-mode dispatch cycle (research → plan → execute → complete) produces correct prompts with scoped context from the DB
- An existing project with markdown artifacts silently migrates to DB on first run with zero data loss
- Token measurement shows ≥30% savings on planning/research units
- The system works identically (via fallback) when SQLite is unavailable
- TypeScript compiles clean, all existing tests pass, new DB test suite passes

## Risks and Unknowns

- `auto-prompts.ts` has 11 prompt builders with 19 `inlineGsdRootFile` calls — rewiring must preserve existing prompt structure and fallback behavior
- `handleAgentEnd` in `auto.ts` has new post-unit-hook machinery since memory-db was built — dual-write re-import must integrate without disrupting hooks/doctor/rebuildState sequence
- `worktree-manager.ts` `createWorktree` is sync on main — DB copy must work synchronously (decision: use `copyFileSync`, keep sync)
- `node:sqlite` is experimental in Node 22 — API could change, but the DbAdapter abstraction insulates against this
- Memory-db's markdown parsers for DECISIONS.md and REQUIREMENTS.md are custom (not using `files.ts`) — must verify they handle current file formats

## Existing Codebase / Prior Art

- `src/resources/extensions/gsd/auto-prompts.ts` — 880 lines, 11 `build*Prompt()` functions, 19 `inlineGsdRootFile` calls. This is where surgical injection happens.
- `src/resources/extensions/gsd/auto-dispatch.ts` — `resolveDispatch()` maps units to prompt builders. Imports from `auto-prompts.ts`.
- `src/resources/extensions/gsd/auto.ts` — `startAuto()`, `handleAgentEnd()`, `dispatchNextUnit()`. DB init/migration goes in startup, re-import in handleAgentEnd.
- `src/resources/extensions/gsd/state.ts` — `deriveState()` — 587 lines. DB-first content loading replaces batch file parse.
- `src/resources/extensions/gsd/metrics.ts` — `UnitMetrics` interface, `snapshotUnitMetrics()`. Add `promptCharCount`/`baselineCharCount`.
- `src/resources/extensions/gsd/worktree-manager.ts` — `createWorktree()` (sync), `mergeWorktreeToMain()`. DB copy/reconcile hooks here.
- `src/resources/extensions/gsd/index.ts` — tool registrations. 3 new structured tools.
- `src/resources/extensions/gsd/commands.ts` — slash command registration. `/gsd inspect`.
- `src/resources/extensions/gsd/types.ts` — needs Decision/Requirement interfaces.
- `.gsd/worktrees/memory-db/` — the source worktree with all memory-db implementation. Reference code lives here.

### Memory-db source modules to port:
- `.gsd/worktrees/memory-db/src/resources/extensions/gsd/gsd-db.ts` — 750 lines, SQLite abstraction layer
- `.gsd/worktrees/memory-db/src/resources/extensions/gsd/context-store.ts` — 195 lines, query layer + formatters
- `.gsd/worktrees/memory-db/src/resources/extensions/gsd/md-importer.ts` — 526 lines, markdown parsers + migration orchestrator
- `.gsd/worktrees/memory-db/src/resources/extensions/gsd/db-writer.ts` — 337 lines, DB→markdown generators + DB-first write helpers
- `.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/` — 13 test files covering all DB capabilities

> See `.gsd/DECISIONS.md` for all architectural and pattern decisions — it is an append-only register; read it during planning, append to it during execution.

## Relevant Requirements

- R045–R057 — all 13 active requirements map to this milestone's 7 slices

## Scope

### In Scope

- SQLite DB layer with tiered provider chain (node:sqlite → better-sqlite3 → null)
- Auto-migration from markdown files to DB
- Surgical prompt injection via DB queries in all prompt builders
- Dual-write keeping markdown and DB in sync (both directions)
- Token measurement with before/after comparison in UnitMetrics
- DB-first state derivation in deriveState()
- Worktree DB copy on creation and merge reconciliation
- 3 structured LLM tools (gsd_save_decision, gsd_update_requirement, gsd_save_summary)
- /gsd inspect slash command
- Full test suite for all DB capabilities

### Out of Scope / Non-Goals

- Vector/embedding search on artifacts (deferred — schema supports future extension)
- DB export/dump command
- Changing file discovery in deriveState (stays on disk)
- Making createWorktree async (keep sync, use copyFileSync for DB copy)

## Technical Constraints

- `node:sqlite` is experimental — use DbAdapter abstraction to insulate
- `node:sqlite` returns null-prototype rows — normalize via spread in DbAdapter
- Named SQL parameters must use colon-prefix (`:id`, `:scope`) for `node:sqlite` compatibility
- `createWorktree` must remain synchronous — no async cascade
- All DB operations must be wrapped in try/catch with fallback to existing behavior
- Memory-db source code is reference — adapt to current architecture, don't copy blindly

## Integration Points

- `auto-prompts.ts` — replace `inlineGsdRootFile` with DB-aware helpers (scoped queries with filesystem fallback)
- `auto.ts` `startAuto()` — DB open + auto-migration before first dispatch
- `auto.ts` `handleAgentEnd()` — re-import markdown after auto-commit (after doctor + rebuildState, before dispatch)
- `metrics.ts` — extend `UnitMetrics` with measurement fields, extend `snapshotUnitMetrics` signature
- `state.ts` `deriveState()` — DB-first content loading with filesystem fallback
- `worktree-manager.ts` `createWorktree()` — sync DB copy after worktree creation
- `worktree-command.ts` / merge paths — DB reconciliation after merge
- `index.ts` — 3 new tool registrations
- `commands.ts` — `/gsd inspect` command registration
- `types.ts` — Decision/Requirement interface additions

## Open Questions

- Whether memory-db's custom DECISIONS.md parser handles the current format (pipe tables with supersession chains) — needs verification during S02 implementation
- Whether current `deriveState()` batch-parse logic is structurally compatible with the DB-first replacement — needs verification during S04
