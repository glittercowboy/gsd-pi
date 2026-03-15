# GSD Memory Database

## What This Is

A SQLite-backed context store that replaces GSD's markdown-file artifact loading with selective, context-aware queries. Each dispatch unit gets only the data it needs — active decisions scoped to the current milestone, requirements mapped to the current slice, forward intelligence from dependency summaries — instead of loading entire markdown files into every prompt.

## Core Value

Selective context injection: the TS system becomes the context curator, using its knowledge of the current milestone/slice/task/phase to query structured data and build minimal, precise prompts.

## Current State

S01–S06 complete. All 9 prompt builders rewired from `inlineGsdRootFile` to scoped DB queries. Token measurement wired into all dispatch paths. deriveState() reads from DB with filesystem fallback. Worktree creation copies gsd.db; worktree merge reconciles rows via ATTACH DATABASE with conflict detection. Three structured LLM tools (gsd_save_decision, gsd_update_requirement, gsd_save_summary) registered with DB-first write and markdown dual-write. /gsd inspect slash command provides DB state diagnostics. Fixture-proven ≥30% character savings: 52.2% plan-slice, 66.3% decisions-only, 32.2% research composite. 288 tests pass, 0 failures. 19 of 21 requirements validated.

S07 (Integration Verification + Polish) is next — the final slice, which runs a full auto-mode cycle on DB-backed context and verifies all edge cases.

## Architecture / Key Patterns

- **DB layer** (`gsd-db.ts`): SQLite via `better-sqlite3`, sync API, schema versioning, WAL mode
- **Query layer** (`context-store.ts`): typed queries that return only relevant subsets for each dispatch unit type
- **Import layer** (`md-importer.ts`): reuses existing parsers from `files.ts` to migrate markdown → DB rows
- **Write layer** (`db-writer.ts`): DB→markdown generators and DB-first write helpers for structured tool output
- **Dual-write**: markdown files continue to be written alongside DB for human readability and rollback
- **Graceful fallback**: if `better-sqlite3` fails to load, system falls back to current markdown loading
- **Structured LLM tools**: gsd_save_decision, gsd_update_requirement, gsd_save_summary — write to DB, trigger markdown dual-write
- **Diagnostics**: /gsd inspect dumps schema version, table counts, recent entries
- Lives at `.gsd/gsd.db`, gitignored (derived local state)

## Capability Contract

See `.gsd/REQUIREMENTS.md` for the explicit capability contract, requirement status, and coverage mapping.

## Milestone Sequence

- [ ] M001: Memory Database — SQLite-backed context store with selective injection, full prompt rewiring, and structured LLM tools
