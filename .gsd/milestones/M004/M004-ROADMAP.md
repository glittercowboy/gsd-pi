# M004: SQLite Context Store — Surgical Prompt Injection

**Vision:** Replace GSD's whole-file prompt dumps with a SQLite-backed query layer that surgically injects only the context each dispatch unit needs — delivering ≥30% token savings, eliminating context pollution, and enabling structured LLM output that bypasses fragile markdown parsing.

## Success Criteria

- All prompt builders use DB queries for context injection (zero direct `inlineGsdRootFile` for data artifacts in prompt builders)
- Existing GSD projects migrate silently to DB on first run with zero data loss
- Planning and research dispatch units show ≥30% fewer prompt characters on mature projects
- System works identically via fallback when SQLite unavailable — no crash, transparent degradation
- Worktree creation copies gsd.db; worktree merge reconciles rows
- LLM can write decisions/requirements/summaries via structured tool calls
- `/gsd inspect` shows DB state for debugging
- Dual-write keeps markdown files in sync with DB state in both directions
- `deriveState()` reads from DB when available, falls back to filesystem
- All existing tests continue to pass, TypeScript compiles clean

## Key Risks / Unknowns

- `auto-prompts.ts` has 11 prompt builders with 19 `inlineGsdRootFile` calls — rewiring is high-surface-area
- `handleAgentEnd` has new post-unit-hook/doctor/rebuildState machinery — dual-write re-import must integrate cleanly
- Memory-db's custom markdown parsers may not handle format changes since the fork point
- `node:sqlite` is experimental — API stability risk (mitigated by DbAdapter abstraction)

## Proof Strategy

- SQLite provider risk → retire in S01 by proving tiered chain loads and queries on target platform
- Parser/format risk → retire in S02 by round-trip testing every artifact type against current file formats
- Prompt builder rewiring risk → retire in S03 by verifying all 11 builders produce correct output with DB vs markdown
- Worktree integration risk → retire in S05 by testing copy/reconcile against current worktree architecture

## Verification Classes

- Contract verification: unit tests for DB layer, importers, query layer, state derivation, writer, tools. Round-trip fidelity tests for migration.
- Integration verification: prompt builders produce equivalent output with DB vs markdown. Full auto-mode cycle completes. Worktree DB copy/merge works.
- Operational verification: graceful fallback when SQLite unavailable. Token measurement reports savings ≥30%.
- UAT / human verification: user runs auto-mode on a real project and confirms output quality equivalent or better

## Milestone Definition of Done

This milestone is complete only when all are true:

- All prompt builders in `auto-prompts.ts` use DB queries for context injection
- Silent auto-migration works on existing GSD projects with all artifact types
- Dual-write keeps markdown files in sync with DB state (both directions)
- Graceful fallback to markdown when SQLite unavailable
- Token measurement shows ≥30% reduction on planning/research units
- `deriveState()` derives from DB, producing identical GSDState output
- Worktree DB copy and merge reconciliation work with current worktree architecture
- Structured LLM tools registered and functional with DB-first write
- `/gsd inspect` command works
- All existing tests pass, new DB test suite passes, `npx tsc --noEmit` clean
- Success criteria re-checked against live behavior

## Requirement Coverage

- Covers: R045, R046, R047, R048, R049, R050, R051, R052, R053, R054, R055, R056, R057
- Partially covers: none
- Leaves for later: none
- Orphan risks: none

## Slices

- [ ] **S01: DB Foundation + Schema** `risk:high` `depends:[]`
  > After this: SQLite DB opens with tiered provider chain, schema inits with decisions/requirements/artifacts tables plus filtered views, typed CRUD wrappers work, graceful fallback returns empty results when SQLite unavailable. Proven by unit tests against real DB.

- [ ] **S02: Markdown Importers + Auto-Migration** `risk:medium` `depends:[S01]`
  > After this: Existing GSD project with markdown files starts up → gsd.db appears silently with all artifact types imported. Round-trip fidelity proven for every artifact type — import then regenerate produces identical output.

- [ ] **S03: Surgical Prompt Injection + Dual-Write** `risk:high` `depends:[S01,S02]`
  > After this: All 11 `build*Prompt()` functions in `auto-prompts.ts` use scoped DB queries instead of `inlineGsdRootFile`. Decisions filtered by milestone, requirements filtered by slice. Dual-write re-import in `handleAgentEnd` keeps DB in sync after each dispatch unit. Falls back to filesystem when DB unavailable.

- [ ] **S04: Token Measurement + State Derivation** `risk:medium` `depends:[S03]`
  > After this: `promptCharCount`/`baselineCharCount` in UnitMetrics, measurement wired into all `snapshotUnitMetrics` call sites. `deriveState()` reads content from DB when available. Savings ≥30% confirmed on fixture data.

- [ ] **S05: Worktree DB Isolation** `risk:medium` `depends:[S01,S02]`
  > After this: `createWorktree` copies gsd.db to new worktrees (sync, non-fatal). Merge paths reconcile worktree DB rows back via ATTACH DATABASE with conflict detection.

- [ ] **S06: Structured LLM Tools + /gsd inspect** `risk:medium` `depends:[S03]`
  > After this: LLM writes decisions/requirements/summaries via tool calls that write to DB first, then regenerate markdown. `/gsd inspect` dumps schema version, table counts, recent entries.

- [ ] **S07: Integration Verification + Polish** `risk:low` `depends:[S03,S04,S05,S06]`
  > After this: Full auto-mode lifecycle test proves all subsystems compose correctly — migration → scoped queries → formatted prompts → token savings → re-import → round-trip. Edge cases (empty projects, partial migrations, fallback mode) verified. ≥30% savings confirmed on realistic fixture data.

## Boundary Map

### S01 → S02

Produces:
- `gsd-db.ts` → `openDatabase()`, `closeDatabase()`, `initSchema()`, `migrateSchema()`, typed insert/query wrappers for decisions, requirements, artifacts tables
- `gsd-db.ts` → `isDbAvailable()` boolean, `getDbProvider()` provider name
- `gsd-db.ts` → `insertDecision()`, `insertRequirement()`, `insertArtifact()`, `upsertDecision()`, `upsertRequirement()`
- `gsd-db.ts` → `transaction()` wrapper for batch operations
- `context-store.ts` → `queryDecisions(opts?)`, `queryRequirements(opts?)`, `queryArtifact(path)`, `queryProject()`
- `context-store.ts` → `formatDecisionsForPrompt()`, `formatRequirementsForPrompt()`
- `types.ts` → `Decision`, `Requirement` interfaces
- Fallback: all query functions return empty when DB unavailable

Consumes:
- nothing (first slice)

### S01 → S03

Produces:
- Same as S01 → S02 (DB layer + query functions + formatters)
- `isDbAvailable()` for conditional DB vs markdown loading in prompt builders

Consumes:
- nothing (first slice)

### S01 → S05

Produces:
- `gsd-db.ts` → `copyWorktreeDb(srcPath, destPath)` — sync file copy
- `gsd-db.ts` → `reconcileWorktreeDb(mainDbPath, worktreeDbPath)` — ATTACH-based merge
- `openDatabase()` for opening DB at arbitrary paths

Consumes:
- nothing (first slice)

### S02 → S03

Produces:
- `md-importer.ts` → `migrateFromMarkdown(basePath)` — full project import function
- `md-importer.ts` → individual parsers for all artifact types
- Auto-migration detection and execution wired into `startAuto()`

Consumes from S01:
- `gsd-db.ts` → `openDatabase()`, typed insert wrappers, `transaction()`
- Schema tables for all artifact types

### S02 → S05

Produces:
- `md-importer.ts` → `migrateFromMarkdown()` for importing markdown into a fresh worktree DB

Consumes from S01:
- `gsd-db.ts` → database layer

### S03 → S04

Produces:
- All `build*Prompt()` functions rewired to use DB queries
- DB-aware inline helpers: `inlineDecisionsFromDb()`, `inlineRequirementsFromDb()`, `inlineProjectFromDb()`
- Dual-write re-import in `handleAgentEnd`

Consumes from S01:
- `context-store.ts` → query functions and formatters
- `gsd-db.ts` → `isDbAvailable()`

Consumes from S02:
- `md-importer.ts` → `migrateFromMarkdown()` for re-import after auto-commit

### S03 → S06

Produces:
- `context-store.ts` → complete query layer that structured tools can use
- Dual-write infrastructure (re-import pattern)

Consumes from S01:
- `gsd-db.ts` → typed upsert wrappers

### S04 → S07

Produces:
- Token measurement in `UnitMetrics` (`promptCharCount`, `baselineCharCount`)
- `deriveState()` DB-first content loading
- Measurement infrastructure in `dispatchNextUnit`

Consumes from S03:
- Rewired prompt builders

### S05 → S07

Produces:
- `copyWorktreeDb` wired into `createWorktree`
- `reconcileWorktreeDb` wired into merge paths

Consumes from S01:
- `gsd-db.ts` → `copyWorktreeDb()`, `reconcileWorktreeDb()`, `openDatabase()`

Consumes from S02:
- `md-importer.ts` → `migrateFromMarkdown()` for fallback import

### S06 → S07

Produces:
- 3 structured LLM tools registered: `gsd_save_decision`, `gsd_update_requirement`, `gsd_save_summary`
- `/gsd inspect` slash command with autocomplete

Consumes from S03:
- `context-store.ts` → query layer for inspect output
- Dual-write infrastructure for tool-triggered markdown regeneration

Consumes from S01:
- `gsd-db.ts` → `upsertDecision()`, `upsertRequirement()`, `insertArtifact()`
- `db-writer.ts` → `generateDecisionsMd()`, `generateRequirementsMd()`, DB-first write helpers
