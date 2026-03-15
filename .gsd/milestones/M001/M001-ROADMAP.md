# M001: Memory Database — SQLite-Backed Context Store

**Vision:** Replace GSD's markdown-file artifact loading with a SQLite database and typed query layer that selectively injects only the context each dispatch unit needs — delivering ≥30% token savings, eliminating context pollution from superseded/irrelevant data, and enabling structured LLM output that bypasses fragile markdown parsing.

## Success Criteria

- Auto-mode dispatches use DB queries for context injection across all prompt builders
- Existing GSD projects migrate silently to DB on first run with zero data loss
- Planning and research dispatch units show ≥30% fewer tokens on mature projects
- `better-sqlite3` load failure degrades gracefully to markdown loading
- Worktree creation copies gsd.db; worktree merge reconciles rows
- LLM can write decisions/requirements/summaries via structured tool calls
- `/gsd inspect` shows DB state for debugging

## Key Risks / Unknowns

- `better-sqlite3` native addon platform coverage — could fail on exotic setups
- Prompt builder rewiring is high-surface-area (9+ functions, 3800-line file) — subtle bugs possible
- Existing markdown parsers may not capture all structured fields needed for DB rows
- Schema iteration risk as real dispatch patterns reveal missing queries

## Proof Strategy

- `better-sqlite3` platform risk → retire in S01 by proving it loads, creates DB, runs queries on the target platform
- Parser coverage risk → retire in S02 by round-trip testing every artifact type (import → query → compare with original)
- Prompt builder rewiring risk → retire in S03 by running all prompt builders and comparing output with markdown-based originals
- Schema stability risk → retire in S07 by running a full auto-mode cycle on a real project

## Verification Classes

- Contract verification: unit tests for DB layer, importers, query layer, state derivation. Round-trip fidelity tests for migration.
- Integration verification: prompt builders produce equivalent output with DB vs markdown. Full auto-mode cycle completes.
- Operational verification: worktree DB copy/merge works. Graceful fallback works when better-sqlite3 unavailable. Token measurement reports savings.
- UAT / human verification: user runs auto-mode on a real project and confirms output quality is equivalent or better

## Milestone Definition of Done

This milestone is complete only when all are true:

- All prompt builders use DB queries for context injection (no more inlineGsdRootFile for data artifacts)
- Silent auto-migration works on existing GSD projects with all artifact types
- Dual-write keeps markdown files in sync with DB state
- Graceful fallback to markdown when better-sqlite3 unavailable — no crash, transparent degradation
- Token measurement shows ≥30% reduction on planning/research units for mature projects
- deriveState() derives from DB, producing identical GSDState output
- Worktree isolation and merge reconciliation work with row-level conflict detection
- Structured LLM tools eliminate markdown-then-parse roundtrip for decisions/requirements/summaries
- Full auto-mode cycle (research → plan → execute → complete) completes with DB-backed context
- All existing tests continue to pass

## Requirement Coverage

- Covers: R001, R002, R003, R004, R005, R006, R007, R008, R009, R010, R011, R012, R013, R014, R015, R016, R017, R018, R019, R020, R021
- Partially covers: none
- Leaves for later: R030 (vector search), R031 (DB export command)
- Orphan risks: none

## Slices

- [x] **S01: DB Foundation + Decisions + Requirements** `risk:high` `depends:[]`
  > After this: SQLite DB opens with schema, decisions and requirements tables populated, active_decisions and active_requirements views return correct filtered subsets. Graceful fallback tested — system works without better-sqlite3.

- [x] **S02: Markdown Importers + Auto-Migration** `risk:medium` `depends:[S01]`
  > After this: Existing GSD project starts up, gsd.db appears silently with all artifact types imported. Round-trip fidelity verified for every artifact type.

- [x] **S03: Core Hierarchy + Full Query Layer + Prompt Rewiring** `risk:high` `depends:[S01,S02]`
  > After this: All build*Prompt() functions use DB queries instead of inlineGsdRootFile. Dual-write keeps markdown in sync. Prompts contain only relevant context subsets.

- [x] **S04: Token Measurement + State Derivation from DB** `risk:medium` `depends:[S03]`
  > After this: Token counts logged per dispatch unit showing before/after savings. deriveState() reads from DB. Savings ≥30% confirmed on planning/research units with fixture data.

- [x] **S05: Worktree Isolation + Merge Reconciliation** `risk:medium` `depends:[S01,S02]`
  > After this: Worktree creation copies gsd.db. Worktree merge does row-level reconciliation with conflict detection for divergent modifications.

- [x] **S06: Structured LLM Tools + /gsd inspect** `risk:medium` `depends:[S03]`
  > After this: LLM writes decisions/requirements/summaries via lightweight tool calls that write to DB and trigger markdown dual-write. /gsd inspect dumps DB state.

- [x] **S07: Integration Verification + Polish** `risk:low` `depends:[S03,S04,S05,S06]`
  > After this: Full auto-mode cycle runs entirely on DB-backed context. Token savings ≥30% confirmed on real project data. All edge cases (empty projects, partial migrations, fallback mode) verified.

## Boundary Map

### S01 → S02

Produces:
- `gsd-db.ts` → `openDatabase()`, `initSchema()`, `migrateSchema()`, typed insert/query wrappers for decisions and requirements tables
- `context-store.ts` → `queryDecisions(milestoneId?, scope?)`, `queryRequirements(sliceId?, status?)`, format functions for prompt injection
- `active_decisions` SQL view, `active_requirements` SQL view
- Fallback detection: `isDbAvailable()` boolean

Consumes:
- nothing (first slice)

### S01 → S03

Produces:
- `gsd-db.ts` → database open/close, schema init, all table definitions
- `context-store.ts` → decision and requirement query functions + formatters
- Fallback detection for conditional DB vs markdown loading

Consumes:
- nothing (first slice)

### S01 → S05

Produces:
- `gsd-db.ts` → `openDatabase()` for creating/opening DB at arbitrary paths
- Schema init that works on fresh DB files

Consumes:
- nothing (first slice)

### S02 → S03

Produces:
- `md-importer.ts` → importers for all artifact types (decisions, requirements, roadmaps, plans, summaries, contexts, research, continues, queue, secrets, project)
- `migrateFromMarkdown(db, basePath)` — full project import function
- Auto-migration detection and execution on startup

Consumes from S01:
- `gsd-db.ts` → `openDatabase()`, typed insert wrappers
- Schema tables for all artifact types

### S02 → S05

Produces:
- `md-importer.ts` → `migrateFromMarkdown()` for importing markdown into a fresh DB

Consumes from S01:
- `gsd-db.ts` → database layer

### S03 → S04

Produces:
- All `build*Prompt()` functions rewired to use DB queries
- `context-store.ts` → full query functions for all dispatch unit types
- Dual-write logic for markdown sync

Consumes from S01:
- `gsd-db.ts` → database layer, all table schemas
- `context-store.ts` → decision/requirement queries

Consumes from S02:
- `md-importer.ts` → importers for remaining hierarchy tables (milestones, slices, tasks, roadmaps, plans, summaries, contexts, research)

### S03 → S06

Produces:
- `context-store.ts` → complete query layer that structured tools can write to
- Dual-write infrastructure that tools can trigger

Consumes from S01:
- `gsd-db.ts` → typed insert/update wrappers

### S04 → S07

Produces:
- Token measurement infrastructure integrated into metrics
- `deriveState()` reading from DB
- Before/after comparison data

Consumes from S03:
- Rewired prompt builders

### S05 → S07

Produces:
- Worktree DB copy on creation
- Row-level merge reconciliation with conflict detection

Consumes from S01:
- `gsd-db.ts` → `openDatabase()` for worktree DB paths

Consumes from S02:
- `md-importer.ts` → `migrateFromMarkdown()` for fallback import

### S06 → S07

Produces:
- Structured LLM tools registered as extension tools
- `/gsd inspect` slash command

Consumes from S03:
- `context-store.ts` → query layer for inspect output
- Dual-write infrastructure for tool-triggered markdown sync
