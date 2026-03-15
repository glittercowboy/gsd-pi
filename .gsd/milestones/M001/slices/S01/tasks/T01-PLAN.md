---
estimated_steps: 8
estimated_files: 3
---

# T01: SQLite abstraction layer with schema and typed wrappers

**Slice:** S01 — DB Foundation + Decisions + Requirements
**Milestone:** M001

## Description

Create the foundational SQLite database module (`gsd-db.ts`) with a provider abstraction that tries `node:sqlite` first, falls back to `better-sqlite3`, and exposes a unified sync API. Define the schema (schema_version, decisions, requirements tables + active views), enable WAL mode, and provide typed insert/query wrappers. Add `Decision` and `Requirement` types to `types.ts`.

## Steps

1. Add `Decision` type to `types.ts` — fields: `seq` (number, auto), `id` (string, e.g. "D001"), `when_context` (string), `scope` (string), `decision` (string), `choice` (string), `rationale` (string), `revisable` (string), `superseded_by` (string | null)
2. Add `Requirement` type to `types.ts` — fields: `id` (string, e.g. "R001"), `class` (string), `status` (string), `description` (string), `why` (string), `source` (string), `primary_owner` (string), `supporting_slices` (string), `validation` (string), `notes` (string), `full_content` (string), `superseded_by` (string | null)
3. Create `gsd-db.ts` — implement provider loading following the `native-parser-bridge.ts` pattern: lazy load with `loadAttempted` flag, try `require('node:sqlite')` (suppressing ExperimentalWarning), then `require('better-sqlite3')`, cache result. Expose `getDbProvider()` returning `'node:sqlite' | 'better-sqlite3' | null`.
4. Implement `openDatabase(path)` — creates/opens SQLite DB at path, sets `PRAGMA journal_mode=WAL` (file-backed only), runs schema init. Returns boolean success. Implement `closeDatabase()`. Implement `isDbAvailable()`.
5. Schema init — `schema_version` table (version INTEGER, applied_at TEXT); `decisions` table with seq/id/when_context/scope/decision/choice/rationale/revisable/superseded_by columns; `requirements` table with id/class/status/description/why/source/primary_owner/supporting_slices/validation/notes/full_content/superseded_by columns. Create `active_decisions` view (WHERE superseded_by IS NULL), `active_requirements` view (WHERE superseded_by IS NULL). Insert initial schema version row. Wrap all DDL in a transaction. Idempotent — use `CREATE TABLE IF NOT EXISTS`, `CREATE VIEW IF NOT EXISTS`.
6. Typed wrappers — `insertDecision(d: Omit<Decision, 'seq'>)`, `insertRequirement(r: Requirement)`, `getDecisionById(id: string): Decision | null`, `getRequirementById(id: string): Requirement | null`, `transaction<T>(fn: () => T): T`. All wrappers use prepared statements with named parameters.
7. Abstraction layer — thin wrapper over provider-specific APIs. Both `node:sqlite` `DatabaseSync` and `better-sqlite3` have `prepare().run/get/all`, so the adapter is minimal. Handle `node:sqlite`'s null-prototype row objects by spreading into plain objects.
8. Write `gsd-db.test.ts` — tests: fresh DB schema init, double-init idempotency, insert + get decision, insert + get requirement, active_decisions view excludes superseded, active_requirements view excludes superseded, WAL mode confirmed on temp file, provider detection returns non-null string, transaction rollback on error.

## Must-Haves

- [ ] `node:sqlite` → `better-sqlite3` → null provider chain with lazy loading
- [ ] ExperimentalWarning suppressed for `node:sqlite`
- [ ] WAL mode enabled on file-backed databases
- [ ] `schema_version`, `decisions`, `requirements` tables with correct column types
- [ ] `active_decisions` and `active_requirements` views
- [ ] Typed insert/query wrappers with prepared statements
- [ ] `isDbAvailable()`, `getDbProvider()`, `openDatabase()`, `closeDatabase()`
- [ ] All gsd-db tests pass

## Verification

- `npm run test:unit -- --test-name-pattern "gsd-db"` passes
- Schema creates cleanly on fresh temp DB
- WAL mode verified on file-backed DB (PRAGMA returns 'wal')
- Superseded rows excluded from view queries

## Inputs

- `src/resources/extensions/gsd/native-parser-bridge.ts` — pattern for lazy native module loading with graceful fallback
- `src/resources/extensions/gsd/types.ts` — existing type definitions to extend
- `src/resources/extensions/gsd/tests/test-helpers.ts` — test assertion helpers

## Expected Output

- `src/resources/extensions/gsd/gsd-db.ts` — complete DB abstraction module with provider chain, schema init, typed wrappers
- `src/resources/extensions/gsd/types.ts` — updated with `Decision` and `Requirement` types
- `src/resources/extensions/gsd/tests/gsd-db.test.ts` — comprehensive test file

## Observability Impact

- **`getDbProvider()`** returns `'node:sqlite' | 'better-sqlite3' | null` — reveals which SQLite backend loaded.
- **`isDbAvailable()`** returns boolean — quick check if DB is open and usable.
- **Provider load failure** writes to stderr on first attempt ("No SQLite provider available").
- **`schema_version` table** queryable directly for schema migration state.
- **Query wrappers** return typed empty results (null / []) when DB unavailable — never throw. Insert wrappers throw on no-DB for explicit failure.
- **`_getAdapter()`** exposes raw adapter for direct inspection in tests/debugging.
