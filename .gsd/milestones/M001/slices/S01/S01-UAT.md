# S01: DB Foundation + Decisions + Requirements — UAT

**Milestone:** M001
**Written:** 2026-03-15

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: S01 is a foundation layer with no runtime hookup — all behavior is exercised through unit tests and direct module imports. No UI, no server, no user-facing surfaces to test interactively.

## Preconditions

- Working directory is the gsd-2 project root (or memory-db worktree)
- Node 22+ installed (required for `node:sqlite` provider)
- Dependencies installed (`npm install` completed)

## Smoke Test

Run `npm run test:unit -- --test-name-pattern "gsd-db"` — all 41 assertions pass with 0 failures. This confirms the DB opens, schema creates, and typed wrappers work.

## Test Cases

### 1. Schema initialization on fresh database

1. Run `npm run test:unit -- --test-name-pattern "creates schema"` 
2. **Expected:** Test passes — `schema_version`, `decisions`, and `requirements` tables all exist. `active_decisions` and `active_requirements` views exist. Schema version row inserted with version 1.

### 2. Decision CRUD and view filtering

1. Run `npm run test:unit -- --test-name-pattern "inserts and retrieves a decision"`
2. Run `npm run test:unit -- --test-name-pattern "active_decisions view excludes superseded"`
3. **Expected:** Both pass. Decisions insert with all fields, retrieve by ID correctly. Superseded decisions (with `superseded_by` set) are excluded from `getActiveDecisions()` results.

### 3. Requirement CRUD and view filtering

1. Run `npm run test:unit -- --test-name-pattern "inserts and retrieves a requirement"`
2. Run `npm run test:unit -- --test-name-pattern "active_requirements view excludes superseded"`
3. **Expected:** Both pass. Requirements insert with all fields, retrieve by ID correctly. Superseded requirements excluded from active results.

### 4. WAL mode on file-backed database

1. Run `npm run test:unit -- --test-name-pattern "enables WAL mode"`
2. **Expected:** Test passes — `PRAGMA journal_mode` returns `'wal'` on a file-backed (non-:memory:) database.

### 5. Query functions with filters

1. Run `npm run test:unit -- --test-name-pattern "queryDecisions"` 
2. Run `npm run test:unit -- --test-name-pattern "queryRequirements"`
3. **Expected:** All pass. `queryDecisions` filters by milestoneId (LIKE match on when_context) and scope (exact match). `queryRequirements` filters by sliceId (LIKE on primary_owner OR supporting_slices) and status (exact match). Superseded rows excluded from all queries.

### 6. Format functions produce prompt-injectable text

1. Run `npm run test:unit -- --test-name-pattern "formatDecisionsForPrompt"`
2. Run `npm run test:unit -- --test-name-pattern "formatRequirementsForPrompt"`
3. **Expected:** All pass. Decision formatter produces markdown table with header row, separator, and data rows. Requirement formatter produces H3 sections with structured bullet fields. Empty input produces empty string.

### 7. Graceful fallback when DB unavailable

1. Run `npm run test:unit -- --test-name-pattern "fallback"` 
2. **Expected:** Passes. When DB is not opened (or closed), `queryDecisions()` and `queryRequirements()` return `[]`. `formatDecisionsForPrompt([])` and `formatRequirementsForPrompt([])` return `''`. No exceptions thrown.

### 8. Sub-5ms query performance

1. Run `npm run test:unit -- --test-name-pattern "sub-5ms"`
2. **Expected:** Passes. 50 decisions + 50 requirements inserted, queried, and returned in under 5ms total.

### 9. Transaction rollback

1. Run `npm run test:unit -- --test-name-pattern "transaction"`
2. **Expected:** Passes. Insert inside a transaction that throws is rolled back — row not visible after rollback.

### 10. DB sidecar gitignore patterns

1. Run `npm run test:unit -- --test-name-pattern "gitignore.*db"` or inspect `src/resources/extensions/gsd/gitignore.ts` lines 21-23.
2. **Expected:** `BASELINE_PATTERNS` array includes `.gsd/gsd.db`, `.gsd/gsd.db-wal`, `.gsd/gsd.db-shm`.

## Edge Cases

### Double schema init (idempotency)

1. Run `npm run test:unit -- --test-name-pattern "idempotent"`
2. **Expected:** Calling `openDatabase()` on an already-initialized DB does not fail or duplicate schema objects. `CREATE TABLE IF NOT EXISTS` and `CREATE VIEW IF NOT EXISTS` handle this.

### Provider detection

1. On Node 22+: `getDbProvider()` returns `'node:sqlite'`
2. On Node <22.5 with better-sqlite3 installed: `getDbProvider()` returns `'better-sqlite3'`
3. With neither available: `getDbProvider()` returns `null`, `isDbAvailable()` returns `false`, all queries return `[]`

### Close then query

1. Open DB, close it, then call `queryDecisions()`
2. **Expected:** Returns `[]` with no error (not an exception)

## Failure Signals

- Any test assertion failure in gsd-db or context-store test suites
- `getDbProvider()` returning `null` on a Node 22+ system (would indicate provider loading broken)
- `openDatabase()` throwing instead of returning gracefully
- Query functions throwing exceptions instead of returning `[]` when DB unavailable
- WAL mode not returning `'wal'` on file-backed DB
- Format functions producing empty output for non-empty input arrays
- Gitignore missing the DB sidecar patterns (would cause gsd.db to be committed to git)

## Requirements Proved By This UAT

- R001 — SQLite DB layer with schema versioning: schema_version table, decisions/requirements tables, typed wrappers all verified
- R002 — Graceful fallback: fallback test case proves no crash when DB unavailable (S01 scope: query layer fallback; S03 will complete prompt builder fallback)
- R005 — Selective context queries for decisions: queryDecisions with milestone/scope filters verified
- R006 — Selective context queries for requirements: queryRequirements with slice/status filters verified
- R017 — Sub-5ms query latency: timing assertion proves 0.62ms on 100 rows
- R020 — WAL mode enabled: PRAGMA verification test
- R021 — Schema designed for future vector search: PK structure verified (auto-increment seq for decisions, stable id for requirements)

## Not Proven By This UAT

- R001 forward-only migrations (only version 1 exists — migration path tested when schema evolves in later slices)
- R002 full fallback (query layer returns empty, but prompt builders not yet wired — S03 completes this)
- Runtime integration with dispatch pipeline (S03)
- Import from existing markdown (S02)
- Token savings measurement (S04)

## Notes for Tester

- All verification is automated via `npm run test:unit`. No manual steps required beyond running the test commands.
- The test suite uses both `:memory:` and file-backed temp DBs — no cleanup needed.
- On this system, `node:sqlite` is the active provider. The `better-sqlite3` fallback path is structurally identical but only exercised on systems without `node:sqlite`.
- If running on Node <22.5.0, install `better-sqlite3` first: `npm install better-sqlite3`.
