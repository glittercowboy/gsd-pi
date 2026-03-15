# GSD Memory Database

## What This Is

A SQLite-backed context store that replaces GSD's markdown-file artifact loading with selective, context-aware queries. Each dispatch unit gets only the data it needs — active decisions scoped to the current milestone, requirements mapped to the current slice, forward intelligence from dependency summaries — instead of loading entire markdown files into every prompt.

## Core Value

Selective context injection: the TS system becomes the context curator, using its knowledge of the current milestone/slice/task/phase to query structured data and build minimal, precise prompts.

## Current State

All 7 slices complete. M001 is fully verified at the integration level with 288 tests passing and 21/21 requirements validated.

Key capabilities delivered:
- All 9 prompt builders rewired from `inlineGsdRootFile` to scoped DB queries
- Token measurement wired into all dispatch paths — fixture-proven ≥30% savings (42.4% lifecycle, 52.2% plan-slice, 66.3% decisions-only, 32.2% research composite)
- deriveState() reads from DB with filesystem fallback
- Worktree creation copies gsd.db; worktree merge reconciles rows via ATTACH DATABASE with conflict detection
- Three structured LLM tools (gsd_save_decision, gsd_update_requirement, gsd_save_summary) registered with DB-first write and markdown dual-write
- /gsd inspect slash command provides DB state diagnostics
- 83 integration assertions prove full subsystem composition across 4 module boundaries and 3 edge cases
- Graceful fallback to markdown loading when better-sqlite3/node:sqlite unavailable

## Architecture / Key Patterns

- **DB layer** (`gsd-db.ts`): SQLite via node:sqlite → better-sqlite3 → null (tiered fallback), sync API, schema versioning, WAL mode
- **Query layer** (`context-store.ts`): typed queries that return only relevant subsets for each dispatch unit type
- **Import layer** (`md-importer.ts`): parsers for DECISIONS.md and REQUIREMENTS.md formats, plus hierarchy artifact import
- **Write layer** (`db-writer.ts`): DB→markdown generators and DB-first write helpers for structured tool output
- **Dual-write**: markdown files continue to be written alongside DB for human readability and rollback
- **Graceful fallback**: if SQLite unavailable, system falls back to current markdown loading transparently
- **Structured LLM tools**: gsd_save_decision, gsd_update_requirement, gsd_save_summary — write to DB, trigger markdown dual-write
- **Diagnostics**: /gsd inspect dumps schema version, table counts, recent entries
- Lives at `.gsd/gsd.db`, gitignored (derived local state)

## Capability Contract

See `.gsd/REQUIREMENTS.md` for the explicit capability contract, requirement status, and coverage mapping.

## Milestone Sequence

- [x] M001: Memory Database — SQLite-backed context store with selective injection, full prompt rewiring, and structured LLM tools (21 requirements validated)
