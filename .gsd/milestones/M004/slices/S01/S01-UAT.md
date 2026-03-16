# S01: DB Foundation + Schema — UAT

**Milestone:** M004
**Written:** 2026-03-15

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: S01 is a standalone DB foundation — no auto-mode wiring, no UI, no user-facing behavior. All contracts are exercised by unit tests against real SQLite. No runtime or human-experience verification needed.

## Preconditions

- Working directory is the M004 worktree: `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/M004`
- Node 22+ installed (for `node:sqlite` provider)
- `npm install` completed (for `better-sqlite3` fallback and dev dependencies)

## Smoke Test

Run the DB test suite and confirm all 133 assertions pass:
```bash
cd /Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/M004
node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/gsd-db.test.ts \
  src/resources/extensions/gsd/tests/context-store.test.ts \
  src/resources/extensions/gsd/tests/worktree-db.test.ts
```
**Expected:** 3/3 test files pass, 133 total assertions (41 + 56 + 36), zero failures.

## Test Cases

### 1. Tiered Provider Chain Detection

1. Run `gsd-db.test.ts` with `--experimental-sqlite`
2. Check that `getDbProvider()` returns `'node:sqlite'` (or `'better-sqlite3'` if node:sqlite unavailable)
3. **Expected:** Provider detected and reported correctly. `isDbAvailable()` returns `true` after `openDatabase()`.

### 2. Schema Initialization

1. Open a fresh in-memory database via `openDatabase(':memory:')`
2. Query `sqlite_master` for tables
3. **Expected:** Tables `decisions`, `requirements`, `artifacts`, `metadata` exist. Views `active_decisions`, `active_requirements` exist. `metadata` contains `schema_version` row.

### 3. Decision CRUD Operations

1. Insert a decision with `insertDecision({id: 'D001', milestone: 'M001', scope: 'arch', title: 'Test', rationale: 'Because', status: 'accepted', reversible: 'Yes'})`
2. Query with `getDecisionById('D001')`
3. Upsert with modified rationale via `upsertDecision()`
4. Query again
5. **Expected:** Insert succeeds, query returns correct fields, upsert updates rationale without error, second query returns modified value.

### 4. Requirement CRUD Operations

1. Insert a requirement with `insertRequirement({id: 'R001', class: 'core-capability', status: 'active', ...})`
2. Query with `getRequirementById('R001')`
3. Upsert with status change to 'validated'
4. **Expected:** Insert succeeds, query returns correct fields, upsert changes status.

### 5. Artifact CRUD Operations

1. Insert an artifact with `insertArtifact({path: 'ROADMAP.md', content: '# Roadmap', artifact_type: 'roadmap'})`
2. Query with `queryArtifact('ROADMAP.md')`
3. **Expected:** Returns the content string `'# Roadmap'`.

### 6. Filtered Views

1. Insert decisions with different statuses ('accepted', 'superseded')
2. Query `active_decisions` view
3. **Expected:** Only 'accepted' decisions returned. 'superseded' excluded.

### 7. Query Layer Filtering

1. Insert multiple decisions across milestones M001, M002
2. Call `queryDecisions({milestone: 'M001'})`
3. **Expected:** Returns only M001 decisions. M002 decisions excluded.

### 8. Requirements Filtering by Slice

1. Insert requirements with different `primary_owning_slice` values
2. Call `queryRequirements({slice: 'S01'})`
3. **Expected:** Returns only requirements owned by S01.

### 9. Prompt Formatters

1. Create an array of Decision objects
2. Call `formatDecisionsForPrompt(decisions)`
3. **Expected:** Returns a markdown-formatted pipe table string with headers and decision rows.

### 10. Transaction Support

1. Start a transaction with `transaction(() => { ... })`
2. Inside: insert 3 decisions
3. **Expected:** All 3 inserted atomically. If one fails, none committed.

### 11. Graceful Fallback

1. Close database with `closeDatabase()`
2. Call `queryDecisions()`, `queryRequirements()`, `queryArtifact('test')`, `queryProject()`
3. **Expected:** Returns `[]`, `[]`, `null`, `null` respectively. No throw, no crash.

### 12. WAL Mode

1. Open a file-backed database (not `:memory:`)
2. Query `PRAGMA journal_mode`
3. **Expected:** Returns `'wal'`.

### 13. Worktree DB Copy

1. Create a source DB with data
2. Call `copyWorktreeDb(srcPath, destPath)`
3. Open destination DB and query
4. **Expected:** Destination has all source data. WAL/SHM files not copied.

### 14. Worktree DB Reconcile

1. Create main DB and worktree DB with overlapping + unique rows
2. Call `reconcileWorktreeDb(mainPath, worktreePath)`
3. Query main DB
4. **Expected:** Main DB has all worktree-unique rows merged in. Conflicts detected for rows modified in both. Reconciliation counts logged to stderr.

## Edge Cases

### Empty Database Queries

1. Open a fresh database (no rows inserted)
2. Call `queryDecisions()`, `queryRequirements()`
3. **Expected:** Returns empty arrays `[]`, not errors.

### Multiple Provider Fallback

1. If `node:sqlite` unavailable (no `--experimental-sqlite` flag), provider chain falls through to `better-sqlite3`
2. **Expected:** `getDbProvider()` returns `'better-sqlite3'`. All operations work identically.

### Null Provider (Both Unavailable)

1. If both providers unavailable, `getDbProvider()` returns `null`
2. All CRUD operations return empty/null
3. **Expected:** No crash, no error thrown. Provider failure message logged to stderr.

### Copy Non-Existent DB

1. Call `copyWorktreeDb` with a source path that doesn't exist
2. **Expected:** Returns `false`. Error logged to stderr. No throw.

### Reconcile with Conflicts

1. Modify the same decision (same ID) differently in main and worktree DBs
2. Reconcile
3. **Expected:** Worktree version wins (INSERT OR REPLACE). Conflict logged to stderr with decision ID.

## Failure Signals

- Any test assertion failure in the 133-assertion suite
- `getDbProvider()` returning `null` when SQLite should be available
- `npx tsc --noEmit` producing type errors in gsd-db.ts or context-store.ts
- Existing test suite (`npm run test:unit`) showing regressions (expected: 361/361 pass)
- stderr showing "No SQLite provider available" when `--experimental-sqlite` is set

## Requirements Proved By This UAT

- R045 — SQLite DB layer with tiered provider chain: full proof via 133 assertions covering provider detection, schema, CRUD, views, WAL, transactions, query filtering, formatters, and worktree operations
- R046 (partial) — DB layer graceful degradation: query functions return empty when unavailable. Prompt builder fallback not yet wired (S03).
- R053 (partial) — copyWorktreeDb function implemented and tested. Wiring into createWorktree deferred to S05.
- R054 (partial) — reconcileWorktreeDb function implemented and tested. Wiring into merge paths deferred to S05.

## Not Proven By This UAT

- R046 prompt builder fallback path (S03 scope)
- R053/R054 wiring into actual worktree lifecycle (S05 scope)
- Auto-migration from markdown (S02 scope)
- Surgical prompt injection in prompt builders (S03 scope)
- Any auto-mode integration (S03+ scope)

## Notes for Tester

- Tests create temporary files in OS temp directory and clean up after themselves
- The `--experimental-sqlite` flag is required. Without it, `node:sqlite` tests will be skipped and provider falls through to `better-sqlite3`
- Performance test in context-store.test.ts expects 100-row query in <50ms — should pass easily on any modern machine
- All tests are deterministic — no network, no external dependencies, no timing sensitivity
