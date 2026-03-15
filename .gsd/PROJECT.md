# GSD Memory Database

## What This Is

A SQLite-backed context store that replaces GSD's markdown-file artifact loading with selective, context-aware queries. Each dispatch unit gets only the data it needs — active decisions scoped to the current milestone, requirements mapped to the current slice, forward intelligence from dependency summaries — instead of loading entire markdown files into every prompt.

## Core Value

Selective context injection: the TS system becomes the context curator, using its knowledge of the current milestone/slice/task/phase to query structured data and build minimal, precise prompts.

## Current State

S01 (DB Foundation + Decisions + Requirements) is complete. The SQLite abstraction layer (`gsd-db.ts`) and context store query layer (`context-store.ts`) are built, tested (88 assertions), and ready for consumption by downstream slices. Provider chain uses `node:sqlite` on Node 22+, falls back to `better-sqlite3`, then null. Schema has `decisions`, `requirements`, and `schema_version` tables with `active_decisions` and `active_requirements` views. Typed CRUD wrappers, filtered query functions, and markdown formatters are all in place. Graceful fallback ensures no crash when DB unavailable. DB sidecar files gitignored.

## Architecture / Key Patterns

- **DB layer** (`gsd-db.ts`): SQLite via `better-sqlite3`, sync API, schema versioning, WAL mode
- **Query layer** (`context-store.ts`): typed queries that return only relevant subsets for each dispatch unit type
- **Import layer** (`md-importer.ts`): reuses existing parsers from `files.ts` to migrate markdown → DB rows
- **Dual-write**: markdown files continue to be written alongside DB for human readability and rollback
- **Graceful fallback**: if `better-sqlite3` fails to load, system falls back to current markdown loading
- **Structured LLM tools**: lightweight tool calls for decisions/requirements/summaries to eliminate markdown roundtrip
- Lives at `.gsd/gsd.db`, gitignored (derived local state)

## Capability Contract

See `.gsd/REQUIREMENTS.md` for the explicit capability contract, requirement status, and coverage mapping.

## Milestone Sequence

- [ ] M001: Memory Database — SQLite-backed context store with selective injection, full prompt rewiring, and structured LLM tools
