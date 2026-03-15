---
id: S01
parent: M001
milestone: M001
provides:
  - SQLite abstraction layer with node:sqlite → better-sqlite3 → null provider chain
  - Schema init with decisions, requirements, schema_version tables and active_* views
  - WAL mode on file-backed databases
  - Typed CRUD wrappers for decisions and requirements
  - queryDecisions(milestoneId?, scope?) and queryRequirements(sliceId?, status?) query functions
  - formatDecisionsForPrompt() and formatRequirementsForPrompt() markdown formatters
  - isDbAvailable() and getDbProvider() for downstream fallback detection
  - DB sidecar gitignore patterns
requires: []
affects:
  - S02
  - S03
  - S05
key_files:
  - src/resources/extensions/gsd/gsd-db.ts
  - src/resources/extensions/gsd/context-store.ts
  - src/resources/extensions/gsd/types.ts
  - src/resources/extensions/gsd/gitignore.ts
  - src/resources/extensions/gsd/tests/gsd-db.test.ts
  - src/resources/extensions/gsd/tests/context-store.test.ts
key_decisions:
  - "D010: node:sqlite → better-sqlite3 → null tiered fallback (amends D001)"
  - "D011: createRequire(import.meta.url) for ESM compatibility instead of bare require()"
  - "Query functions silently catch all exceptions and return [] — SQL errors won't crash prompt injection"
patterns_established:
  - DbAdapter interface wrapping provider differences (null-prototype row normalization, parameter binding)
  - Lazy provider loading with loadAttempted flag and cached result
  - Typed wrappers with named colon-prefixed parameters for node:sqlite compatibility
  - Query functions guard with isDbAvailable() + try/catch, return typed empty results on failure
  - Format functions are pure transforms — empty input yields empty string
observability_surfaces:
  - "getDbProvider() returns 'node:sqlite' | 'better-sqlite3' | null"
  - "isDbAvailable() returns boolean — false until openDatabase(), false after closeDatabase()"
  - "stderr message on provider load failure"
  - "schema_version table queryable for migration state"
  - "_getAdapter() for raw DbAdapter access in tests/debugging"
drill_down_paths:
  - .gsd/milestones/M001/slices/S01/tasks/T01-SUMMARY.md
  - .gsd/milestones/M001/slices/S01/tasks/T02-SUMMARY.md
duration: 40m
verification_result: passed
completed_at: 2026-03-14
---

# S01: DB Foundation + Decisions + Requirements

**SQLite DB abstraction with provider chain, schema (3 tables + 2 views), typed CRUD, query layer with filtered views, markdown formatters, graceful fallback, and DB sidecar gitignore — 88 test assertions pass including sub-5ms query timing.**

## What Happened

T01 built the SQLite abstraction layer in `gsd-db.ts`. Provider chain tries `node:sqlite` first (available on Node 22.20.0 via `DatabaseSync`), falls back to `better-sqlite3`, then to null. Uses `createRequire(import.meta.url)` for ESM-compatible loading since bare `require()` is unavailable under `--experimental-strip-types`. A thin `DbAdapter` interface (~40 LOC) normalizes API differences — primarily `node:sqlite`'s null-prototype row objects which need spreading into plain objects. Schema init creates `schema_version`, `decisions`, and `requirements` tables plus `active_decisions` and `active_requirements` views (filtering `WHERE superseded_by IS NULL`). WAL mode enabled via PRAGMA on file-backed databases. Typed wrappers provide `insertDecision`, `insertRequirement`, `getDecisionById`, `getRequirementById`, `getActiveDecisions`, `getActiveRequirements`, and `transaction`.

T02 built the query layer in `context-store.ts`. `queryDecisions` supports optional `milestoneId` (LIKE on `when_context`) and `scope` (exact match) filters. `queryRequirements` supports `sliceId` (LIKE on `primary_owner` OR `supporting_slices`) and `status` (exact match) filters. Both query against the tables directly with `superseded_by IS NULL` in the WHERE clause. Format functions produce prompt-injectable markdown: decisions as a table matching DECISIONS.md format, requirements as H3 sections with structured bullet fields (omitting empty optional fields). All query/format functions degrade gracefully — `isDbAvailable()` check plus try/catch means DB being closed or unavailable never throws. Added `.gsd/gsd.db`, `.gsd/gsd.db-wal`, `.gsd/gsd.db-shm` to `BASELINE_PATTERNS` in `gitignore.ts`.

## Verification

- `npm run test:unit -- --test-name-pattern "gsd-db"` — 41 assertions pass (schema init, double-init idempotency, insert+get roundtrip, view filtering of superseded rows, WAL mode, transaction rollback, graceful close behavior)
- `npm run test:unit -- --test-name-pattern "context-store"` — 47 assertions pass (active decision/requirement queries, milestone/scope/slice/status filtering, format output structure, superseded row exclusion, fallback returns empty, sub-5ms timing with 50+50 rows, gitignore patterns)
- Full test suite: 283 tests pass, 0 fail — no regressions
- Sub-5ms query timing: 50 decisions + 50 requirements queried in 0.62ms

## Requirements Advanced

- R001 — SQLite DB layer with schema versioning: DB opens, schema inits with version table, typed wrappers work. Full foundation in place.
- R002 — Graceful fallback: all query/format functions return empty results when DB unavailable, no crash path exists.
- R005 — Selective context queries for decisions: queryDecisions with milestone and scope filters against active view, superseded rows excluded.
- R006 — Selective context queries for requirements: queryRequirements with slice and status filters, superseded rows excluded.
- R017 — Sub-5ms query latency: proven at 0.62ms for 100 rows.
- R020 — WAL mode enabled: confirmed via PRAGMA on file-backed DB.
- R021 — Schema designed for future vector search: decisions use auto-increment `seq` PK, requirements use stable `id` PK — both joinable by future embedding tables.

## Requirements Validated

- R017 — Sub-5ms query latency: 0.62ms measured with 100 rows, well under 5ms threshold. Test assertion enforces this.
- R020 — WAL mode enabled: PRAGMA journal_mode returns 'wal' on file-backed DB. Test assertion confirms.
- R021 — Schema designed for future vector search: PKs are auto-increment seq (decisions) and stable id (requirements). Schema structure verified in tests.

## New Requirements Surfaced

- none

## Requirements Invalidated or Re-scoped

- none

## Deviations

- D011: Used `createRequire(import.meta.url)` instead of bare `require()` following `native-parser-bridge.ts` pattern. The ESM context under `--experimental-strip-types` makes `require` undefined. Not a plan deviation in spirit — same lazy-loading pattern, different mechanism.
- Added `getActiveDecisions()` and `getActiveRequirements()` beyond the explicit plan — needed for view query testing and downstream consumption. Additive, no conflict.

## Known Limitations

- Query functions silently swallow SQL errors (return `[]`). This is intentional for prompt injection safety but means SQL bugs in future query additions won't surface unless you use `_getAdapter()` directly. Acceptable tradeoff for S01; may revisit if debugging becomes painful.
- No runtime hookup yet — `gsd-db.ts` and `context-store.ts` are standalone modules consumed by S02/S03, not wired into the dispatch pipeline.

## Follow-ups

- none — all planned work completed, downstream work is in S02+.

## Files Created/Modified

- `src/resources/extensions/gsd/gsd-db.ts` — new: SQLite abstraction with provider chain, schema init, typed wrappers
- `src/resources/extensions/gsd/context-store.ts` — new: query layer with filtered queries and markdown formatters
- `src/resources/extensions/gsd/types.ts` — modified: added Decision and Requirement interfaces
- `src/resources/extensions/gsd/gitignore.ts` — modified: added DB sidecar patterns to BASELINE_PATTERNS
- `src/resources/extensions/gsd/tests/gsd-db.test.ts` — new: 10 test blocks, 41 assertions
- `src/resources/extensions/gsd/tests/context-store.test.ts` — new: 47 assertions
- `.gsd/DECISIONS.md` — appended D011

## Forward Intelligence

### What the next slice should know
- `node:sqlite` is the active provider on Node 22.20.0 — `better-sqlite3` path is untested in this environment. If S02 importers need provider-specific behavior, test with `_resetProvider()` to force the fallback chain.
- Named parameters use colon-prefix (`:id`, `:scope`) for `node:sqlite` compatibility. All new SQL must follow this pattern.
- `queryDecisions` and `queryRequirements` query the raw tables with `superseded_by IS NULL` in the WHERE clause, not the views. This is equivalent but means the views are currently only useful for direct SQL inspection.

### What's fragile
- `DbAdapter` null-prototype normalization — `node:sqlite` returns rows with `Object.create(null)` prototype. The `normalizeRow` spread works but any code that does `row instanceof Object` or `row.hasOwnProperty()` will fail on unnormalized rows. All access must go through the adapter.
- ExperimentalWarning suppression via `process.emit` override — works but is a monkey-patch. If Node changes the warning emission mechanism, the suppression breaks (cosmetic only, no functional impact).

### Authoritative diagnostics
- `getDbProvider()` — tells you which SQLite backend loaded. If it returns `null`, the DB layer is completely unavailable.
- `isDbAvailable()` — tells you if a DB is currently open and usable. False before `openDatabase()` and after `closeDatabase()`.
- Full test suite (`npm run test:unit`) — 283 tests, the definitive regression check.

### What assumptions changed
- Original D001 assumed `better-sqlite3` as the sole provider — D010 amended this to a tiered chain with `node:sqlite` preferred. The abstraction layer makes this transparent to consumers but importers (S02) should be aware both providers exist.
- ESM module loading required `createRequire` instead of bare `require` — any future lazy-loaded native modules in the GSD extension should follow the same pattern (D011).
