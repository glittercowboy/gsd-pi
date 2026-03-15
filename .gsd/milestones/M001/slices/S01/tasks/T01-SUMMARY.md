---
id: T01
parent: S01
milestone: M001
provides:
  - SQLite abstraction layer with provider chain, schema init, typed wrappers
  - Decision and Requirement types in types.ts
key_files:
  - src/resources/extensions/gsd/gsd-db.ts
  - src/resources/extensions/gsd/types.ts
  - src/resources/extensions/gsd/tests/gsd-db.test.ts
key_decisions:
  - D011: Use createRequire(import.meta.url) instead of bare require() for ESM compatibility
patterns_established:
  - Provider abstraction via DbAdapter interface wrapping node:sqlite or better-sqlite3
  - null-prototype row normalization via spread into plain objects
  - Lazy provider loading with loadAttempted flag and cached result
  - Typed wrappers with named parameters (colon-prefixed for node:sqlite)
observability_surfaces:
  - getDbProvider() returns provider name or null
  - isDbAvailable() returns boolean
  - stderr message on provider load failure
  - schema_version table queryable for migration state
  - _getAdapter() for direct inspection in tests
duration: 25m
verification_result: passed
completed_at: 2026-03-14
blocker_discovered: false
---

# T01: SQLite abstraction layer with schema and typed wrappers

**Built SQLite DB module with node:sqlite→better-sqlite3→null provider chain, schema init (3 tables + 2 views), WAL mode, and typed CRUD wrappers — 41 test assertions pass.**

## What Happened

Added `Decision` and `Requirement` interfaces to `types.ts`. Created `gsd-db.ts` with:

1. **Provider chain**: Lazy-loaded via `createRequire(import.meta.url)` (bare `require` unavailable in ESM context under `--experimental-strip-types`). Tries `node:sqlite` first with ExperimentalWarning suppression via `process.emit` override, then `better-sqlite3`, caches result.

2. **DbAdapter abstraction**: Thin wrapper normalizing the API differences — primarily `node:sqlite`'s null-prototype row objects (spread into plain objects via `normalizeRow`). Both providers share `prepare().run/get/all` API so the adapter is ~40 LOC.

3. **Schema init**: Three tables (`schema_version`, `decisions`, `requirements`) and two views (`active_decisions`, `active_requirements`). All DDL wrapped in a transaction with `CREATE TABLE/VIEW IF NOT EXISTS` for idempotency. WAL mode set via PRAGMA before transaction (file-backed only).

4. **Typed wrappers**: `insertDecision`, `insertRequirement`, `getDecisionById`, `getRequirementById`, `getActiveDecisions`, `getActiveRequirements`, `transaction`. Named parameters with colon prefix for node:sqlite compatibility.

5. **Test file**: 10 test blocks, 41 assertions covering schema init, double-init idempotency, insert+get roundtrip, view filtering of superseded rows, WAL mode verification, transaction rollback, and graceful behavior when DB is closed.

## Verification

- `npm run test:unit -- --test-name-pattern "gsd-db"` — **41 passed, 0 failed**
- `npm run test:unit` — **282 passed, 0 failed** (full suite, no regressions)
- Schema creates cleanly on fresh :memory: and file-backed temp DBs
- WAL mode confirmed via `PRAGMA journal_mode` returning 'wal' on file-backed DB
- Superseded rows excluded from view queries (tested with 3 decisions, 2 requirements)
- Transaction rollback verified: insert inside failed transaction not visible after rollback
- Slice-level: `context-store` test pattern matches nothing yet (T02 creates it) — expected partial pass

## Diagnostics

- `getDbProvider()` — returns `'node:sqlite'` on this system (Node 22.20.0)
- `isDbAvailable()` — false until `openDatabase()` called, false after `closeDatabase()`
- Provider load failure writes to stderr: "gsd-db: No SQLite provider available (tried node:sqlite, better-sqlite3)"
- `_getAdapter()` — returns raw DbAdapter or null, for test/debug inspection
- `_resetProvider()` — resets cached provider state for testing

## Deviations

- Used `createRequire(import.meta.url)` instead of bare `require()` — the task plan specified following the `native-parser-bridge.ts` pattern which uses `require()`, but that only works in CJS context. Under `--experimental-strip-types` with the ESM resolve hook, `require` is undefined. Recorded as D011.
- Added `getActiveDecisions()` and `getActiveRequirements()` beyond the plan's explicit wrappers — needed for view query testing and downstream consumption.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/gsd-db.ts` — new: complete DB abstraction module (provider chain, schema init, typed wrappers)
- `src/resources/extensions/gsd/types.ts` — modified: added Decision and Requirement interfaces
- `src/resources/extensions/gsd/tests/gsd-db.test.ts` — new: 10 test blocks, 41 assertions
- `.gsd/milestones/M001/slices/S01/tasks/T01-PLAN.md` — modified: added Observability Impact section
- `.gsd/DECISIONS.md` — appended D011
